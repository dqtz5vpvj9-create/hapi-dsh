/** The existing composer picker, backed by the original Codex source. */
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { HhpiRemoteApi } from '../hhpi-api.ts'
import type { SourceSession } from '../remote/protocol.ts'
import type { CodexCall } from '../remote/codex-access.ts'
import type { RemoteSourceSession } from './remote-sessions.ts'
import { SourceControls, type InputProps } from './composer-picker/index.tsx'
import { validPickerAction, type PickerAction, type PickerData, type PickerPending } from './composer-picker/data.ts'
import { CodexActions } from './remote-codex-actions.tsx'
import { sourceIsOffline } from '../shared/source-connectivity.ts'

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
interface Model { model: string; displayName: string; supportedReasoningEfforts: Array<{ reasoningEffort: string; description: string }>; serviceTiers?: Array<{ id: string }> }
interface State { data: PickerData | null; pending: PickerPending | null; busy: boolean; loading: boolean; error: string | null }
export class CodexSettingsController {
  private state: State = { data: null, pending: null, busy: false, loading: false, error: null }
  private listeners = new Set<() => void>()
  private read: Promise<void> | undefined
  private pendingCall: CodexCall | undefined
  private models: Model[] = []
  private permissions: string[] = []
  private epoch = 0
  constructor(private readonly api: HhpiRemoteApi, private metadata: SourceSession) {}
  getSnapshot = (): State => this.state
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish(patch: Partial<State>): void { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener() }
  observe(metadata: SourceSession): void {
    this.metadata = metadata
    if (this.models.length) this.publish({ data: this.data() })
    // Equality is useful presentation convergence, never proof of this operation's identity.
    const pending = this.state.pending
    if (pending && this.matches(pending.change)) { this.pendingCall = undefined; this.publish({ pending: null }) }
  }
  private matches(change: PickerPending['change']): boolean {
    const source = this.metadata.codex
    return change.kind === 'model' ? source?.model === change.value : change.kind === 'effort' ? source?.reasoningEffort === change.value
      : change.kind === 'permission' ? record(source?.settings?.activePermissionProfile) && source.settings.activePermissionProfile.id === change.value
      : change.kind === 'serviceTier' ? (source?.settings?.serviceTier ?? 'standard') === change.value : false
  }
  private data(): PickerData {
    const source = this.metadata.codex, settings = source?.settings
    const model = this.models.find(model => model.model === source?.model)
    const permission = record(settings?.activePermissionProfile) && typeof settings.activePermissionProfile.id === 'string' ? settings.activePermissionProfile.id : null
    const serviceTier = typeof settings?.serviceTier === 'string' ? settings.serviceTier : null
    const writable = !sourceIsOffline(this.metadata) && this.metadata.capabilities.steer
    const tiers = model?.serviceTiers?.map(tier => tier.id) ?? []
    return { model: source?.model ?? null, models: this.models.map(model => ({ value: model.model, label: model.displayName })),
      effort: source?.reasoningEffort ?? null, efforts: model?.supportedReasoningEfforts.map(effort => ({ value: effort.reasoningEffort, label: effort.reasoningEffort, detail: effort.description })) ?? [],
      permission, permissions: this.permissions, readOnly: !writable, serviceTier, fast: serviceTier === 'fast', fastAvailable: tiers.includes('fast'),
      editable: { model: writable, effort: writable && !!model?.supportedReasoningEfforts.length, permission: writable && !!this.permissions.length, fast: writable && tiers.includes('fast') }, warnings: [] }
  }
  private async call(request: CodexCall) {
    if (!this.api.nativeCall) throw new Error('The source does not expose native Codex controls.')
    const response = await this.api.nativeCall(request)
    if (!response.ok) throw new Error(response.error.message)
    return response.value
  }
  refresh = (): Promise<void> => {
    if (this.read) return this.read
    const epoch = this.epoch
    this.publish({ loading: true })
    this.read = (async () => {
      try {
        if (this.pendingCall && this.api.nativeReceipt) {
          const response = await this.api.nativeReceipt(this.pendingCall)
          if (response.ok && response.value.status === 'rejected') { this.pendingCall = undefined; this.publish({ pending: null, busy: false, error: response.value.message }) }
        }
        const models: Model[] = []
        let cursor: string | null = null
        do {
          const response = await this.call({ sourceId: this.metadata.sourceId, method: 'model/list', params: { cursor, limit: 100 } })
          if (response.status !== 'accepted') throw new Error(response.message)
          if (!record(response.result) || !Array.isArray(response.result.data)) throw new Error('Invalid native model catalog')
          for (const entry of response.result.data) if (record(entry) && typeof entry.model === 'string' && typeof entry.displayName === 'string' && Array.isArray(entry.supportedReasoningEfforts)) models.push(entry as unknown as Model)
          const next = typeof response.result.nextCursor === 'string' ? response.result.nextCursor : null
          if (next && next === cursor) throw new Error('Native model catalog cursor did not advance')
          cursor = next
        } while (cursor)
        if (epoch !== this.epoch) return
        this.models = models
        const permissions = await this.call({ sourceId: this.metadata.sourceId, method: 'permissionProfile/list', params: {} })
        if (epoch !== this.epoch) return
        if (permissions.status === 'accepted' && record(permissions.result) && Array.isArray(permissions.result.data)) this.permissions = permissions.result.data.flatMap(row => record(row) && typeof row.id === 'string' ? [row.id] : [])
        const thread = await this.call({ sourceId: this.metadata.sourceId, method: 'thread/read', params: { threadId: this.metadata.nativeId, includeTurns: false } })
        if (epoch !== this.epoch) return
        if (thread.status === 'accepted' && record(thread.result) && record(thread.result.thread)) {
          const native = thread.result.thread
          this.observe({ ...this.metadata, codex: { ...this.metadata.codex!, model: typeof native.model === 'string' ? native.model : null, reasoningEffort: typeof native.reasoningEffort === 'string' ? native.reasoningEffort : null } })
        }
        this.publish({ data: this.data() })
      } catch (error) { if (epoch === this.epoch) this.publish({ error: error instanceof Error ? error.message : String(error) }) }
      finally { this.read = undefined; this.publish({ loading: false }) }
    })()
    return this.read
  }
  apply = async (action: PickerAction): Promise<boolean> => {
    if (this.state.pending || this.state.busy || !this.state.data || !validPickerAction(this.state.data, action)) return false
    const change: PickerPending['change'] = action.kind === 'fast' ? { kind: 'serviceTier', value: action.value ? 'fast' : 'standard' } : action
    const key = action.kind === 'permission' ? 'permissions' : action.kind === 'fast' ? 'serviceTier' : action.kind
    const value = action.kind === 'fast' ? action.value ? 'fast' : null : action.value
    const operationId = crypto.randomUUID()
    const request: CodexCall = { sourceId: this.metadata.sourceId, method: 'thread/settings/update', operationId, params: { threadId: this.metadata.nativeId, [key]: value } }
    ++this.epoch; this.pendingCall = request
    this.publish({ pending: { operationId, change }, busy: true, error: null })
    try {
      const result = await this.call(request)
      if (result.status === 'rejected') { this.pendingCall = undefined; this.publish({ pending: null, error: result.message }) }
      if (result.status === 'indeterminate') this.publish({ error: result.message })
    } catch (error) { this.publish({ error: error instanceof Error ? error.message : String(error) }) }
    finally { await this.read; this.publish({ busy: false }); await this.refresh() }
    return !this.state.pending && this.matches(change)
  }
}
const controllers = new WeakMap<HhpiRemoteApi, Map<string, CodexSettingsController>>()
function controller(api: HhpiRemoteApi, metadata: SourceSession): CodexSettingsController {
  let sessions = controllers.get(api)
  if (!sessions) { sessions = new Map(); controllers.set(api, sessions) }
  let value = sessions.get(metadata.id)
  if (!value) { value = new CodexSettingsController(api, metadata); sessions.set(metadata.id, value) }
  return value
}
export function DirectCodexControls({ ctx, api, props }: { ctx: Context; api: HhpiRemoteApi; props: InputProps }) {
  const session = (props.sessionBinding ?? ctx.sessions.binding(props.sessionId))?.session as RemoteSourceSession | undefined
  return session ? <Controls key={props.sessionId} ctx={ctx} api={api} props={props} session={session}/> : null
}
function Controls({ ctx, api, props, session }: { ctx: Context; api: HhpiRemoteApi; props: InputProps; session: RemoteSourceSession }) {
  const metadata = useSyncExternalStore(session.metadata.subscribe, session.metadata.getSnapshot)
  const settings = useMemo(() => controller(api, metadata), [api, metadata.id])
  const state = useSyncExternalStore(settings.subscribe, settings.getSnapshot)
  useEffect(() => settings.observe(metadata), [settings, metadata])
  const refresh = useCallback(() => settings.refresh(), [settings])
  const locked = props.useInput(value => value.phase === 'adjudicating' || value.phase === 'submitting')
  if (!metadata.codex || !api.nativeCall) return null
  return <SourceControls ctx={ctx} props={props} initial={{ model: metadata.codex.model, effort: metadata.codex.reasoningEffort, permission: null, serviceTier: null }}
    actionsContent={<CodexActions key={metadata.id} api={api} metadata={metadata} zh={ctx.locale.getSnapshot().active.startsWith('zh')}/>}
    permissionCapable data={state.data} loading={state.loading} busy={state.busy} pending={state.pending} error={state.error} sourceLocked={locked || sourceIsOffline(metadata)} refresh={refresh} apply={settings.apply}/>
}
