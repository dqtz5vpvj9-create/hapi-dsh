import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { sessionResourceId, type WorkspaceController, type WorkspaceHost } from './controller.ts'
import { RemoteCreateSessionForm, useCreationCatalog, type CreationCatalogState } from './remote-create-session.tsx'
import { DshSessionForm } from './dsh-session.tsx'
import { CreationChoice } from './source-create-choice.tsx'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { isSourceSessionId, parseSourceSessionId } from '../remote/protocol.ts'
import { en, zh as chinese, readableEngine, readableHost, type WorkspaceTranslate } from './locales.ts'
import type { SourceDirectoryIdentity } from '../workspace/source-api.ts'

function HostCreation({ controller, host, engine, language, catalog, setBusy }: {
    controller: WorkspaceController; host: WorkspaceHost; engine: string; language: string; catalog: CreationCatalogState; setBusy(busy: boolean): void
}) {
    const owner = host.sourceCreation!
    // createController follows the authenticated owner; do not memoize across it.
    useSyncExternalStore(owner.list.subscribe, owner.list.getSnapshot)
    const legacy = owner.createController(), old = useSyncExternalStore(legacy.subscribe, legacy.getSnapshot)
    // Keep existing unresolved/accepted requests reachable on their own Agent.
    // Another Agent has a separate intent and cannot replace an unknown write.
    const choice = useRef<{ legacy: typeof legacy; creation: typeof legacy } | null>(null)
    if (!old.loading && choice.current?.legacy !== legacy) choice.current = {
        legacy, creation: old.record?.source.engine === engine ? legacy : owner.createController(`new-session:${engine}`),
    }
    const context = controller.getSnapshot().creationContext
    const sourceLabels = Object.fromEntries((catalog.catalog?.sources ?? []).map(source => [source.id,
        readableHost(controller.host(source.machineId)?.label || controller.getSnapshot().machines.find(machine => machine.id === source.machineId)?.label)]))
    const original = context?.hostId === host.id && context.sourceSessionId && isSourceSessionId(context.sourceSessionId)
        ? parseSourceSessionId(context.sourceSessionId) : undefined
    const originalSource = original?.engine === engine && catalog.catalog?.sources.find(source => source.id === original.sourceId
        && source.machineId === original.machineId && source.engine === original.engine)
    const browse = useCallback((source: SourceDirectoryIdentity, path: string | undefined, signal: AbortSignal) => controller.listSourceDirectories(host.id, source, path, signal), [controller, host])
    if (old.loading || !choice.current) return <p role="status">{language.startsWith('zh') ? '正在准备新建聊天…' : 'Preparing conversation…'}</p>
    const creation = choice.current.creation
    return <RemoteCreateSessionForm api={owner.api} access={undefined} creation={creation} catalogState={catalog} sourceEngine={engine} sourceLabels={sourceLabels} onBusyChange={setBusy}
        browseDirectories={browse}
        language={language} {...(original?.engine === engine ? { initialSourceId: original.sourceId } : {})}
        {...(originalSource && context?.hostId === host.id ? { initialDirectory: context.directory } : {})}
        close={controller.closeNewSession} open={async (session, isCurrent) => {
            const current = () => isCurrent() && controller.host(host.id) === host
            if (!current()) throw new Error('This creation view was closed or replaced.')
            if (host.sessions.resolveSession) await host.sessions.resolveSession(session.id as Parameters<NonNullable<typeof host.sessions.resolveSession>>[0], new AbortController().signal)
            if (!current()) throw new Error('This creation view was closed or replaced.')
            controller.openCreatedSession(sessionResourceId(host.id, session.id))
        }}/>
}

