/** Native search/history use the actual Conversation binding and official retained sidebar tabs. */
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from './source-workspace-client.ts'
import type {} from './workspace-ui.ts'
import type {} from './composer-picker/slots.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { isSourceSessionId, parseSourceSessionId } from '../remote/protocol.ts'
import { sourceRoute } from '../shared/source-capability.ts'
import type { AppTarget } from '../workspace/app-service-types.ts'
import type { AppTargetPane } from './app-target-navigation.ts'
import { NativeSourceSearch, type NativeHistoryTarget } from './sidebar-search-query.ts'
import { NativeSourceSearchPanel } from './sidebar-search-controls.tsx'
import { NativeThreadHistory, RemoteNativeHistoryPanel, nativeHistoryStyles } from './remote-native-history.tsx'
import { useWorkspacePane } from './surface/pane-context.tsx'
import type { SourceReadingCommit } from './source-reading-commit.ts'

export const SOURCE_NATIVE_NAVIGATION_KIND = 'hhpi-native-navigation'
export const SOURCE_NATIVE_NAVIGATION_ID = 'hapi-dsh/native-navigation'
declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
    interface SidebarRightTabParamsMap { 'hhpi-native-navigation': { recordId: string; mode: 'search' | 'tasks' } }
}
type Access = ReturnType<Context['hhpiSessions']['captureWorkspaceAccess']>
interface Owner {
    id: string; hostId: string; sessionId: string; access: Access; search: NativeSourceSearch; history: NativeThreadHistory
    origin: NativeHistoryTarget; destination?: AppTargetPane | undefined; active(): boolean; subscribe(listener: () => void): () => void; dispose(): void
}
// A Conversation and its plugin view use distinct official Contexts. The
// opaque record transfers only this exact live owner; every receiving graph
// must independently prove the same authenticated Host/source/account scope.
const navigationOwners = new Map<string, Owner>()
export interface SourceNativeNavigationOptions {
    hostId: string
    /** The shared directory is explicit; a foreign graph must not borrow its root Context. */
    workspace?: import('./controller.ts').WorkspaceController
    /** Root supplies its exact original-source resolver and workspace navigation. */
    navigate(target: AppTarget, signal: AbortSignal, destination?: AppTargetPane): Promise<void>
}
export function installSourceNativeNavigation(ctx: Context, options: SourceNativeNavigationOptions): () => void {
    const lifetime = new AbortController(), owners = new Map<string, Owner>(), retained = new Map<string, Owner>()
    const committed = new Map<string, { position: SourceReadingCommit['position']; binding: WeakRef<SourceReadingCommit['sessionBinding']>; access: Access; release(): void }>()
    const readingKey = (paneId: string, sessionId: string) => JSON.stringify([paneId, sessionId])
    // Observe before the More popup mounts; a stationary reader need not emit
    // another sample merely because its navigation menu was opened.
    const stopReading = ctx.hapiWorkspaceUi.readCommits.subscribe(value => {
        if (value.hostId !== options.hostId || !isSourceSessionId(value.sessionBinding.sessionId)
            || !ctx.hhpiSessions.ownsBinding(value.sessionBinding)) return
        let access: Access
        try { access = ctx.hhpiSessions.captureWorkspaceAccess(value.sessionBinding.sessionId); access.assertCurrent() } catch { return }
        const key = readingKey(value.paneId, value.sessionBinding.sessionId)
        committed.get(key)?.release()
        const remove = () => { if (committed.get(key) === sample) committed.delete(key); sample.release() }
        const sample = { position: value.position, binding: new WeakRef(value.sessionBinding), access, release() { access.signal.removeEventListener('abort', remove) } }
        committed.delete(key); committed.set(key, sample); access.signal.addEventListener('abort', remove, { once: true })
        if (committed.size > 128) { const first = committed.keys().next().value!; committed.get(first)!.release(); committed.delete(first) }
    })
    const acquire = (sessionId: string, paneId: string | undefined, access: Access): Owner => {
        access.assertCurrent()
        const key = JSON.stringify([access.scope, options.hostId, sessionId, paneId]), previous = retained.get(key)
        if (previous?.active()) return previous
        const identity = parseSourceSessionId(sessionId), route = { hostId: options.hostId, machineId: identity.machineId, sourceId: identity.sourceId, engine: identity.engine }
        const listeners = new Set<() => void>(), signal = AbortSignal.any([lifetime.signal, access.signal])
        let active = true
        const current = () => { try { access.assertCurrent(); return active && !signal.aborted } catch { return false } }
        const search = new NativeSourceSearch(route, ctx.remote.hhpi, current), history = new NativeThreadHistory(route, ctx.remote.hhpi, current)
        const owner: Owner = { id: crypto.randomUUID(), hostId: options.hostId, sessionId, access, search, history, origin: { hostId: options.hostId, sessionId }, active: current,
            subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
            dispose() { if (!active) return; active = false; signal.removeEventListener('abort', owner.dispose); search.dispose(); history.dispose()
                retained.delete(key); navigationOwners.delete(owner.id); for (const listener of [...listeners]) listener(); listeners.clear() },
        }
        owners.set(owner.id, owner); navigationOwners.set(owner.id, owner); retained.set(key, owner); signal.addEventListener('abort', owner.dispose, { once: true })
        return owner
    }
    const useLanguage = () => useSyncExternalStore(listener => ctx.locale.subscribe(listener), () => ctx.locale.getSnapshot().active)
    const Entry = (entry: PropsRuntime<'hapi.source.composer-navigation'>) => {
        const props = entry.source
        const pane = useWorkspacePane(ctx), lang = useLanguage(), zh = lang.startsWith('zh'), [error, setError] = useState('')
        const binding = props.sessionBinding ?? ctx.sessions.binding(props.sessionId)
        const visible = useSyncExternalStore(listener => pane?.state.subscribe(listener) ?? (() => {}), () => pane?.state.getSnapshot().visible ?? true)
        if (!visible || !isSourceSessionId(props.sessionId) || parseSourceSessionId(props.sessionId).engine !== 'codex') return null
        const open = (mode: 'search' | 'tasks', scope: 'source' | 'conversation' = 'source') => {
            setError('')
            try {
                const access = ctx.hhpiSessions.captureWorkspaceAccess(props.sessionId)
                if (pane && pane.hostId !== options.hostId) throw new Error('This conversation belongs to another Host.')
                const owner = acquire(props.sessionId, pane?.paneId, access)
                const sample = pane && committed.get(readingKey(pane.paneId, props.sessionId))
                const commit = sample && sample.access.scope === access.scope && !sample.access.signal.aborted && sample.binding.deref() === binding ? sample : undefined
                owner.origin = { hostId: options.hostId, sessionId: props.sessionId, ...(commit ? { position: commit.position } : {}) }
                owner.destination = pane ? { hostId: pane.hostId, paneId: pane.paneId, sessionId: props.sessionId } : undefined
                if (mode === 'search') owner.search.setScope(scope)
                const params = { recordId: owner.id, mode }
                if (pane) pane.openTab(SOURCE_NATIVE_NAVIGATION_KIND, { params })
                else ctx.sidebarRight.openTabIn(props.sessionId, SOURCE_NATIVE_NAVIGATION_KIND, { params })
                entry.onClose()
            } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
        }
        return <span className="hhpi-native-navigation-entry"><button type="button" onClick={() => open('search', 'conversation')}>{zh ? '搜索当前会话' : 'Search this conversation'}</button>
            <button type="button" onClick={() => open('search')}>{zh ? '搜索来源正文' : 'Search source history'}</button>
            <button type="button" onClick={() => open('tasks')}>{zh ? '父子任务' : 'Related tasks'}</button>{error && <span role="alert">{error}</span>}</span>
    }
    const ActiveBody = ({ owner, access, props }: { owner: Owner; access: Access; props: PropsRuntime<'sidebar.right.pane.tab'> }) => {
        const { tab } = props.useTabInfo(), lang = useLanguage(), zh = lang.startsWith('zh')
        const params = tab.navigation.params, initial = params && 'mode' in params && params.mode === 'tasks' ? 'tasks' : 'search'
        const [mode, setMode] = useState<'search' | 'tasks'>(initial)
        const active = useSyncExternalStore(listener => {
            const stop = owner.subscribe(listener)
            access.signal.addEventListener('abort', listener, { once: true })
            return () => { stop(); access.signal.removeEventListener('abort', listener) }
        }, () => { try { access.assertCurrent(); return owner.active() } catch { return false } })
        useEffect(() => { setMode(initial) }, [initial, tab.navigation.revision])
        const open = async (target: NativeHistoryTarget) => {
            owner.access.assertCurrent()
            access.assertCurrent()
            if (!owner.active() || tab.signal.aborted) throw new Error('The source history view was released.')
            const expected = parseSourceSessionId(owner.sessionId), actual = parseSourceSessionId(target.sessionId)
            if (target.hostId !== options.hostId || actual.machineId !== expected.machineId || actual.sourceId !== expected.sourceId || actual.engine !== expected.engine) throw new Error('This target belongs to another original source.')
            const source = sourceRoute(options.hostId, target.sessionId, 'local'), signal = AbortSignal.any([lifetime.signal, owner.access.signal, access.signal, tab.signal])
            const destination = owner.destination
            await options.navigate(target.position ? { kind: 'reading', source, position: target.position } : { kind: 'session', source }, signal, destination)
            signal.throwIfAborted(); owner.access.assertCurrent(); access.assertCurrent()
            if (destination) owner.destination = { ...destination, sessionId: target.sessionId }
        }
        if (!active) return <p role="alert">{zh ? '来源账号或权限已变化。请从当前会话重新打开历史入口。' : 'The source account or permission changed. Open history again from its current conversation.'}</p>
        return <div className="hhpi-native-navigation"><nav aria-label={zh ? '来源历史视图' : 'Source history views'}>
            <button type="button" aria-pressed={mode === 'search'} onClick={() => setMode('search')}>{zh ? '正文搜索' : 'Message search'}</button>
            <button type="button" aria-pressed={mode === 'tasks'} onClick={() => setMode('tasks')}>{zh ? '父子任务' : 'Related tasks'}</button>
        </nav><div hidden={mode !== 'search'}><NativeSourceSearchPanel controller={owner.search} open={open} origin={owner.origin} conversationSessionId={owner.sessionId} language={lang}/></div>
            <div hidden={mode !== 'tasks'}><RemoteNativeHistoryPanel controller={owner.history} threadId={parseSourceSessionId(owner.sessionId).nativeId}
                open={open} origin={owner.origin} language={lang} active={mode === 'tasks' && tab.visible}/></div></div>
    }
    const Body = (props: PropsRuntime<'sidebar.right.pane.tab'>) => {
        const lang = useLanguage()
        const { tab } = props.useTabInfo(), params = tab.navigation.params, id = params && 'recordId' in params ? params.recordId : undefined
        const resolved = useMemo(() => {
            const owner = typeof id === 'string' ? navigationOwners.get(id) : undefined
            if (!owner || owner.hostId !== options.hostId || owner.sessionId !== props.sessionId) return undefined
            try {
                const access = ctx.hhpiSessions.captureWorkspaceAccess(props.sessionId)
                owner.access.assertCurrent(); access.assertCurrent()
                return access.scope === owner.access.scope ? { owner, access } : undefined
            } catch { return undefined }
        }, [id, props.sessionId])
        return resolved ? <ActiveBody key={resolved.owner.id} {...resolved} props={props}/>
            : <p role="alert">{lang.startsWith('zh') ? '请从此来源的当前会话打开搜索或父子任务。' : 'Open search or related tasks from this source’s current conversation.'}</p>
    }
    const stops = [ctx.sidebarRightTabs.register({ id: SOURCE_NATIVE_NAVIGATION_ID, kind: SOURCE_NATIVE_NAVIGATION_KIND, keepMounted: true,
        title: () => ctx.locale.getSnapshot().active.startsWith('zh') ? '来源历史' : 'Source history' }),
        ctx.slots.inject('hapi.source.composer-navigation', () => ctx.slots.register({ name: 'hapi.source.composer-navigation', id: 'hhpi.native-navigation', order: 35 }, Entry)),
        ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: SOURCE_NATIVE_NAVIGATION_ID }, Body))]
    const style = document.createElement('style'); style.textContent = nativeHistoryStyles + '.hhpi-native-navigation-entry{display:inline-flex;gap:4px;flex-wrap:wrap}.hhpi-native-navigation-entry button,.hhpi-native-navigation nav button{font:inherit;color:inherit;background:transparent;border:1px solid var(--dsw-alias-border-l1,#8884);border-radius:6px;padding:4px 7px;cursor:pointer}.hhpi-native-navigation [hidden]{display:none}.hhpi-native-navigation nav{display:flex;gap:6px;padding:8px}'
    document.head.append(style)
    return () => { lifetime.abort(); stopReading(); for (const sample of committed.values()) sample.release(); committed.clear()
        for (const stop of stops.reverse()) stop(); for (const owner of owners.values()) owner.dispose(); owners.clear(); retained.clear(); style.remove() }
}
