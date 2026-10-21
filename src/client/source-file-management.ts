/** Source file mutations retain their original request until its result is reviewed. */
import { remoteValue } from '../client-api.ts'
import type { NativeWorkbenchApi, WorkbenchRequest, WorkbenchResponse, WorkbenchSource } from '../workbench-types.ts'

type Operation = WorkbenchRequest<'nativeFileManage'>['operation']
type Request = Operation | { action: 'upload'; path: string }
type Api = Pick<NativeWorkbenchApi, 'nativeFileManage' | 'nativeFileUpload' | 'nativeFileInspect'>
export interface SourceFileMutationState {
  readonly request: Request | null
  readonly busy: boolean
  readonly uncertain: boolean
  readonly result: WorkbenchResponse<'nativeFileManage'> | null
  readonly observed: ReadonlyArray<{ path: string; result: WorkbenchResponse<'nativeFileInspect'> }> | null
  readonly error: string | null
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
  private state: SourceFileMutationState = { request: null, busy: false, uncertain: false, result: null, observed: null, error: null }
  private readonly listeners = new Set<() => void>()
  constructor(private readonly api: Api, readonly source: WorkbenchSource) {}
  getSnapshot = (): SourceFileMutationState => this.state
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  get blocked(): boolean { return this.state.busy || this.state.uncertain }

  async manage(operation: Operation): Promise<boolean> {
    return this.submit(operation, () => this.api.nativeFileManage({ source: this.source, operation }))
  }
  async upload(path: string, content: string): Promise<boolean> {
    // Retain identity and result, never another 64 MiB copy of uploaded bytes.
    return this.submit({ action: 'upload', path }, () => this.api.nativeFileUpload({ source: this.source, path, content }))
  }
  private async submit(request: Request, send: () => ReturnType<Api['nativeFileManage']>): Promise<boolean> {
    if (this.blocked) return false
    this.update({ request: structuredClone(request), busy: true, uncertain: false, result: null, observed: null, error: null })
    try {
      const result = remoteValue(await send())
      // A failed metadata read can follow an already committed rename; a
      // recursive delete can report partial progress. Preserve that evidence.
      this.update({ result, uncertain: !result.success, error: result.success ? null : result.error ?? result.code ?? 'The source did not confirm this file operation.' })
      return result.success
    } catch (error) { this.update({ uncertain: true, error: message(error) }); return false }
    finally { this.update({ busy: false }) }
  }

  /** Read original and destination paths only; never submit the mutation again. */
  async inspect(): Promise<void> {
    const request = this.state.request
    if (!request || this.state.busy) return
    this.update({ busy: true, observed: null, error: null })
    try {
      const paths = 'destination' in request ? [request.path, request.destination] : [request.path]
      const observed = await Promise.all([...new Set(paths)].map(async path => ({ path,
        result: remoteValue(await this.api.nativeFileInspect({ source: this.source, path })),
      })))
      this.update({ observed })
    } catch (error) { this.update({ error: message(error) }) }
    finally { this.update({ busy: false }) }
  }

  /** Explicit user acknowledgement unlocks a different action after fresh reads. */
  review(): boolean {
    if (this.state.busy || !this.state.observed?.length
      || this.state.observed.some(row => !row.result.success && row.result.code !== 'not-found')) return false
    this.update({ uncertain: false, request: null, result: null, observed: null, error: null })
    return true
  }
  private update(patch: Partial<SourceFileMutationState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }
}
