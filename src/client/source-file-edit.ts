/** Native source edit state for an action attached to the official document preview. */
import type { WorkspaceDocument } from '../workspace/service-types.ts'
import { discardSourceDocumentDraft, sourceDocumentDraft, sourceDocumentDraftKey, rememberSourceDocumentDraft, type SourceDocumentDraft, type SourceTextSelection } from './workbench-drafts.ts'
import { nativeDocumentJournal, type NativeDocumentJournal } from './native-document-journal.ts'
import { sourceFileAccess, type SourceFileContext } from './source-workspace-provider.ts'
import { randomId } from './random-id.ts'

export interface SourceEditState {
  readonly base: WorkspaceDocument | undefined
  readonly text: string
  readonly selection: SourceTextSelection
  readonly current: WorkspaceDocument | undefined
  readonly pending: SourceDocumentDraft['pending']
  readonly busy: 'load' | 'save' | 'inspect' | null
  readonly uncertain: boolean
  readonly error: string | null
  readonly saved: boolean
  /** undefined means not inspected; null is an explicitly discarded saved copy. */
  readonly browserDraft: SourceDocumentDraft | null | undefined
}
const describe = (error: unknown): string => error instanceof Error ? error.message
  : error && typeof error === 'object' && typeof Reflect.get(error, 'message') === 'string' ? String(Reflect.get(error, 'message'))
    : 'The source operation did not complete.'

