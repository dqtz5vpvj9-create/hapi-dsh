/** Reuse the composer picker with the selected Remote ACP source's model catalog. */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { HhpiRemoteApi } from '../hhpi-api.ts'
import type { RemoteSourceSession } from './remote-sessions.ts'
import { SourceControls, type InputProps } from './composer-picker/index.tsx'
import { validPickerAction, type PickerAction, type PickerData } from './composer-picker/data.ts'
import { sourceIsOffline } from '../shared/source-connectivity.ts'

interface Selection { provider: string; model: string; reasoningEffort?: string }
interface Catalog { current: Selection; routable: boolean; groups: Array<{ id: string; models: Array<{
  id: string; name: string; reasoning?: { defaultEffort?: string; efforts: Array<{ id: string; name?: string }> }
}> }>; failures: Array<{ message?: string }> }

export function DirectAcpControls({ ctx, api, props, session }: {
  ctx: Context; api: HhpiRemoteApi; props: InputProps; session: RemoteSourceSession
}) {
  const metadata = useSyncExternalStore(session.metadata.subscribe, session.metadata.getSnapshot)
  const actions = session.nativeActions!
  const actionView = actions.view(metadata.id)
  const actionState = useSyncExternalStore(actionView.subscribe, actionView.getSnapshot)
  const pendingAction = actionState.find(action => action.intent === 'settings' && !['accepted', 'rejected'].includes(action.phase))
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const alive = useRef(true), revision = useRef(0)
  useEffect(() => { alive.current = true; return () => { alive.current = false; revision.current++ } }, [])
  const refresh = useCallback(async () => {
    const version = ++revision.current
    setLoading(true)
    try {
      await actions.recover(metadata.id, 'settings')
      if (!api.nativeCall) throw new Error('The source model controls are unavailable.')
      const response = await api.nativeCall({ sourceId: metadata.sourceId, method: 'session/models', params: { sessionId: metadata.nativeId } })
      if (!response.ok) throw new Error(response.error.message)
      if (response.value.status !== 'accepted') throw new Error(response.value.message)
      const value = response.value.result as Catalog
      if (!value?.current || !Array.isArray(value.groups) || value.current.provider !== metadata.engine) throw new Error('The model catalog does not belong to this source.')
      if (alive.current && version === revision.current) { setCatalog(value); setError(null) }
    } catch (failure) { if (alive.current && version === revision.current) setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { if (alive.current && version === revision.current) setLoading(false) }
  }, [api, actions, metadata.id, metadata.sourceId, metadata.nativeId, metadata.engine])
  const current = catalog?.current ?? metadata.agent
  const rawModel = current?.model === 'host-settings' ? null : (current?.model ?? null)
  const models = catalog?.groups.filter(group => group.id === metadata.engine).flatMap(group => group.models) ?? []
  const selected = models.find(model => model.id === rawModel)
  const writable = !!catalog?.routable && !sourceIsOffline(metadata) && metadata.status !== 'running' && !pendingAction
  const data: PickerData | null = catalog ? {
    model: rawModel, models: models.map(model => ({ value: model.id, label: model.name === 'host-settings' ? 'Default' : model.name })),
    effort: current?.reasoningEffort ?? null,
    efforts: selected?.reasoning?.efforts.map(effort => ({ value: effort.id, label: effort.name ?? effort.id })) ?? [],
    permission: null, permissions: [], readOnly: !writable, serviceTier: null, fast: false, fastAvailable: false,
    editable: { model: writable, effort: writable && !!selected?.reasoning?.efforts.length, permission: false, fast: false },
    warnings: (catalog.failures ?? []).flatMap(failure => failure.message ? [failure.message] : []),
  } : null
  const apply = async (action: PickerAction) => {
    if (!data || busy || !validPickerAction(data, action) || !['model', 'effort'].includes(action.kind)) return false
    const model = action.kind === 'model' ? action.value : current?.model
    if (!model || typeof model !== 'string') return false
    const target = models.find(item => item.id === model)
    const effort = action.kind === 'effort' ? action.value : target?.reasoning?.defaultEffort
    setBusy(true); setError(null)
    try {
      const result = await actions.submit({ sessionId: metadata.id, intent: 'settings', kind: 'settings', newAttempt: true,
        request: { sourceId: metadata.sourceId, method: 'session/selectModel', params: { sessionId: metadata.nativeId,
          provider: metadata.engine, model, ...(typeof effort === 'string' ? { reasoningEffort: effort } : {}) } } })
      if (result.phase !== 'accepted') throw new Error(result.outcome?.message ?? 'The source has not confirmed this model selection.')
      await refresh(); return true
    } catch (failure) { if (alive.current) setError(failure instanceof Error ? failure.message : String(failure)); return false }
    finally { if (alive.current) setBusy(false) }
  }
  const resume = async () => {
    const original = actions.get(metadata.id, 'settings')
    if (busy || original?.phase !== 'prepared' || sourceIsOffline(metadata) || metadata.status === 'running') return
    setBusy(true); setError(null)
    try { await actions.submit({ sessionId: original.sessionId, intent: original.intent, kind: original.kind, request: original.request }) }
    catch (failure) { if (alive.current) setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { if (alive.current) setBusy(false); await refresh() }
  }
  return <SourceControls ctx={ctx} props={props}
    initial={{ model: rawModel, effort: current?.reasoningEffort ?? null, permission: null, serviceTier: null, collaboration: null }}
    permissionCapable={false} data={data} loading={loading} busy={busy} pending={pendingAction ? {
      operationId: pendingAction.request.operationId, change: { kind: 'model', value: String(pendingAction.request.params?.model ?? '') },
    } : null} error={error} sourceLocked={sourceIsOffline(metadata) || metadata.status === 'running'} refresh={refresh} apply={apply}
    {...(pendingAction?.phase === 'prepared' ? { resume } : {})}/>
}
