import { randomId } from './random-id.ts'
/** Source file mutations retain their original request until its result is reviewed. */
import type { WorkspaceFileOperation } from '../workbench-types.ts'
import type { WorkspaceEntry, WorkspaceMutationResult, WorkspaceUploadReceipt, WorkspaceUploadTransfer } from '../workspace/service-types.ts'
import { sourceFileAccess, type SourceFileContext } from './source-workspace-provider.ts'
import { sourceFileMutationRequestSchema, sourceFileMutationResult, sourceFileOwnerSchema,
  type SourceFileMutationEntry, type SourceFileMutationJournal, type SourceFileMutationReceipt, type SourceFileMutationRequest, type SourceFileOwner } from './source-file-mutation-journal.ts'

type Operation = WorkspaceFileOperation
type Request = SourceFileMutationRequest
type Result = WorkspaceMutationResult<WorkspaceEntry | null>
export interface SourceFileMutationState {
  readonly loaded: boolean
  readonly operationId: string | null
  readonly phase: SourceFileMutationReceipt['phase'] | null
  readonly request: Request | null
  readonly busy: boolean
  readonly uncertain: boolean
  readonly result: Result | null
  readonly observed: ReadonlyArray<{ path: string; entry: WorkspaceEntry | null }> | null
  readonly error: string | null
  readonly storageError: string | null
  readonly omittedPaths: number
  readonly canReview: boolean
  readonly hasUploadFile: boolean
  readonly uploadedBytes: number | null
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
    result: null, observed: null, error: null, storageError: null, omittedPaths: 0, canReview: false, hasUploadFile: false, uploadedBytes: null }
  private readonly listeners = new Set<() => void>()
  readonly owner: SourceFileOwner | undefined
  private entry: SourceFileMutationEntry | null = null
  private unsubscribe: (() => void) | undefined
  private loading: Promise<void> | undefined
  private admitting = false
  private localBusy = false
  private remoteBusy = false
  private actionError: string | null = null
  private readVersion = 0
  private refreshQueued = false
  private reviewRevision: string | null = null
  private uploadFile: { operationId: string; file: Blob } | undefined
  private disposed = false
  private readonly lifetime = new AbortController()
  constructor(readonly context: SourceFileContext, private readonly journal: SourceFileMutationJournal) {
    const owner = sourceFileOwnerSchema.safeParse(context.owner)
    if (owner.success) {
      this.owner = owner.data
      this.context = { ...context, owner: owner.data }
      try { this.unsubscribe = journal.subscribe(owner.data, () => { this.publish(); this.refreshQueued = true; void this.load(true) }) }
      catch (error) { this.state = { ...this.state, loaded: true, storageError: message(error), error: message(error) } }
    } else this.state = { ...this.state, loaded: true, storageError: 'The authenticated account and exact source workspace must be known before a file operation can be retained or sent.',
      error: 'The authenticated account and exact source workspace must be known before a file operation can be retained or sent.' }
  }
  getSnapshot = (): SourceFileMutationState => this.state
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  get blocked(): boolean { return this.disposed || !this.state.loaded || this.busy || this.state.uncertain || this.state.storageError !== null }
  private get busy(): boolean { return this.admitting || this.localBusy || this.remoteBusy || Boolean(this.owner && this.journal.active(this.owner)) }
  private get access() { return sourceFileAccess(this.context.owner, this.lifetime.signal) }

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
    return this.submit(fixed, operationId => {
      if (!this.context.services.mutations) throw new Error('File management is not registered on this source.')
      return this.context.services.mutations.manage({ target: this.context.owner.binding.target, operationId, operation: fixed }, this.access)
    })
  }
  async upload(path: string, file: Blob): Promise<boolean> {
    const request: Extract<Request, { action: 'upload' }> = { action: 'upload', path, bytes: file.size,
      mimeType: file.type || 'application/octet-stream',
      ...(typeof Reflect.get(file, 'name') === 'string' ? { fileName: String(Reflect.get(file, 'name')) } : {}) }
    return this.submit(request, async operationId => {
      this.uploadFile = { operationId, file }; this.publish()
      const uploads = this.context.services.uploads
      if (!uploads) throw new Error('File upload is not registered on this source.')
      const transfer = await uploads.begin({ target: this.context.owner.binding.target, operationId,
        destination: { kind: 'file', path, baseline: { kind: 'absent' } }, bytes: request.bytes, mimeType: request.mimeType }, this.access)
      await this.retainUpload(operationId, transfer.uploadId)
      return this.transferUpload(request, operationId, transfer, file)
    })
  }
  /** Explicit continuation of the original upload; inspection alone never appends or finishes. */
  async resumeUpload(file?: Blob, confirmedReselection = false): Promise<boolean> {
    if (this.disposed || this.busy || !this.owner) return false
    await this.load()
    const expected = this.entry, request = expected?.receipt.request
    if (!expected || request?.action !== 'upload' || !['pending', 'unknown'].includes(expected.receipt.phase)) return false
    const operationId = expected.receipt.operationId
    const original = this.uploadFile?.operationId === operationId ? this.uploadFile.file : undefined
    const selected = file ?? original
    if (!selected || file && file !== original && !confirmedReselection) {
      this.publish({ error: 'Reselect the original file and confirm the saved destination, size and type before resuming this upload.' }); return false
    }
    if (selected.size !== request.bytes || (selected.type || 'application/octet-stream') !== request.mimeType
      || request.fileName && Reflect.get(selected, 'name') !== request.fileName) {
      this.publish({ error: 'The selected file does not match the saved upload name, size and type.' }); return false
    }
    this.localBusy = true; this.reviewRevision = null; this.publish({ error: null })
    let acquired = false
    try {
      const flight = await this.journal.exclusive(this.owner, operationId, async () => {
        acquired = true
        const fresh = await this.journal.read(this.owner!)
        if (this.disposed || fresh?.revision !== expected.revision) { if (fresh) this.adopt(fresh); return false }
        this.uploadFile = { operationId, file: selected }; this.publish()
        return this.settle(operationId, async () => {
          const uploads = this.context.services.uploads
          if (!uploads) throw new Error('File upload is not registered on this source.')
          if (!request.uploadId) {
            // The source's unique operation key recovers the same transfer after a lost begin reply.
            const transfer = await uploads.begin({ target: this.owner!.binding.target, operationId,
              destination: { kind: 'file', path: request.path, baseline: { kind: 'absent' } }, bytes: request.bytes, mimeType: request.mimeType }, this.access)
            await this.retainUpload(operationId, transfer.uploadId)
            return this.transferUpload(request, operationId, transfer, selected)
          }
          const status = await uploads.status({ target: this.context.owner.binding.target, uploadId: request.uploadId }, this.access)
          if (status.state === 'finished') return this.uploadResult(request, operationId, status.result)
          if (status.state === 'cancelled') return this.cancelledUpload(operationId)
          return this.transferUpload(request, operationId, status.transfer, selected)
        })
      })
      if (!flight.acquired) { this.remoteBusy = true; this.publish({ error: 'Another view or window is still using this source upload.' }); return false }
      return flight.value
    } catch (error) { this.publish({ storageError: message(error) }); return false }
    finally { this.localBusy = false; if (acquired) this.remoteBusy = false; this.publish(); void this.load(true) }
  }
  async cancelUpload(): Promise<void> {
    if (this.disposed || this.busy || !this.owner) return
    await this.load()
    const current = this.entry, request = current?.receipt.request
    if (!current || request?.action !== 'upload' || !request.uploadId || !this.context.services.uploads) return
    this.localBusy = true; this.publish({ error: null })
    let acquired = false
    try {
      const flight = await this.journal.exclusive(this.owner, current.receipt.operationId, async () => {
        acquired = true
        const fresh = await this.journal.read(this.owner!)
        if (this.disposed || fresh?.revision !== current.revision) { if (fresh) this.adopt(fresh); return }
        await this.settle(current.receipt.operationId, async () => {
          const status = await this.context.services.uploads!.cancel({ target: this.owner!.binding.target, uploadId: request.uploadId! }, this.access)
          if (status.state === 'finished') return this.uploadResult(request, current.receipt.operationId, status.result)
          if (status.state === 'cancelled') return this.cancelledUpload(current.receipt.operationId)
          throw new Error('The source did not confirm upload cancellation. Its original operation remains unresolved.')
        })
      })
      if (!flight.acquired) { this.remoteBusy = true; this.publish({ error: 'Another view or window is still using this source upload.' }) }
    } catch (error) { this.publish({ storageError: message(error) }) }
    finally { this.localBusy = false; if (acquired) this.remoteBusy = false; this.publish(); void this.load(true) }
  }
  private async retainUpload(operationId: string, uploadId: string): Promise<void> {
    const current = await this.journal.read(this.owner!)
    if (current?.receipt.operationId !== operationId || current.receipt.request.action !== 'upload') throw new Error('The saved upload intent changed before its transfer could be retained.')
    this.adopt(await this.journal.write(this.owner!, current.revision, { ...current.receipt,
      request: { ...current.receipt.request, uploadId }, updatedAt: Date.now() }))
  }
  private async transferUpload(request: Extract<Request, { action: 'upload' }>, operationId: string, transfer: WorkspaceUploadTransfer, file: Blob): Promise<Result> {
    const uploads = this.context.services.uploads!
    if (transfer.operationId !== operationId || transfer.target.hostId !== this.context.owner.binding.target.hostId
      || transfer.target.sessionId !== this.context.owner.binding.target.sessionId || transfer.destination.kind !== 'file'
      || transfer.destination.path !== request.path || transfer.bytes !== request.bytes || transfer.chunkBytes <= 0
      || transfer.receivedBytes < 0 || transfer.receivedBytes > file.size) throw new Error('The source upload does not match this saved file intent.')
    this.publish({ uploadedBytes: transfer.receivedBytes })
    for (let offset = transfer.receivedBytes; offset < file.size;) {
      this.lifetime.signal.throwIfAborted()
      const data = new Uint8Array(await file.slice(offset, offset + transfer.chunkBytes).arrayBuffer())
      const reply = await uploads.append({ target: transfer.target, uploadId: transfer.uploadId, offset, data }, this.access)
      if (reply.receivedBytes !== offset + data.length) throw new Error('The source did not confirm the exact uploaded byte offset. Inspect its status before resuming.')
      offset = reply.receivedBytes; this.publish({ uploadedBytes: offset })
    }
    this.lifetime.signal.throwIfAborted()
    return this.uploadResult(request, operationId, await uploads.finish({ target: transfer.target, uploadId: transfer.uploadId }, this.access))
  }
  private uploadResult(request: Extract<Request, { action: 'upload' }>, operationId: string, result: WorkspaceMutationResult<WorkspaceUploadReceipt>): Result {
    if (result.operationId !== operationId) throw new Error('The source returned a receipt for a different upload.')
    if (result.status !== 'applied') return result
    if (result.value.kind !== 'file' || result.value.resource.target.hostId !== this.context.owner.binding.target.hostId
      || result.value.resource.target.sessionId !== this.context.owner.binding.target.sessionId || result.value.file.absolutePath !== request.path) throw new Error('This upload did not confirm its saved source file destination.')
    return { status: 'applied', operationId, value: { ...result.value.file,
      name: request.path.split(/[\\/]/).at(-1) || request.path, type: 'file', bytes: result.value.file.bytes ?? request.bytes } }
  }
  private cancelledUpload(operationId: string): Result { return { status: 'rejected', operationId, code: 'invalid', message: 'The source cancelled this upload. No file was committed.' } }
  private async settle(operationId: string, send: () => Promise<Result>): Promise<boolean> {
    let result: Result | null = null, failure: string | null = null
    try { result = await send() } catch (error) { failure = message(error) }
    const latest = await this.journal.read(this.owner!)
    if (latest?.receipt.operationId !== operationId) { if (latest) this.adopt(latest); return false }
    const evidence = result ? sourceFileMutationResult(result) : { result: null, omittedPaths: 0 }
    const updated: SourceFileMutationReceipt = { ...latest.receipt, ...evidence,
      phase: latest.receipt.phase === 'reviewed' ? 'reviewed' : result && result.status !== 'indeterminate' ? 'confirmed' : 'unknown', updatedAt: Date.now(),
      error: (failure ?? (result?.status === 'applied' ? null : result?.status === 'rejected' ? result.message : result?.status === 'conflict'
        ? 'The source entry changed. Inspect its current version before another operation.' : 'The source did not confirm this file operation.'))?.slice(0, 8192) ?? null }
    this.adopt(await this.journal.write(this.owner!, latest.revision, updated))
    if (updated.phase === 'confirmed') this.uploadFile = undefined
    this.publish()
    return result?.status === 'applied' && !this.disposed
  }
  private async submit(request: Request, send: (operationId: string) => Promise<Result>): Promise<boolean> {
    if (this.disposed || this.busy) return false
    // Loading the durable admission record is asynchronous. Publish the new
    // action as busy before that first await so the prior receipt cannot look
    // like its result, and a second click cannot enter the same read window.
    this.admitting = true; this.publish({ error: null })
    try { await this.load() } finally { this.admitting = false }
    if (this.blocked || !this.owner) { this.publish(); return false }
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
      // The strict transaction retains the same identity used by the source receipt.
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
        return this.settle(receipt.operationId, () => send(receipt.operationId))
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
        let result: Result | null | undefined
        if (request.action === 'upload') {
          if (request.uploadId && this.context.services.uploads) {
            const status = await this.context.services.uploads.status({ target: owner.binding.target, uploadId: request.uploadId }, this.access)
            if (status.state === 'finished') result = this.uploadResult(request, current.receipt.operationId, status.result)
            else if (status.state === 'cancelled') result = this.cancelledUpload(current.receipt.operationId)
            else this.publish({ uploadedBytes: status.transfer.receivedBytes, error: 'This original upload is still staged. Resume it explicitly with the original file; no bytes were sent by inspection.' })
          }
        } else result = await this.context.services.mutations?.receipt(current.receipt.operationId, this.access) as Result | null | undefined
        const paths = 'destination' in request ? [request.path, request.destination] : [request.path]
        const observed = await Promise.all([...new Set(paths)].map(async path => ({ path,
          entry: await this.context.services.documents.inspect(path, this.access),
        })))
        const fresh = await this.journal.read(owner)
        if (fresh?.receipt.operationId !== current.receipt.operationId) { if (fresh) this.adopt(fresh); return }
        const saved = await this.journal.write(owner, fresh.revision, { ...fresh.receipt, updatedAt: Date.now(),
          ...(result && result.status !== 'indeterminate' ? { result: sourceFileMutationResult(result as Result).result, phase: 'confirmed' as const, error: result.status === 'rejected' ? result.message : null } : {}),
          observed })
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

  dispose(): void { this.disposed = true; this.lifetime.abort(); this.uploadFile = undefined; this.unsubscribe?.(); this.listeners.clear() }
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
        && receipt.request.action !== 'upload' && this.reviewRevision === this.entry?.revision && observed?.length),
      hasUploadFile: this.uploadFile?.operationId === receipt?.operationId && !!this.uploadFile,
      ...patch }
    if (this.disposed) return
    for (const listener of this.listeners) listener()
  }
}
