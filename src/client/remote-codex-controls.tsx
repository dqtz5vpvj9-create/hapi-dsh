/** The existing composer picker, backed by the original Codex source. */
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { HhpiRemoteApi } from '../hhpi-api.ts'
import type { SourceSession } from '../remote/protocol.ts'
import type { NativeActionOwner } from './remote-native-actions.ts'
import type { NativeActionRecord } from './remote-operation-contracts.ts'
import type { SourceDirectory } from './source-capabilities.ts'
import type { CodexCall } from '../remote/codex-access.ts'
import type { RemoteSourceSession } from './remote-sessions.ts'
import { SourceControls, type InputProps } from './composer-picker/index.tsx'
import { validPickerAction, type PickerAction, type PickerData, type PickerPending } from './composer-picker/data.ts'
import { CodexActions } from './remote-codex-actions.tsx'
import { sourceIsOffline } from '../shared/source-connectivity.ts'

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
interface Model { model: string; displayName: string; supportedReasoningEfforts: Array<{ reasoningEffort: string; description: string }>; serviceTiers?: Array<{ id: string; name?: string }> }
interface State { data: PickerData | null; pending: PickerPending | null; applied: PickerPending | null; busy: boolean; loading: boolean; error: string | null }
export interface CodexControlServices {
  actions: NativeActionOwner
  directory(): SourceDirectory | undefined
}
function settingChange(action: NativeActionRecord): PickerPending['change'] | undefined {
  const params = action.request.params
  if (!params) return undefined
  if (typeof params.model === 'string') return { kind: 'model', value: params.model }
  if ('effort' in params && (params.effort === null || typeof params.effort === 'string')) return { kind: 'effort', value: params.effort }
  if (typeof params.permissions === 'string') return { kind: 'permission', value: params.permissions }
  if (typeof params.approvalPolicy === 'string') return { kind: 'approvalPolicy', value: params.approvalPolicy }
  if ('serviceTier' in params) return { kind: 'serviceTier', value: typeof params.serviceTier === 'string' ? params.serviceTier : 'standard' }
  if (record(params.collaborationMode) && (params.collaborationMode.mode === 'plan' || params.collaborationMode.mode === 'default')) return { kind: 'collaboration', value: params.collaborationMode.mode }
  return undefined
}
export class CodexSettingsController {
  private state: State = { data: null, pending: null, applied: null, busy: false, loading: false, error: null }
  private listeners = new Set<() => void>()
  private read: Promise<void> | undefined
  private models: Model[] = []
  private permissions: string[] = []
  private writable = false
  private mutationError: string | null = null
  private disposed = false
  private revision = 0
  private readonly stop: () => void
  constructor(private readonly api: HhpiRemoteApi, private metadata: SourceSession, private readonly services?: CodexControlServices) {
    this.stop = services?.actions.view(metadata.id).subscribe(() => this.reconcile()) ?? (() => {})
    this.reconcile()
  }
  getSnapshot = (): State => this.state
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish(patch: Partial<State>): void {
    if (this.disposed) return
    this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener()
  }
  observe(metadata: SourceSession): void {
    if (metadata.id !== this.metadata.id) throw new Error('The settings owner belongs to another conversation.')
    this.metadata = metadata
    if (this.models.length) this.publish({ data: this.data() })
    // A matching value is display state; only the original receipt settles an action.
  }
  private reconcile(): void {
    const action = this.services?.actions.get(this.metadata.id, 'settings')
    const change = action && settingChange(action)
    const unresolved = action && !['accepted', 'rejected'].includes(action.phase)
    this.publish({ pending: unresolved && change ? { operationId: action.request.operationId, change } : null,
      applied: action?.phase === 'accepted' && change ? { operationId: action.request.operationId, change } : null,
      error: action?.outcome?.status === 'rejected' || action?.outcome?.status === 'indeterminate' ? action.outcome.message : this.mutationError })
  }
  private fastTier(): string | undefined {
    const tiers = this.models.find(model => model.model === this.metadata.codex?.model)?.serviceTiers ?? []
    return tiers.find(tier => tier.id === 'priority')?.id ?? tiers.find(tier => tier.name?.toLowerCase() === 'fast')?.id
  }
  private data(): PickerData {
    const source = this.metadata.codex, settings = source?.settings
    const model = this.models.find(model => model.model === source?.model)
    const permission = record(settings?.activePermissionProfile) && typeof settings.activePermissionProfile.id === 'string' ? settings.activePermissionProfile.id : null
    const serviceTier = typeof settings?.serviceTier === 'string' ? settings.serviceTier : null
    const writable = this.writable && !!this.services && !sourceIsOffline(this.metadata)
    const fastTier = this.fastTier()
    return { model: source?.model ?? null, models: this.models.map(model => ({ value: model.model, label: model.displayName })),
      effort: source?.reasoningEffort ?? null, efforts: model?.supportedReasoningEfforts.map(effort => ({ value: effort.reasoningEffort, label: effort.reasoningEffort, detail: effort.description })) ?? [],
      permission, permissions: this.permissions,
      approvalPolicy: typeof settings?.approvalPolicy === 'string' ? settings.approvalPolicy : record(settings?.approvalPolicy) ? 'custom' : null,
      // These scalar choices are part of the pinned native settings API; granular policies stay descriptive.
      approvalPolicies: this.writable ? ['untrusted', 'on-request', 'never'] : [],
      readOnly: !writable, serviceTier, fast: !!fastTier && serviceTier === fastTier, fastAvailable: !!fastTier,
      editable: { model: writable, effort: writable && !!model?.supportedReasoningEfforts.length, permission: writable && !!this.permissions.length, fast: writable && !!fastTier, approvalPolicy: writable }, warnings: [] }
  }
  private async call(request: CodexCall) {
    if (!this.api.nativeCall) throw new Error('The source does not expose native Codex controls.')
    const response = await this.api.nativeCall(request)
    if (!response.ok) throw new Error(response.error.message)
    return response.value
  }
  refresh = (): Promise<void> => {
    if (this.disposed) return Promise.resolve()
    if (this.read) return this.read
    const revision = this.revision
    this.publish({ loading: true })
    const work = (async () => {
      try {
        const directory = this.services?.directory()
        if (!directory) throw new Error('The source control service is not connected.')
        // Recovery asks for a receipt only. It never dispatches a saved write.
        await this.services!.actions.recover(this.metadata.id, 'settings')
        const capabilities = await directory.capabilities()
        const [models, permissions] = await Promise.all([
          directory.list('model/list'),
          capabilities.methods['permissionProfile/list'] === 'read' ? directory.list('permissionProfile/list') : Promise.resolve([]),
        ])
        if (this.disposed || revision !== this.revision) return
        this.writable = capabilities.methods['thread/settings/update'] === 'write'
        this.models = models.filter((entry): entry is Model => record(entry) && typeof entry.model === 'string' && typeof entry.displayName === 'string' && Array.isArray(entry.supportedReasoningEfforts))
        this.permissions = permissions.flatMap(row => record(row) && typeof row.id === 'string' && row.allowed === true ? [row.id] : [])
        const thread = await this.call({ sourceId: this.metadata.sourceId, method: 'thread/read', params: { threadId: this.metadata.nativeId, includeTurns: false } })
        if (this.disposed || revision !== this.revision) return
        if (thread.status !== 'accepted') throw new Error(thread.message)
        if (!record(thread.result) || !record(thread.result.thread) || thread.result.thread.id !== this.metadata.nativeId) throw new Error('The source returned another conversation while reading settings.')
        const native = thread.result.thread
        this.observe({ ...this.metadata, codex: { ...this.metadata.codex!, model: typeof native.model === 'string' ? native.model : null, reasoningEffort: typeof native.reasoningEffort === 'string' ? native.reasoningEffort : null } })
        this.reconcile()
        this.publish({ data: this.data() })
      } catch (error) { if (revision === this.revision) this.publish({ error: error instanceof Error ? error.message : String(error) }) }
    })().finally(() => { if (this.read === work) this.read = undefined; this.publish({ loading: false }) })
    this.read = work
    return work
  }
  apply = async (action: PickerAction): Promise<boolean> => {
    if (this.disposed || !this.services || this.state.pending || this.state.busy || !this.state.data || !validPickerAction(this.state.data, action)) return false
    const key = action.kind === 'permission' ? 'permissions' : action.kind === 'fast' ? 'serviceTier' : action.kind
    const value = action.kind === 'fast' ? action.value ? this.fastTier() : null : action.value
    ++this.revision; this.mutationError = null
    this.publish({ busy: true, error: null })
    let accepted = false
    try {
      const result = await this.services.actions.submit({ sessionId: this.metadata.id, intent: 'settings', kind: 'settings', newAttempt: true,
        request: { sourceId: this.metadata.sourceId, method: 'thread/settings/update', params: { threadId: this.metadata.nativeId, [key]: value } } })
      accepted = result.phase === 'accepted'
      this.reconcile()
    } catch (error) { this.mutationError = error instanceof Error ? error.message : String(error); this.publish({ error: this.mutationError }) }
    finally { await this.read; this.publish({ busy: false }); await this.refresh() }
    return accepted
  }
  continuePending = async (): Promise<void> => {
    const original = this.services?.actions.get(this.metadata.id, 'settings')
    if (this.disposed || this.state.busy || original?.phase !== 'prepared' || sourceIsOffline(this.metadata)) return
    this.publish({ busy: true, error: null }); this.mutationError = null
    try { await this.services!.actions.submit({ sessionId: original.sessionId, intent: original.intent, kind: original.kind, request: original.request }) }
    catch (error) { this.mutationError = error instanceof Error ? error.message : String(error); this.publish({ error: this.mutationError }) }
    finally { this.publish({ busy: false }); await this.refresh() }
  }
  dispose(): void { this.disposed = true; ++this.revision; this.stop(); this.listeners.clear() }
}
export function DirectCodexControls({ ctx, api, props }: { ctx: Context; api: HhpiRemoteApi; props: InputProps }) {
  const session = (props.sessionBinding ?? ctx.sessions.binding(props.sessionId))?.session as RemoteSourceSession | undefined
  return session ? <Controls key={props.sessionId} ctx={ctx} api={api} props={props} session={session}/> : null
}
function Controls({ ctx, api, props, session }: { ctx: Context; api: HhpiRemoteApi; props: InputProps; session: RemoteSourceSession }) {
  const metadata = useSyncExternalStore(session.metadata.subscribe, session.metadata.getSnapshot)
  const settings = useMemo(() => new CodexSettingsController(api, metadata, session.nativeActions ? { actions: session.nativeActions, directory: () => session.sourceDirectory() } : undefined), [api, session])
  const state = useSyncExternalStore(settings.subscribe, settings.getSnapshot)
  useEffect(() => () => settings.dispose(), [settings])
  useEffect(() => settings.observe(metadata), [settings, metadata])
  const refresh = useCallback(() => settings.refresh(), [settings])
  const locked = props.useInput(value => value.phase === 'adjudicating' || value.phase === 'submitting')
  if (!metadata.codex || !api.nativeCall) return null
  return <SourceControls ctx={ctx} props={props} initial={{ model: metadata.codex.model, effort: metadata.codex.reasoningEffort, permission: null, serviceTier: null, collaboration: record(metadata.codex.settings?.collaborationMode) && typeof metadata.codex.settings.collaborationMode.mode === 'string' ? metadata.codex.settings.collaborationMode.mode : null }}
    actionsContent={<CodexActions key={metadata.id} ctx={ctx} session={session} metadata={metadata} zh={ctx.locale.getSnapshot().active.startsWith('zh')}/>}
    permissionCapable data={state.data} loading={state.loading} busy={state.busy} pending={state.pending} applied={state.applied} error={state.error} sourceLocked={locked || sourceIsOffline(metadata)} refresh={refresh} apply={settings.apply}
    {...(session.nativeActions?.get(metadata.id, 'settings')?.phase === 'prepared' ? { resume: settings.continuePending } : {})}/>
}
