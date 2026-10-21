/** Native source edit state for an action attached to the official document preview. */
import { remoteValue } from '../client-api.ts'
import type { NativeWorkbenchApi, WorkbenchResponse, WorkbenchSource } from '../workbench-types.ts'
import { discardNativeDocumentDraft, nativeDocumentDraft, nativeDocumentDraftKey, rememberNativeDocumentDraft, type NativeDocumentDraft } from './workbench-drafts.ts'
import { nativeDocumentJournal, type NativeDocumentJournal } from './native-document-journal.ts'

export interface SourceEditState {
  readonly base: WorkbenchResponse<'nativeDocument'> | undefined
  readonly text: string
  readonly current: WorkbenchResponse<'nativeDocument'> | undefined
  readonly busy: 'load' | 'save' | 'inspect' | null
  readonly uncertain: boolean
  readonly error: string | null
  readonly saved: boolean
  /** undefined means not inspected; null is an explicitly discarded saved copy. */
  readonly browserDraft: NativeDocumentDraft | null | undefined
}
const describe = (error: unknown): string => error instanceof Error ? error.message
  : error && typeof error === 'object' && typeof Reflect.get(error, 'message') === 'string' ? String(Reflect.get(error, 'message'))
    : 'The source operation did not complete.'

/**
 * One source file, one compare-and-swap baseline. A failed or unknown save
 * never submits again without a new explicit action and a reviewed source
 * revision. Edits typed while a save is in flight remain unsaved afterwards.
 */
export class SourceFileEdit {
  private state: SourceEditState
  private readonly listeners = new Set<() => void>()
  private revision = 0
  private readonly document
  private initialized = false
  private journalRevision: string | null = null
  private journalHasDraft = false
  private durableWrite: Promise<void> = Promise.resolve()
  private persistenceError: Error | null = null
  private inspectedBrowserRevision: string | null = null
  constructor(private readonly api: Pick<NativeWorkbenchApi, 'nativeDocument' | 'nativeFileSave'>,
    readonly source: WorkbenchSource, readonly path: string, private readonly journal: NativeDocumentJournal = nativeDocumentJournal) {
    this.document = { kind: 'file' as const, path, ...(source.machineId === undefined ? {} : { machineId: source.machineId }) }
    const draft = nativeDocumentDraft(source, this.document)
    this.state = { base: draft?.base, text: draft?.text ?? '', current: undefined, busy: null,
      uncertain: draft?.uncertain ?? false, error: null, saved: false, browserDraft: undefined }
  }
  getSnapshot = (): SourceEditState => this.state
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  get dirty(): boolean { return typeof this.state.base?.text === 'string' && (this.state.text !== this.state.base.text || this.state.uncertain) }
  get writable(): boolean { return this.state.base?.writable === true && typeof this.state.base.text === 'string' && typeof this.state.base.hash === 'string' }
  edit(text: string): void { this.revision++; this.update({ text, saved: false }) }

  async load(): Promise<void> {
    if (this.state.busy) return
    this.update({ busy: 'load', error: null })
    const revision = this.revision
    try {
      if (!this.initialized) {
        const saved = await this.journal.read(nativeDocumentDraftKey(this.source, this.document))
        if (saved?.draft && this.state.base && (saved.draft.text !== this.state.text || saved.draft.base.hash !== this.state.base.hash || saved.draft.uncertain !== this.state.uncertain)) {
          this.inspectedBrowserRevision = saved.revision; this.update({ browserDraft: saved.draft })
          throw new Error('A different saved browser draft exists for this source file. Compare the saved copy with the open editor before choosing which to keep.')
        }
        this.journalRevision = saved?.revision ?? null; this.journalHasDraft = Boolean(saved?.draft); this.initialized = true
        if (saved?.draft && !this.state.base && this.revision === revision) this.update({ ...saved.draft, current: undefined, saved: false })
      }
      const value = remoteValue(await this.api.nativeDocument({ source: this.source, document: this.document }))
      if (this.dirty || this.revision !== revision) {
        if (value.hash !== this.state.base?.hash) this.update({ current: value, uncertain: true })
      } else this.update({ base: value, text: value.text ?? '', current: undefined, uncertain: false })
    } catch (error) { this.update({ error: describe(error) }) }
    finally { this.update({ busy: null }) }
  }

