import { randomId } from './random-id.ts'
/** Source file mutations retain their original request until its result is reviewed. */
import { remoteValue } from '../client-api.ts'
import type { NativeWorkbenchApi, WorkbenchRequest, WorkbenchResponse, WorkbenchSource } from '../workbench-types.ts'
import { sourceFileMutationRequestSchema, sourceFileMutationResult, sourceFileOwnerSchema,
  type SourceFileMutationEntry, type SourceFileMutationJournal, type SourceFileMutationReceipt, type SourceFileMutationRequest, type SourceFileOwner } from './source-file-mutation-journal.ts'

type Operation = WorkbenchRequest<'nativeFileManage'>['operation']
type Request = SourceFileMutationRequest
type Api = Pick<NativeWorkbenchApi, 'nativeFileManage' | 'nativeFileUpload' | 'nativeFileInspect'>
export interface SourceFileMutationState {
  readonly loaded: boolean
  readonly operationId: string | null
  readonly phase: SourceFileMutationReceipt['phase'] | null
  readonly request: Request | null
  readonly busy: boolean
  readonly uncertain: boolean
  readonly result: WorkbenchResponse<'nativeFileManage'> | null
  readonly observed: ReadonlyArray<{ path: string; result: WorkbenchResponse<'nativeFileInspect'> }> | null
  readonly error: string | null
  readonly storageError: string | null
  readonly omittedPaths: number
  readonly canReview: boolean
}
const message = (error: unknown): string => error instanceof Error ? error.message
  : error && typeof error === 'object' && typeof Reflect.get(error, 'message') === 'string' ? String(Reflect.get(error, 'message'))
    : 'The source did not confirm this file operation.'

/** Paths are source paths; this only compares spelling and never opens a filesystem. */
export function sourceFileContains(parent: string, path: string): boolean {
  const canonical = (value: string): string => {
    const normalized = value.replaceAll('\\', '/').replace(/\/+$/, '')
    return /^(?:[A-Za-z]:\/|\/\/)/.test(normalized) ? normalized.toLowerCase() : normalized
  }
  const left = canonical(parent), right = canonical(path)
  return left === right || right.startsWith(`${left}/`)
}
export function validSourceFileName(value: string): boolean {
  return value.trim().length > 0 && value !== '.' && value !== '..'
    && !/[\\/\u0000-\u001f\u007f]/.test(value) && !/^[A-Za-z]:/.test(value)
}

/** One source has one active mutation, including a reply that may have been lost. */
export class SourceFileMutation {
  private state: SourceFileMutationState = { loaded: false, operationId: null, phase: null, request: null, busy: false, uncertain: false,
    result: null, observed: null, error: null, storageError: null, omittedPaths: 0, canReview: false }
  private readonly listeners = new Set<() => void>()
  private readonly owner: SourceFileOwner | undefined
  private entry: SourceFileMutationEntry | null = null
  private unsubscribe: (() => void) | undefined
  private loading: Promise<void> | undefined
  private localBusy = false
  private remoteBusy = false
  private actionError: string | null = null
  private readVersion = 0
  private refreshQueued = false
  private reviewRevision: string | null = null
  private disposed = false
  readonly source: WorkbenchSource
  constructor(private readonly api: Api, source: WorkbenchSource, private readonly journal: SourceFileMutationJournal) {
    this.source = Object.freeze(structuredClone(source))
    const owner = sourceFileOwnerSchema.safeParse(source)
    if (owner.success) {
      this.owner = owner.data
      try { this.unsubscribe = journal.subscribe(owner.data, () => { this.publish(); this.refreshQueued = true; void this.load(true) }) }
      catch (error) { this.state = { ...this.state, loaded: true, storageError: message(error), error: message(error) } }
    } else this.state = { ...this.state, loaded: true, storageError: 'The original Hub, session and machine must be known before a file operation can be retained or sent.',
      error: 'The original Hub, session and machine must be known before a file operation can be retained or sent.' }
  }
  getSnapshot = (): SourceFileMutationState => this.state
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  get blocked(): boolean { return this.disposed || !this.state.loaded || this.busy || this.state.uncertain || this.state.storageError !== null }
  private get busy(): boolean { return this.localBusy || this.remoteBusy || Boolean(this.owner && this.journal.active(this.owner)) }