function HostAgentForm({ controller, host, language, agent, setAgent, busy, setBusy }: {
    controller: WorkspaceController; host: WorkspaceHost; language: string; agent: string; setAgent(agent: string): void; busy: boolean; setBusy(busy: boolean): void
}) {
    const catalog = useCreationCatalog(host.sourceCreation?.api, language), zh = language.startsWith('zh')
    const dsh = !!host.workspaces && typeof host.sessions.create === 'function'
    const engines = [...new Set(catalog.catalog?.sources.map(source => source.engine) ?? [])]
    const available = engines.filter(engine => catalog.catalog!.sources.some(source => source.engine === engine && source.online && source.create))
    useEffect(() => {
        if (agent || catalog.loading || catalog.error) return
        setAgent(available[0] ? `source:${available[0]}` : dsh ? 'dsh' : '')
    }, [agent, catalog.catalog, catalog.loading, catalog.error, dsh, setAgent])
    const engine = agent.startsWith('source:') ? agent.slice(7) : ''
    const options = engines.map(value => ({ id: `source:${value}`, label: readableEngine(value) + (available.includes(value) ? '' : zh ? '（暂不可用）' : ' (unavailable)') }))
    if (engine && !engines.includes(engine)) options.push({ id: agent, label: `${readableEngine(engine)}${zh ? '（此机器不可用）' : ' (unavailable on this machine)'}` })
    if (dsh) options.push({ id: 'dsh', label: 'DSH' })
    else if (agent === 'dsh') options.push({ id: 'dsh', label: zh ? 'DSH（此机器不可用）' : 'DSH (unavailable on this machine)' })
    const context = controller.getSnapshot().creationContext
    const t: WorkspaceTranslate = key => (zh ? chinese : en)[key]
    return <>
        <CreationChoice label="Agent" value={agent} disabled={busy || catalog.loading} placeholder={catalog.loading ? (zh ? '正在加载 Agent…' : 'Loading Agents…') : (zh ? '选择 Agent' : 'Choose an Agent')}
            options={options} onChange={setAgent}/>
        {catalog.error && <div className="hhpi-create-empty"><p role="alert">{catalog.error}</p><Button type="button" onClick={() => { void catalog.refresh() }}>{zh ? '重试' : 'Retry'}</Button></div>}
        {agent === 'dsh' && dsh ? <DshSessionForm key={`${host.id}:dsh`} controller={controller} close={controller.closeNewSession} t={t} selectedHostId={host.id}
            initialDirectory={context?.hostId === host.id && (!context.sourceSessionId || !isSourceSessionId(context.sourceSessionId)) ? context.directory : ''} onPendingChange={setBusy}/>
            : engine && available.includes(engine) && host.sourceCreation ? <HostCreation key={`${host.id}:${engine}`} controller={controller} host={host} engine={engine} language={language} catalog={catalog} setBusy={setBusy}/>
                : !catalog.loading && !catalog.error && <div className="hhpi-create-empty"><p role="status">{agent
                    ? (zh ? `这台机器目前无法新建 ${agent === 'dsh' ? 'DSH' : readableEngine(engine)} 聊天。请选择其他 Agent 或机器。` : `This machine cannot create ${agent === 'dsh' ? 'DSH' : readableEngine(engine)} conversations. Choose another Agent or machine.`)
                    : (zh ? '这台机器暂无可用的聊天 Agent，请选择其他机器。' : 'No conversation Agent is available on this machine. Choose another machine.')}</p>
                    <div className="hapi-button-row"><Button type="button" onClick={controller.closeNewSession}>{zh ? '取消' : 'Cancel'}</Button>
                        <Button type="button" onClick={() => { void (host.sourceCreation ? catalog.refresh() : controller.refresh()) }}>{zh ? '重试' : 'Retry'}</Button></div></div>}
    </>
}

/** One machine/Agent/directory flow; changing machines never silently changes an Agent. */
export function SourceCreateDialog({ controller, language }: { controller: WorkspaceController; language: string }) {
    const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
    const [hostId, setHostId] = useState(snapshot.creationContext?.hostId ?? 'local')
    const [agent, setAgent] = useState(() => snapshot.creation === 'dsh' ? 'dsh'
        : snapshot.creationContext?.sourceSessionId && isSourceSessionId(snapshot.creationContext.sourceSessionId)
            ? `source:${parseSourceSessionId(snapshot.creationContext.sourceSessionId).engine}` : snapshot.creation === 'codex' ? 'source:codex' : '')
    const [busy, setBusy] = useState(false)
    const hosts = controller.availableHosts(), host = controller.host(hostId), zh = language.startsWith('zh')
    return <div className="hhpi-source-create">
        <CreationChoice label={zh ? '机器' : 'Machine'} value={hostId} disabled={busy} placeholder={zh ? '选择机器' : 'Choose a machine'}
            options={hosts.map(value => ({ id: value.id, label: value.id === 'local' ? (zh ? '当前机器' : 'Current machine') : value.label }))}
            onChange={setHostId}/>
        {host ? <HostAgentForm key={hostId} controller={controller} host={host} language={language} agent={agent} setAgent={setAgent} busy={busy} setBusy={setBusy}/>
            : <p role="status">{zh ? '这台机器已断开，请重新连接或选择其他机器。' : 'This machine disconnected. Reconnect or choose another machine.'}</p>}
    </div>
}