  async save(): Promise<void> {
    const { base, text, busy, uncertain } = this.state
    if (!this.writable || !base?.hash || busy || uncertain || !this.dirty) return
    this.update({ busy: 'save', error: null, saved: false, uncertain: true })
    let dispatched = false
    try {
      // A reload after a committed write but before its ACK must not lose
      // the original CAS baseline or silently retry the write.
      await this.checkpoint(); dispatched = true
      const result = remoteValue(await this.api.nativeFileSave({ source: this.source, path: this.path, text,
        expectedHash: base.hash, ...(base.format === undefined ? {} : { format: base.format }) }))
      if (!result.success || !result.hash) {
        this.update({ uncertain: true, error: result.error ?? result.code ?? 'The source did not confirm the saved revision.' })
        return
      }
      this.update({ base: { ...base, text, hash: result.hash, ...(result.modified === undefined ? {} : { modified: result.modified }) },
        current: undefined, uncertain: false, saved: this.state.text === text })
    } catch (error) { this.update({ uncertain: dispatched, error: describe(error) }) }
    finally { this.update({ busy: null }); await this.checkpoint().catch(() => {}) }
  }

  /** Reads only. It cannot repeat a save whose acknowledgement was lost. */
  async inspect(): Promise<void> {
    if (this.state.busy) return
    this.update({ busy: 'inspect', error: null })
    try { this.update({ current: remoteValue(await this.api.nativeDocument({ source: this.source, document: this.document })) }) }
    catch (error) { this.update({ error: describe(error) }) }
    finally { this.update({ busy: null }) }
  }

  /** Reads another browser editor's copy without changing the current text or source file. */
  async inspectBrowserDraft(): Promise<void> {
    if (this.state.busy) return
    this.update({ busy: 'inspect' })
    try {
      await this.durableWrite
      const entry = await this.journal.read(nativeDocumentDraftKey(this.source, this.document))
      this.inspectedBrowserRevision = entry?.revision ?? null
      this.update({ browserDraft: entry?.draft ?? null })
    } catch (error) { this.update({ error: describe(error) }) }
    finally { this.update({ busy: null }) }
  }

  /** Explicit browser-local resolution, still protected by the inspected revision's CAS. */
  async resolveBrowserDraft(useSaved: boolean): Promise<void> {
    if (this.state.busy || this.state.browserDraft === undefined) return
    const draft = this.state.browserDraft
    if (useSaved && !draft) return
    const before = this.state
    this.journalRevision = this.inspectedBrowserRevision; this.journalHasDraft = Boolean(draft); this.initialized = true; this.persistenceError = null; this.revision++
    this.update({ ...(useSaved && draft ? { ...draft, current: undefined, saved: false } : {}), browserDraft: undefined, error: null })
    if (before.base === this.state.base && before.text === this.state.text && before.uncertain === this.state.uncertain) this.persist()
    await this.checkpoint().catch(() => {})
  }

  /** Caller must explicitly review and accept the observed source as a new CAS baseline. */
  acceptCurrent(keepDraft: boolean): void {
    const current = this.state.current
    if (!current || this.state.busy) return
    this.revision++
    this.update({ base: current, text: keepDraft ? this.state.text : current.text ?? '', current: undefined,
      uncertain: false, error: null, saved: false })
  }

  discard(): void {
    if (this.state.busy || !this.state.base) return
    this.revision++
    this.update({ text: this.state.base.text ?? '', current: undefined, uncertain: false, error: null, saved: false })
    discardNativeDocumentDraft(this.source, this.document)
  }

  /** A page update may proceed only after this editor's durable writes settle. */
  async checkpoint(): Promise<void> {
    for (;;) { const pending = this.durableWrite; await pending; if (pending === this.durableWrite) break }
    if (this.persistenceError) throw this.persistenceError
    if (!this.initialized) throw new Error('The source file draft is still loading.')
  }

  private update(patch: Partial<SourceEditState>): void {
    const previous = this.state
    this.state = { ...this.state, ...patch }
    if (this.state.base) rememberNativeDocumentDraft(this.source, this.document,
      { base: this.state.base, text: this.state.text, uncertain: this.state.uncertain })
    if (previous.base !== this.state.base || previous.text !== this.state.text || previous.uncertain !== this.state.uncertain) this.persist()
    for (const listener of this.listeners) listener()
  }

  private persist(): void {
    if (this.initialized && this.state.base) {
      const draft = this.dirty ? { base: this.state.base, text: this.state.text, uncertain: this.state.uncertain } : null
      if (draft === null && !this.journalHasDraft) return
      this.journalHasDraft = draft !== null
      this.durableWrite = this.durableWrite.then(async () => {
        try {
          const saved = await this.journal.write(nativeDocumentDraftKey(this.source, this.document), this.journalRevision, draft)
          this.journalRevision = saved.revision; this.persistenceError = null
        } catch (error) {
          this.persistenceError = error instanceof Error ? error : new Error(describe(error))
          this.state = { ...this.state, error: `The file draft could not be saved in this browser. ${this.persistenceError.message}` }
          for (const listener of this.listeners) listener()
        }
      })
    }
  }
}