  load = (preserveError = false): Promise<void> => {
    if (this.disposed || !this.owner) return Promise.resolve()
    if (this.loading) return this.loading
    this.refreshQueued = false
    const owner = this.owner, version = ++this.readVersion
    const promise = Promise.resolve().then(() => this.journal.read(owner)).then(async entry => {
      if (this.disposed || version !== this.readVersion) return
      this.entry = entry
      const held = await this.journal.held(owner)
      if (this.disposed || version !== this.readVersion) return
      this.remoteBusy = held; this.publish({ loaded: true, storageError: preserveError ? this.state.storageError : null })
    }).catch(error => {
      if (this.disposed || version !== this.readVersion) return
      this.publish({ loaded: true, storageError: `Saved file operations could not be read: ${message(error)}` })
    }).finally(() => { if (this.loading === promise) { this.loading = undefined; if (this.refreshQueued) void this.load(true) } })
    this.loading = promise; return promise
  }

  async manage(operation: Operation): Promise<boolean> {
    const fixed = Object.freeze(structuredClone(operation))
    return this.submit(fixed, () => this.api.nativeFileManage({ source: this.source, operation: fixed }))
  }
  async upload(path: string, content: string): Promise<boolean> {
    // Retain identity and result, never another 64 MiB copy of uploaded bytes.
    return this.submit({ action: 'upload', path }, () => this.api.nativeFileUpload({ source: this.source, path, content }))
  }
  private async submit(request: Request, send: () => ReturnType<Api['nativeFileManage']>): Promise<boolean> {
    if (this.disposed || this.busy) return false
    await this.load()
    if (this.blocked || !this.owner) return false
    const owner = this.owner, expectedRevision = this.entry?.revision ?? null
    let receipt: SourceFileMutationReceipt
    try {
      const now = Date.now()
      receipt = { operationId: randomId(), request: sourceFileMutationRequestSchema.parse(request), phase: 'pending',
        createdAt: now, updatedAt: now, result: null, observed: null, omittedPaths: 0, error: null }
    } catch (error) { this.publish({ error: message(error) }); return false }
    this.localBusy = true; this.reviewRevision = null; this.publish({ error: null })
    let acquired = false
    try {
      // The source RPC has no operation-ID query or idempotency guarantee.
      // Await the strict transaction before any network mutation is admitted.
      const flight = await this.journal.exclusive(owner, receipt.operationId, async () => {
        acquired = true
        if (this.disposed) return false
        // Lock acquisition is asynchronous. A different window may have
        // admitted an unknown operation since our initial UI/read check.
        const current = await this.journal.read(owner)
        if (current?.receipt.phase === 'pending' || current?.receipt.phase === 'unknown'
          || (current?.revision ?? null) !== expectedRevision) {
          if (current) this.adopt(current)
          return false
        }
        if (this.disposed) return false
        const admitted = await this.journal.write(owner, current?.revision ?? null, receipt)
        this.adopt(admitted)
        // A graph can disappear while IndexedDB commits. Retain the intent,
        // but do not start using its obsolete API after disposal.
        if (this.disposed) return false
        let result: WorkbenchResponse<'nativeFileManage'> | null = null, failure: string | null = null
        try { result = remoteValue(await send()) }
        catch (error) { failure = message(error) }
        const latest = await this.journal.read(owner)
        if (latest?.receipt.operationId !== receipt.operationId) { if (latest) this.adopt(latest); return false }
        const evidence = result ? sourceFileMutationResult(result) : { result: null, omittedPaths: 0 }
        const updated: SourceFileMutationReceipt = { ...latest.receipt, ...evidence,
          phase: latest.receipt.phase === 'reviewed' ? 'reviewed' : result?.success ? 'confirmed' : 'unknown', updatedAt: Date.now(),
          error: (failure ?? (result?.success ? null : result?.error ?? result?.code ?? 'The source did not confirm this file operation.'))?.slice(0, 8192) ?? null }
        this.adopt(await this.journal.write(owner, latest.revision, updated))
        return result?.success === true && !this.disposed
      })
      if (!flight.acquired) { this.remoteBusy = true; this.publish({ error: 'Another view or window is still using this source file operation. No new operation was sent.' }); return false }
      return flight.value
    } catch (error) {
      // A durable pending record survives failed result persistence. Never
      // treat that storage failure as permission to repeat the request.
      this.publish({ storageError: `The file-operation receipt could not be retained: ${message(error)}. No operation will be repeated automatically.` })
      return false
    } finally { this.localBusy = false; if (acquired) this.remoteBusy = false; this.publish(); void this.load(true) }
  }