/**
 * One exact source file and its opaque read baseline. A failed or unknown save
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
  private pendingWrites = 0
  private persistenceError: Error | null = null
  private inspectedBrowserRevision: string | null = null
  private readonly lifetime = new AbortController()
  constructor(readonly context: SourceFileContext, readonly path: string, private readonly journal: NativeDocumentJournal = nativeDocumentJournal) {
    this.context = { ...context, owner: structuredClone(context.owner) }
    this.document = { kind: 'file' as const, path }
    const draft = sourceDocumentDraft(context.owner, this.document)
    this.state = { base: draft?.base, text: draft?.text ?? '', selection: draft?.selection ?? { start: 0, end: 0, direction: 'none' }, current: undefined, busy: null,
      uncertain: draft?.uncertain ?? false, pending: draft?.pending ?? null, error: null, saved: false, browserDraft: undefined }
  }
  getSnapshot = (): SourceEditState => this.state
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  get dirty(): boolean { return typeof this.state.base?.text === 'string' && (this.state.text !== this.state.base.text || this.state.uncertain) }
  get writable(): boolean { return !!this.context.services.mutations && this.state.base?.writable === true && typeof this.state.base.text === 'string' && typeof this.state.base.version === 'string' }
  get retained(): boolean { return this.initialized && this.pendingWrites === 0 && this.persistenceError === null }
  private get access() { return sourceFileAccess(this.context.owner, this.lifetime.signal) }
  edit(text: string, selection = this.state.selection): void { this.revision++; this.update({ text, selection, saved: false }) }
  select(selection: SourceTextSelection): void {
    if (selection.start !== this.state.selection.start || selection.end !== this.state.selection.end || selection.direction !== this.state.selection.direction) this.update({ selection })
  }

  async load(): Promise<void> {
    if (this.state.busy) return
    this.update({ busy: 'load', error: null })
    const revision = this.revision
    try {
      if (!this.initialized) {
        const saved = await this.journal.read(sourceDocumentDraftKey(this.context.owner, this.document))
        if (saved?.draft && this.state.base && (saved.draft.text !== this.state.text || saved.draft.base.version !== this.state.base.version || saved.draft.uncertain !== this.state.uncertain)) {
          this.inspectedBrowserRevision = saved.revision; this.update({ browserDraft: saved.draft })
          throw new Error('A different saved browser draft exists for this source file. Compare the saved copy with the open editor before choosing which to keep.')
        }
        this.journalRevision = saved?.revision ?? null; this.journalHasDraft = Boolean(saved?.draft); this.initialized = true
        if (saved?.draft && !this.state.base && this.revision === revision) this.update({ ...saved.draft,
          selection: saved.draft.selection ?? this.state.selection, current: undefined, saved: false })
      }
      const value = await this.context.services.documents.open(this.document, this.access)
      this.lifetime.signal.throwIfAborted()
      if (this.dirty || this.revision !== revision) {
        if (value.version !== this.state.base?.version) this.update({ current: value, uncertain: true })
      } else this.update({ base: value, text: value.text ?? '', current: undefined, uncertain: false })
    } catch (error) { this.update({ error: describe(error) }) }
    finally { this.update({ busy: null }) }
  }

  async save(): Promise<void> {
    const { base, text, busy, uncertain } = this.state
    if (!this.writable || !base?.version || busy || uncertain || !this.dirty) return
    const pending = { operationId: randomId(), text, baselineVersion: base.version }
    this.update({ busy: 'save', error: null, saved: false, uncertain: true, pending })
    let dispatched = false
    try {
      // A reload after a committed write but before its ACK must not lose
      // the original operation identity/baseline or silently retry the write.
      await this.checkpoint(); dispatched = true
      const result = await this.context.services.mutations!.save({ target: this.context.owner.binding.target, operationId: pending.operationId,
        path: this.path, text, baseline: { kind: 'version', version: base.version }, ...(base.format === undefined ? {} : { format: base.format }) }, this.access)
      if (result.status !== 'applied') {
        this.update({ uncertain: true, error: result.status === 'rejected' ? result.message : result.status === 'conflict'
          ? 'The source changed. Inspect its current version before saving again.' : 'The source did not confirm this operation. Read its original receipt before continuing.' })
        return
      }
      this.lifetime.signal.throwIfAborted()
      this.update({ base: { ...base, text, version: result.value.version, bytes: result.value.bytes ?? base.bytes },
        current: undefined, uncertain: false, pending: null, saved: this.state.text === text })
    } catch (error) { this.update({ uncertain: dispatched, ...(dispatched ? {} : { pending: null }), error: describe(error) }) }
    finally { this.update({ busy: null }); await this.checkpoint().catch(() => {}) }
  }

  /** Reads only. It cannot repeat a save whose acknowledgement was lost. */
  async inspect(): Promise<void> {
    if (this.state.busy) return
    this.update({ busy: 'inspect', error: null })
    try {
      const pending = this.state.pending
      if (pending && this.context.services.mutations) {
        const receipt = await this.context.services.mutations.receipt(pending.operationId, this.access)
        this.lifetime.signal.throwIfAborted()
        if (receipt?.status === 'applied' && receipt.value && this.state.base) {
          this.update({ base: { ...this.state.base, text: pending.text, version: receipt.value.version, bytes: receipt.value.bytes ?? this.state.base.bytes },
            pending: null, uncertain: false, saved: this.state.text === pending.text })
        }
      }
      const current = await this.context.services.documents.open(this.document, this.access)
      this.lifetime.signal.throwIfAborted()
      this.update({ current, ...(current.version !== this.state.base?.version ? { uncertain: true } : {}) })
    }
    catch (error) { this.update({ error: describe(error) }) }
    finally { this.update({ busy: null }) }
  }

  /** Reads another browser editor's copy without changing the current text or source file. */
  async inspectBrowserDraft(): Promise<void> {
    if (this.state.busy) return
    this.update({ busy: 'inspect' })
    try {
      await this.durableWrite
      const entry = await this.journal.read(sourceDocumentDraftKey(this.context.owner, this.document))
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
    this.update({ ...(useSaved && draft ? { ...draft, selection: draft.selection ?? this.state.selection, current: undefined, saved: false } : {}), browserDraft: undefined, error: null })
    if (before.base === this.state.base && before.text === this.state.text && before.uncertain === this.state.uncertain) this.persist()
    await this.checkpoint().catch(() => {})
  }

  /** Caller must explicitly review and accept the observed source as a new CAS baseline. */
  acceptCurrent(keepDraft: boolean): void {
    const current = this.state.current
    if (!current || this.state.busy) return
    this.revision++
    this.update({ base: current, text: keepDraft ? this.state.text : current.text ?? '', current: undefined,
      uncertain: false, pending: null, error: null, saved: false })
  }

  discard(): void {
    if (this.state.busy || !this.state.base) return
    this.revision++
    this.update({ text: this.state.base.text ?? '', current: undefined, uncertain: false, pending: null, error: null, saved: false })
    discardSourceDocumentDraft(this.context.owner, this.document)
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
    const selection = this.state.selection, length = this.state.text.length
    if (selection.start > length || selection.end > length) this.state = { ...this.state,
      selection: { ...selection, start: Math.min(selection.start, length), end: Math.min(selection.end, length) } }
    if (this.state.base) rememberSourceDocumentDraft(this.context.owner, this.document,
      { base: this.state.base, text: this.state.text, uncertain: this.state.uncertain, pending: this.state.pending, selection: this.state.selection })
    if (previous.base !== this.state.base || previous.text !== this.state.text || previous.uncertain !== this.state.uncertain || previous.pending !== this.state.pending || previous.selection !== this.state.selection) this.persist()
    for (const listener of this.listeners) listener()
  }

  private persist(): void {
    if (this.initialized && this.state.base) {
      const draft = this.dirty || this.state.pending ? { base: this.state.base, text: this.state.text, uncertain: this.state.uncertain, pending: this.state.pending, selection: this.state.selection } : null
      if (draft === null && !this.journalHasDraft) return
      this.journalHasDraft = draft !== null
      this.pendingWrites++
      this.durableWrite = this.durableWrite.then(async () => {
        try {
          const saved = await this.journal.write(sourceDocumentDraftKey(this.context.owner, this.document), this.journalRevision, draft)
          this.journalRevision = saved.revision; this.persistenceError = null
        } catch (error) {
          this.persistenceError = error instanceof Error ? error : new Error(describe(error))
          this.state = { ...this.state, error: `The file draft could not be saved in this browser. ${this.persistenceError.message}` }
          for (const listener of this.listeners) listener()
        } finally { this.pendingWrites--; for (const listener of this.listeners) listener() }
      })
    }
  }
  dispose(): void { this.lifetime.abort(); this.listeners.clear() }
}
