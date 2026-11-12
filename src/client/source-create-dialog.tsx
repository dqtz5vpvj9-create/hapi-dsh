import { useState, useSyncExternalStore } from 'react'
import { sessionResourceId, type WorkspaceController, type WorkspaceHost } from './controller.ts'
import { RemoteCreateSessionForm } from './remote-create-session.tsx'
import { CreationChoice } from './source-create-choice.tsx'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { isSourceSessionId, parseSourceSessionId } from '../remote/protocol.ts'

function HostCreation({ controller, host, language }: { controller: WorkspaceController; host: WorkspaceHost; language: string }) {
    const owner = host.sourceCreation!
    // Authentication changes replace the intent owner, even while the modal stays open.
    useSyncExternalStore(owner.list.subscribe, owner.list.getSnapshot)
    const creation = owner.createController()
    const context = controller.getSnapshot().creationContext
    const original = context?.hostId === host.id && context.sourceSessionId && isSourceSessionId(context.sourceSessionId)
        ? parseSourceSessionId(context.sourceSessionId) : undefined
    return <RemoteCreateSessionForm api={owner.api} access={undefined} creation={creation}
        language={language} {...(original ? { initialSourceId: original.sourceId } : {})}
        {...(context?.hostId === host.id ? { initialDirectory: context.directory } : {})}
        createDsh={() => controller.requestNewSession('dsh', { hostId: host.id, directory: context?.hostId === host.id ? context.directory : '' })}
        close={controller.closeNewSession} open={async session => {
            if (controller.host(host.id) !== host) throw new Error(language.startsWith('zh') ? '此机器连接已改变，请重新打开已创建的会话。' : 'This Host connection changed. Reopen the created conversation.')
            if (host.sessions.resolveSession) await host.sessions.resolveSession(session.id as Parameters<NonNullable<typeof host.sessions.resolveSession>>[0], new AbortController().signal)
            if (controller.host(host.id) !== host) throw new Error(language.startsWith('zh') ? '此机器连接已改变，请重新打开已创建的会话。' : 'This Host connection changed. Reopen the created conversation.')
            controller.openCreatedSession(sessionResourceId(host.id, session.id))
        }}/>
}

/** The selected Host owns both the source directory and creation receipt. */
export function SourceCreateDialog({ controller, language }: { controller: WorkspaceController; language: string }) {
    const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
    const [hostId, setHostId] = useState(snapshot.creationContext?.hostId ?? 'local')
    const hosts = controller.availableHosts()
    const host = controller.host(hostId)
    const zh = language.startsWith('zh')
    return <div className="hhpi-source-create">
        <CreationChoice label={zh ? '机器' : 'Host'} value={hostId} placeholder={zh ? '选择机器' : 'Choose a Host'}
            options={hosts.map(value => ({ id: value.id, label: value.id === 'local' ? (zh ? '当前 Host' : 'Current Host') : value.label }))}
            onChange={setHostId}/>
        {host?.sourceCreation ? <HostCreation key={hostId} controller={controller} host={host} language={language}/>
            : <div className="hhpi-create-empty"><p role="status">{zh ? '此机器的原生来源暂未连接。请选择其他机器，或在此机器新建 DSH 聊天。' : 'Native sources on this Host are not connected. Choose another Host or create a DSH conversation here.'}</p>
                <div className="hapi-button-row"><Button type="button" onClick={controller.closeNewSession}>{zh ? '取消' : 'Cancel'}</Button>
                    {host && <Button type="button" variant="primary" onClick={() => controller.requestNewSession('dsh', { hostId, directory: snapshot.creationContext?.hostId === hostId ? snapshot.creationContext.directory : '' })}>{zh ? '新建 DSH 聊天' : 'New DSH conversation'}</Button>}</div></div>}
    </div>
}