  /** Read original and destination paths only; never submit the mutation again. */
  async inspect(): Promise<void> {
    if (this.disposed || this.busy || !this.owner) return
    await this.load()
    if (this.busy || !this.entry) return
    const owner = this.owner, current = this.entry, request = current.receipt.request
    this.localBusy = true; this.reviewRevision = null; this.publish({ observed: null, error: null })
    let acquired = false
    try {
      const flight = await this.journal.exclusive(owner, current.receipt.operationId, async () => {
        acquired = true
        if (this.disposed) return
        const paths = 'destination' in request ? [request.path, request.destination] : [request.path]
        const observed = await Promise.all([...new Set(paths)].map(async path => ({ path,
          result: remoteValue(await this.api.nativeFileInspect({ source: this.source, path })),
        })))
        const fresh = await this.journal.read(owner)
        if (fresh?.receipt.operationId !== current.receipt.operationId) { if (fresh) this.adopt(fresh); return }
        const saved = await this.journal.write(owner, fresh.revision, { ...fresh.receipt, updatedAt: Date.now(),
          observed: observed.map(row => ({ path: row.path, result: sourceFileMutationResult(row.result).result! })) })
        this.adopt(saved); this.reviewRevision = saved.revision
      })
      if (!flight.acquired) { this.remoteBusy = true; this.publish({ error: 'Another view or window is still using this source. Wait before inspecting or reviewing it.' }) }
    } catch (error) { this.publish({ error: message(error), canReview: false }) }
    finally { this.localBusy = false; if (acquired) this.remoteBusy = false; this.publish(); void this.load(true) }
  }

  /** Local acknowledgement only. Path observations do not prove a past RPC completed. */
  async review(): Promise<boolean> {
    if (this.disposed || this.busy || !this.owner || !this.state.canReview || !this.entry) return false
    const owner = this.owner, expected = this.entry
    this.localBusy = true; this.publish()
    let acquired = false
    try {
      const flight = await this.journal.exclusive(owner, expected.receipt.operationId, async () => {
        acquired = true
        if (this.disposed) return false
        const current = await this.journal.read(owner)
        if (current?.revision !== this.reviewRevision || current.receipt.operationId !== expected.receipt.operationId) { if (current) this.adopt(current); return false }
        this.adopt(await this.journal.write(owner, current.revision, { ...current.receipt, phase: 'reviewed', updatedAt: Date.now() }))
        this.reviewRevision = null; return true
      })
      if (!flight.acquired) { this.remoteBusy = true; this.publish({ error: 'Another view or window is still using this source. Its operation cannot be reviewed yet.' }); return false }
      return flight.value
    } catch (error) { this.publish({ storageError: `The local review could not be retained: ${message(error)}` }); return false }
    finally { this.localBusy = false; if (acquired) this.remoteBusy = false; this.publish(); void this.load(true) }
  }

  dispose(): void { this.disposed = true; this.unsubscribe?.(); this.listeners.clear() }
  private adopt(entry: SourceFileMutationEntry): void { this.readVersion++; this.entry = entry; this.publish({ loaded: true, storageError: null }) }
  private publish(patch: Partial<SourceFileMutationState> = {}): void {
    if (patch.error !== undefined) this.actionError = patch.error
    const receipt = this.entry?.receipt, storageError = patch.storageError === undefined ? this.state.storageError : patch.storageError
    const observed = receipt?.observed ?? null
    this.state = { ...this.state, operationId: receipt?.operationId ?? null, phase: receipt?.phase ?? null,
      request: receipt?.request ?? null, result: receipt?.result ?? null, observed, omittedPaths: receipt?.omittedPaths ?? 0,
      uncertain: receipt?.phase === 'pending' || receipt?.phase === 'unknown', busy: this.busy,
      error: storageError ?? this.actionError ?? receipt?.error ?? null,
      canReview: !this.busy && Boolean(receipt && ['pending', 'unknown'].includes(receipt.phase)
        && this.reviewRevision === this.entry?.revision && observed?.length && observed.every(row => row.result.success || row.result.code === 'not-found')),
      ...patch }
    if (this.disposed) return
    for (const listener of this.listeners) listener()
  }
}
