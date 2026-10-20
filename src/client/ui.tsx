import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import { filterSessions, sessionLocation, type WorkspaceController } from './controller.ts'
import type { WorkspaceKey, WorkspaceTranslate } from './locales.ts'
import { paneRectangles, panes, splitBoundaries, type PaneNode, type SplitBoundary, type WorkspaceWindow } from './model.ts'
import { NativeActions } from './native-actions.tsx'
import { PrefixKeys, runWorkspaceCommand } from './shortcuts.ts'
import type { ConversationPaneProps, SessionSidebarProps, WorkspaceRootProps } from './slots.ts'
import { NativeSessionForm } from './new-session.tsx'
import { NativeForkContent } from './native-controls.tsx'
import { DshSessionForm } from './dsh-session.tsx'

export function WorkspaceIcon({ kind, size = 16 }: { kind: 'horizontal' | 'vertical' | 'add' | 'close' | 'zoom' | 'grid' | 'restore' | 'more' | 'search' | 'refresh' | 'sidebar' | 'help'; size?: number }) {
    const paths = {
        horizontal: 'M3 3h18v18H3zM12 3v18', vertical: 'M3 3h18v18H3zM3 12h18',
        add: 'M12 5v14M5 12h14', close: 'm6 6 12 12M6 18 18 6', zoom: 'M8 3H3v5M16 3h5v5M21 16v5h-5M8 21H3v-5',
        grid: 'M3 3h18v18H3zM12 3v18M3 12h18', restore: 'M3 10a9 9 0 1 1 2 9M3 3v7h7',
        more: 'M5 12h.01M12 12h.01M19 12h.01', search: 'M20 20l-5-5M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0',
        refresh: 'M20 7a9 9 0 0 0-16 2M20 3v5h-5M4 17a9 9 0 0 0 16-2M4 21v-5h5',
        sidebar: 'M3 3h18v18H3zM9 3v18', help: 'M9 9a3 3 0 0 1 6 0c0 2-3 2-3 5M12 18h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
    }
    return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[kind]}/></svg>
}

function IconButton({ label, icon, onClick, disabled = false, pressed }: {
    label: string; icon: Parameters<typeof WorkspaceIcon>[0]['kind']; onClick: () => void; disabled?: boolean; pressed?: boolean
}) {
    return <button type="button" className="hapi-icon-button" title={label} aria-label={label} onClick={onClick} disabled={disabled} aria-pressed={pressed}><WorkspaceIcon kind={icon}/></button>
}

export function Dialog({ title, children, close, t }: { title: string; children: ReactNode; close: () => void; t: WorkspaceTranslate }) {
    const ref = useRef<HTMLDialogElement>(null)
    useEffect(() => {
        const dialog = ref.current
        dialog?.showModal()
        return () => { dialog?.close() }
    }, [])
    return <dialog ref={ref} className="hapi-dialog" aria-label={title} onCancel={event => { event.preventDefault(); close() }}>
        <header><h2>{title}</h2><IconButton label={t('dismiss')} icon="close" onClick={close}/></header>
        {children}
    </dialog>
}

function RenameDialog({ title, initial, save, close, t }: {
    title: string; initial: string; save: (value: string) => Promise<void> | void; close: () => void; t: WorkspaceTranslate
}) {
    const [value, setValue] = useState(initial)
    const [pending, setPending] = useState(false)
    const [error, setError] = useState<string | null>(null)
    return <Dialog title={title} close={close} t={t}><form onSubmit={event => {
        event.preventDefault()
        if (pending || !value.trim()) return
        setPending(true)
        void Promise.resolve().then(() => save(value)).then(close, error => setError(error instanceof Error ? error.message : String(error))).finally(() => setPending(false))
    }}>
        <label>{t('name')}<input autoFocus maxLength={200} value={value} onChange={event => setValue(event.currentTarget.value)} disabled={pending}/></label>
        {error && <p className="hapi-error" role="alert">{error}</p>}
        <div className="hapi-button-row"><button type="button" onClick={close}>{t('cancel')}</button><button type="submit" disabled={pending || !value.trim()}>{t('save')}</button></div>
    </form></Dialog>
}

/** The Conversation is assembled by the official factory with this pane's real Session binding. */
export function ConversationPane({ sessionId, useSession, useConversation, useSessions, useProjection, renderFactorySlot, native, t }: ConversationPaneProps) {
    const session = useSession(value => value)
    const conversation = useConversation(value => value)
    const projection = useProjection('hapi')
    const summaryBlank = useSessions(state => state.byId[sessionId]?.blank)
    // Native Codex already owns its machine/directory. An empty native thread
    // must not enter DSH's hero flow, which requires a local Host Workspace.
    const active = Boolean(projection) || conversation.activeTargets.size > 0 || (!session.blank && !session.awaitingFirstTurn) || session.running
    const shellPhase = active ? 'active' : session.promptAttempted ? 'engaging' : 'blank'
    const parentPending = session.subagent?.address.mode === 'continuable' && session.subagent.parentAvailable === undefined
    const settling = (shellPhase === 'blank' && session.openState === 'loading' && summaryBlank !== true) || parentPending
    const hero = shellPhase === 'blank' && (session.openState === 'open' || summaryBlank === true)
    return <div className={`hapi-conversation${projection ? ' hapi-conversation-native' : ''}`} data-native-display={projection ? sessionId : undefined}>
        {projection && native.branchLabel && <style>{`.hapi-conversation-native[data-native-display="${CSS.escape(sessionId)}"] [data-turn-tail] [data-clock="end"] button[aria-label="${CSS.escape(native.branchLabel())}"]{display:none!important}`}</style>}
        <div className="hapi-conversation-content">{renderFactorySlot('conversation.content', { variant: 'embedded', phase: settling ? 'settling' : hero ? 'hero' : 'active', hero })}</div>
        <NativeActions sessionId={sessionId} projection={projection} api={native} t={t}/>
    </div>
}

function ResizeHandle({ boundary, controller, stage, t }: { boundary: SplitBoundary; controller: WorkspaceController; stage: HTMLDivElement | null; t: WorkspaceTranslate }) {
    const drag = useRef<{ pointerId: number; coordinate: number; pixels: number; left: number; right: number } | null>(null)
    const horizontal = boundary.axis === 'horizontal'
    const style: CSSProperties = horizontal
        ? { left: `${boundary.position}%`, top: `${boundary.crossStart}%`, height: `${boundary.crossSize}%` }
        : { top: `${boundary.position}%`, left: `${boundary.crossStart}%`, width: `${boundary.crossSize}%` }
    const ratio = boundary.leftWeight / (boundary.leftWeight + boundary.rightWeight)
    return <div className={`hapi-resize ${horizontal ? 'hapi-resize-horizontal' : 'hapi-resize-vertical'}`} style={style}
        role="separator" tabIndex={0} aria-label={t('resize')} aria-orientation={horizontal ? 'vertical' : 'horizontal'}
        aria-valuemin={8} aria-valuemax={92} aria-valuenow={Math.round(ratio * 100)} title={t('resizeHelp')}
        onPointerDown={event => {
            if (event.button !== 0 || !stage) return
            const rect = stage.getBoundingClientRect()
            const pixels = (horizontal ? rect.width : rect.height) * boundary.pairSize / 100
            if (pixels <= 0) return
            event.preventDefault()
            event.currentTarget.setPointerCapture(event.pointerId)
            drag.current = { pointerId: event.pointerId, coordinate: horizontal ? event.clientX : event.clientY, pixels, left: boundary.leftWeight, right: boundary.rightWeight }
        }}
        onPointerMove={event => {
            const current = drag.current
            if (!current || current.pointerId !== event.pointerId) return
            const delta = ((horizontal ? event.clientX : event.clientY) - current.coordinate) / current.pixels * (current.left + current.right)
            const left = Math.max((current.left + current.right) * 0.08, Math.min((current.left + current.right) * 0.92, current.left + delta))
            controller.store.resize(boundary.splitId, boundary.boundary, left, current.left + current.right - left)
        }}
        onPointerUp={event => { if (drag.current?.pointerId === event.pointerId) { drag.current = null; event.currentTarget.releasePointerCapture(event.pointerId) } }}
        onPointerCancel={() => { drag.current = null }}
        onDoubleClick={() => controller.store.resize(boundary.splitId, boundary.boundary, 1, 1)}
        onKeyDown={event => {
            const increase = horizontal ? event.key === 'ArrowRight' : event.key === 'ArrowDown'
            const decrease = horizontal ? event.key === 'ArrowLeft' : event.key === 'ArrowUp'
            if (!increase && !decrease) return
            event.preventDefault()
            const delta = (increase ? 1 : -1) * (event.shiftKey ? 0.1 : 0.02)
            const value = Math.max(0.08, Math.min(0.92, ratio + delta))
            const total = boundary.leftWeight + boundary.rightWeight
            controller.store.resize(boundary.splitId, boundary.boundary, total * value, total * (1 - value))
        }}/>
}

function WorkspacePane({ pane, window, focused, hidden, style, controller, bind, create, t }: {
    pane: PaneNode; window: WorkspaceWindow; focused: boolean; hidden: boolean; style: CSSProperties;
    controller: WorkspaceController; bind: (pane: PaneNode) => ReactNode; create: () => void; t: WorkspaceTranslate
}) {
    const snapshot = controller.getSnapshot()
    const summary = pane.resource.kind === 'chat' ? snapshot.catalog.byId[pane.resource.sessionId as keyof typeof snapshot.catalog.byId] : undefined
    const location = sessionLocation(summary)
    const lease = snapshot.leases.get(pane.id)
    return <section className={`hapi-pane${focused ? ' hapi-pane-focused' : ''}`} style={{ ...style, ...(hidden ? { visibility: 'hidden', pointerEvents: 'none' } : {}) }}
        data-pane-id={pane.id} data-session-id={pane.resource.kind === 'chat' ? pane.resource.sessionId : ''} aria-hidden={hidden}
        aria-label={`${t('pane')}: ${summary?.displayTitle ?? t('chooseSession')}`} tabIndex={focused && !hidden ? 0 : -1}
        onFocusCapture={() => controller.store.focus(pane.id)} onPointerDownCapture={() => controller.store.focus(pane.id)}>
        <header className="hapi-pane-header">
            <span className={`hapi-dot${summary?.running ? ' hapi-dot-running' : ''}`} title={t(summary?.running ? 'running' : 'idle')}/>
            <span className="hapi-pane-title" title={summary?.cwd ?? summary?.displayTitle}>{summary?.displayTitle ?? t('chooseSession')}</span>
            {summary && <span className="hapi-pane-source" title={[location.machineName, location.machineId, location.nativeId].filter(Boolean).join(' · ')}>{location.machineName ? `${location.machineName} · ` : ''}{location.engine.toUpperCase()}</span>}
            <details className="hapi-menu"><summary title={t('more')} aria-label={t('more')}><WorkspaceIcon kind="more"/></summary>
                <div className="hapi-menu-content">
                    <button type="button" onClick={() => { controller.store.focus(pane.id); controller.store.split('horizontal') }}>{t('splitHorizontal')}</button>
                    <button type="button" onClick={() => { controller.store.focus(pane.id); controller.store.split('vertical') }}>{t('splitVertical')}</button>
                    <button type="button" onClick={() => { controller.store.focus(pane.id); controller.store.toggleZoom() }}>{t(snapshot.layout.zoomed[window.id] ? 'unzoom' : 'zoom')}</button>
                    {snapshot.layout.windows.filter(other => other.id !== window.id).map(other => <button type="button" key={other.id} onClick={() => controller.store.movePane(pane.id, other.id)}>{t('moveTo')} · {other.name}</button>)}
                </div>
            </details>
            <IconButton label={t('closePane')} icon="close" onClick={() => controller.store.closePane(pane.id)}/>
        </header>
        <div className="hapi-pane-body">
            {pane.resource.kind === 'empty' ? <div className="hapi-empty"><WorkspaceIcon kind="grid" size={34}/><h2>{t('chooseSession')}</h2><p>{t('emptyHelp')}</p><button type="button" onClick={create}>{t('newSession')}</button><kbd>Ctrl B → %</kbd></div>
                : lease?.status === 'failed' ? <div className="hapi-empty" role="alert"><h2>{t('openFailed')}</h2><p>{lease.error}</p><button type="button" onClick={() => controller.retryPane(pane.id)}>{t('retry')}</button></div>
                : bind(pane)}
        </div>
    </section>
}

export function WorkspaceRoot({ controller, api, SessionProvider, renderSlot, t }: WorkspaceRootProps) {
    const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
    const { layout } = snapshot
    const [stage, setStage] = useState<HTMLDivElement | null>(null)
    const [help, setHelp] = useState(false)
    const [rename, setRename] = useState<WorkspaceWindow | null>(null)
    const [prefix, setPrefix] = useState(false)
    const active = controller.store.active()
    useEffect(() => {
        const keys = new PrefixKeys()
        let timeout: ReturnType<typeof setTimeout> | undefined
        const clear = (): void => { keys.clear(); setPrefix(false); if (timeout) clearTimeout(timeout) }
        const keydown = (event: KeyboardEvent): void => {
            if (event.target instanceof Element && event.target.closest('dialog[open], [role="dialog"]')) return
            const result = keys.key(event, performance.now())
            setPrefix(result.armed)
            if (timeout) clearTimeout(timeout)
            if (result.armed) timeout = setTimeout(clear, 3000)
            if (result.consumed) { event.preventDefault(); event.stopPropagation() }
            if (result.command) {
                try { runWorkspaceCommand(controller.store, result.command, () => setHelp(true)) }
                catch (error) { controller.report(error) }
            }
        }
        window.addEventListener('keydown', keydown, true)
        window.addEventListener('blur', clear)
        return () => { window.removeEventListener('keydown', keydown, true); window.removeEventListener('blur', clear); if (timeout) clearTimeout(timeout) }
    }, [controller])
    const action = (operation: () => void): void => { try { operation() } catch (error) { controller.report(error) } }
    const bind = (pane: PaneNode): ReactNode => {
        const lease = snapshot.leases.get(pane.id)
        if (!lease?.reference) return <div className="hapi-loading" role="status">{t('loading')}</div>
        if (lease.hostId !== 'local') return controller.host(lease.hostId)?.renderConversation?.(lease.reference, { paneId: pane.id, focused: controller.store.focusedPane().id === pane.id }) ?? null
        return <SessionProvider session={lease.reference}>{renderSlot('hapi.workspace.conversation', {})}</SessionProvider>
    }
    const shortcuts: Array<[string, WorkspaceKey]> = [
        ['%', 'splitHorizontal'], ['"', 'splitVertical'], ['c', 'newWindow'], ['n / p', 'nextWindow'],
        ['o', 'nextPane'], ['← ↑ → ↓', 'focusDirection'], ['z', 'zoom'], ['x', 'closePane'], ['u', 'restoreWindow'], ['1…9', 'windowNumber'],
    ]
    return <div className="hapi-workspace" data-hapi-workspace="">
        <header className="hapi-workspace-toolbar">
            <div className="hapi-workspace-brand"><WorkspaceIcon kind="grid"/><strong>HAPI</strong><span>{active.name}</span></div>
            <div className="hapi-workspace-tools">
                <details className="hapi-menu"><summary aria-label={t('newSession')} title={t('newSession')}><WorkspaceIcon kind="add"/></summary><div className="hapi-menu-content">
                    <button type="button" onClick={() => controller.requestNewSession('dsh')}>DSH · {t('newSession')}</button>
                    <button type="button" onClick={() => controller.requestNewSession('codex')}>Codex · {t('newSession')}</button>
                </div></details>
                <IconButton label={t('splitHorizontal')} icon="horizontal" onClick={() => action(() => controller.store.split('horizontal'))}/>
                <IconButton label={t('splitVertical')} icon="vertical" onClick={() => action(() => controller.store.split('vertical'))}/>
                <IconButton label={t(layout.zoomed[active.id] ? 'unzoom' : 'zoom')} icon="zoom" pressed={layout.zoomed[active.id] === true} onClick={() => controller.store.toggleZoom()}/>
                <IconButton label={t('restoreWindow')} icon="restore" disabled={!controller.store.canRestoreWindow()} onClick={() => action(() => controller.store.restoreWindow())}/>
                <IconButton label={t('shortcuts')} icon="help" onClick={() => setHelp(true)}/>
            </div>
        </header>
        {snapshot.notice && <div className="hapi-notice" role="alert"><span>{snapshot.notice}</span>{snapshot.conflict ? <><button type="button" onClick={() => controller.resolveConflict('local')}>{t('keepLocal')}</button><button type="button" onClick={() => controller.resolveConflict('server')}>{t('useServer')}</button></> : snapshot.persistence === 'failed' && <button type="button" onClick={controller.retryPersistence}>{t('retry')}</button>}<IconButton label={t('dismiss')} icon="close" onClick={controller.clearNotice}/></div>}
        <div className="hapi-workspace-stage" ref={setStage}>
            {layout.windows.map(window => {
                const visible = window.id === layout.activeWindowId
                const focusedId = layout.focused[window.id]
                const zoomed = layout.zoomed[window.id]
                const rectangles = paneRectangles(window.root)
                return <div className={`hapi-window${visible ? ' hapi-window-active' : ''}`} key={window.id} data-window-id={window.id} aria-hidden={!visible}>
                    {panes(window.root).map(pane => {
                        const rectangle = rectangles.find(item => item.id === pane.id)!
                        const focused = pane.id === focusedId
                        const position = zoomed && focused ? { left: 0, top: 0, width: 100, height: 100 } : rectangle
                        return <WorkspacePane key={pane.id} pane={pane} window={window} focused={focused} hidden={!visible || Boolean(zoomed && !focused)}
                            style={{ left: `${position.left}%`, top: `${position.top}%`, width: `${position.width}%`, height: `${position.height}%` }} controller={controller} bind={bind} create={() => controller.requestNewSession()} t={t}/>
                    })}
                    {!zoomed && splitBoundaries(window.root).map(boundary => <ResizeHandle key={`${boundary.splitId}:${boundary.boundary}`} boundary={boundary} controller={controller} stage={stage} t={t}/>)}
                </div>
            })}
        </div>
        <footer className="hapi-statusbar">
            <div role="tablist" aria-label={t('window')} className="hapi-window-tabs">
                {layout.windows.map((window, index) => <button type="button" role="tab" key={window.id} aria-selected={window.id === active.id}
                    className={window.id === active.id ? 'hapi-window-tab-active' : ''} onClick={() => controller.store.selectWindow(window.id)}
                    onDoubleClick={() => setRename(window)} title={`${index + 1}: ${window.name}`}><span>{index + 1}</span>{window.name}<span className="hapi-window-count">{panes(window.root).length}</span></button>)}
            </div>
            <IconButton label={t('newWindow')} icon="add" onClick={() => action(() => { controller.store.createWindow() })}/>
            <details className="hapi-menu hapi-window-menu"><summary title={t('more')} aria-label={t('more')}><WorkspaceIcon kind="more"/></summary><div className="hapi-menu-content">
                <button type="button" onClick={() => setRename(active)}>{t('renameWindow')}</button>
                <button type="button" onClick={() => controller.store.closeWindow(active.id)} title={t('closeHelp')}>{t('closeWindow')}</button>
            </div></details>
            <button type="button" className={`hapi-prefix${prefix ? ' hapi-prefix-active' : ''}`} onClick={() => setHelp(true)}>{t(prefix ? 'prefixReady' : 'prefix')}</button>
            <span className={`hapi-persistence hapi-persistence-${snapshot.persistence}`} title={t(snapshot.persistence)} aria-label={t(snapshot.persistence)}>●</span>
        </footer>
        {rename && <RenameDialog key={rename.id} title={t('renameWindow')} initial={rename.name} save={name => controller.store.renameWindow(rename.id, name)} close={() => setRename(null)} t={t}/>}
        {snapshot.creation === 'choose' && <Dialog title={t('newSession')} close={controller.closeNewSession} t={t}><div className="hapi-new-choice">
            <button type="button" onClick={() => controller.requestNewSession('dsh')}><strong>DSH</strong><span>{t('dshCreateHelp')}</span></button>
            <button type="button" onClick={() => controller.requestNewSession('codex')}><strong>Codex</strong><span>{t('nativeCreateHelp')}</span></button>
        </div></Dialog>}
        {snapshot.creation === 'codex' && <Dialog title={t('nativeNew')} close={controller.closeNewSession} t={t}><NativeSessionForm api={api} controller={controller} close={controller.closeNewSession} t={t}/></Dialog>}
        {snapshot.creation === 'dsh' && <Dialog title={`DSH · ${t('newSession')}`} close={controller.closeNewSession} t={t}><DshSessionForm controller={controller} close={controller.closeNewSession} t={t}/></Dialog>}
        {help && <Dialog title={t('shortcuts')} close={() => setHelp(false)} t={t}><p>{t('shortcutHint')}</p><dl className="hapi-shortcuts">{shortcuts.map(([key, label]) => <div key={key}><dt><kbd>{key}</kbd></dt><dd>{t(label)}</dd></div>)}</dl><p>{t('closeHelp')}</p></Dialog>}
    </div>
}

export function SessionSidebar({ controller, controls, wide, expandSidebar, useWorkspaces, t }: SessionSidebarProps) {
    const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
    const workspaces = useWorkspaces(state => state)
    const [query, setQuery] = useState('')
    const [engine, setEngine] = useState('')
    const [machine, setMachine] = useState('')
    const [archived, setArchived] = useState(false)
    const [rename, setRename] = useState<{ id: string; title: string } | null>(null)
    const [fork, setFork] = useState<{ id: string; sourceId: string } | null>(null)
    const input = useRef<HTMLInputElement>(null)
    const rows = useMemo(() => snapshot.catalog.ids.map(id => snapshot.catalog.byId[id]).filter(row => row !== undefined), [snapshot.catalog])
    const locations = rows.map(sessionLocation)
    const engines = [...new Set(locations.map(location => location.engine))].sort()
    const machines = [...new Map(locations.flatMap(location => {
        const id = location.machineId ?? location.machineName
        return id ? [[id, location.machineName ?? id] as const] : []
    })).entries()].sort((a, b) => a[1].localeCompare(b[1]))
    const archivedIds = new Set<string>([...workspaces.archivedSessionIds, ...rows.filter(row => row.archived).map(row => row.id)])
    const pinnedIds = new Set<string>([...workspaces.pinnedSessionIds, ...rows.filter(row => row.pinned).map(row => row.id)])
    const selected = controller.store.focusedPane().resource
    const openSessions = new Set(snapshot.layout.windows.flatMap(window => panes(window.root)).flatMap(pane => pane.resource.kind === 'chat' ? [pane.resource.sessionId] : []))
    const visible = filterSessions(rows, query, engine, machine).filter(row => archived ? archivedIds.has(row.id) : !archivedIds.has(row.id))
        .sort((a, b) => Number(pinnedIds.has(b.id)) - Number(pinnedIds.has(a.id)))
    const action = (id: string, kind: 'pin' | 'unpin' | 'archive' | 'unarchive' | 'fork'): void => { void controller.sessionAction(id, kind).catch(controller.report) }
    if (!wide) return <div className="hapi-session-rail"><IconButton label={t('showSidebar')} icon="sidebar" onClick={expandSidebar}/><span>{rows.length}</span></div>
    return <div className="hapi-session-sidebar">
        <header><strong>{t('allChats')}</strong><span>{visible.length}</span><IconButton label={t('refresh')} icon="refresh" onClick={() => { void controller.refresh() }}/></header>
        <div className="hapi-search"><WorkspaceIcon kind="search"/><input ref={input} type="search" aria-label={t('search')} placeholder={t('search')} value={query} onChange={event => setQuery(event.currentTarget.value)}/></div>
        <div className="hapi-session-filters">
            <select aria-label={t('engine')} value={engine} onChange={event => setEngine(event.currentTarget.value)}><option value="">{t('allEngines')}</option>{engines.map(value => <option key={value} value={value}>{value.toUpperCase()}</option>)}</select>
            <select aria-label={t('machine')} value={machine} onChange={event => setMachine(event.currentTarget.value)}><option value="">{t('allMachines')}</option>{machines.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
        </div>
        <div className="hapi-session-list" aria-label={t('allChats')}>
            {!visible.length && <p className="hapi-list-empty" role="status">{snapshot.catalog.phase === 'ready' ? t('noSessions') : t('loading')}</p>}
            {visible.map(row => {
                const location = sessionLocation(row)
                const isSelected = selected.kind === 'chat' && selected.sessionId === row.id
                return <article key={row.id} className={`hapi-session-row${isSelected ? ' hapi-session-selected' : ''}`} data-session-row={row.id}>
                    <button type="button" className="hapi-session-open" aria-current={isSelected ? 'page' : undefined} onClick={event => controller.openSession(row.id, event.shiftKey ? 'horizontal' : undefined)} title={[row.displayTitle, row.cwd, location.machineName, location.nativeId].filter(Boolean).join('\n')}>
                        <div className="hapi-session-title"><span className={`hapi-dot${row.running ? ' hapi-dot-running' : ''}`} title={t(row.running ? 'running' : 'idle')}/><span>{pinnedIds.has(row.id) && '⌁ '}{row.displayTitle}</span>{openSessions.has(row.id) && <span className="hapi-session-open-mark" aria-label={t('selected')}>▥</span>}</div>
                        <div className="hapi-session-meta"><span className={`hapi-engine hapi-engine-${location.engine === 'codex' ? 'codex' : 'dsh'}`}>{location.engine.toUpperCase()}</span><span className="hapi-ellipsis">{location.machineName ?? row.cwd ?? ''}</span></div>
                    </button>
                    <details className="hapi-menu hapi-session-menu"><summary aria-label={t('actions')} title={t('actions')}><WorkspaceIcon kind="more"/></summary><div className="hapi-menu-content">
                        <button type="button" onClick={() => controller.openSession(row.id, 'horizontal')}>{t('openBeside')}</button>
                        <button type="button" onClick={() => setRename({ id: row.id, title: row.displayTitle })}>{t('rename')}</button>
                        <button type="button" onClick={() => action(row.id, pinnedIds.has(row.id) ? 'unpin' : 'pin')}>{t(pinnedIds.has(row.id) ? 'unpin' : 'pin')}</button>
                        <button type="button" disabled={location.engine === 'codex' && (row.hostId !== 'local' || !controls)} title={t('fork')} onClick={() => {
                            if (location.engine === 'codex') setFork({ id: row.id, sourceId: row.sourceSessionId })
                            else action(row.id, 'fork')
                        }}>{t('fork')}</button>
                        <button type="button" onClick={() => action(row.id, archived ? 'unarchive' : 'archive')}>{t(archived ? 'unarchive' : 'archive')}</button>
                        <button type="button" onClick={() => { void navigator.clipboard.writeText(row.id).catch(controller.report) }}>{t('copyId')}</button>
                    </div></details>
                </article>
            })}
        </div>
        <label className="hapi-archived-toggle"><input type="checkbox" checked={archived} onChange={event => setArchived(event.currentTarget.checked)}/>{t('showArchived')}</label>
        {rename && <RenameDialog title={t('rename')} initial={rename.title} save={title => controller.renameSession(rename.id, title)} close={() => setRename(null)} t={t}/>}
        {fork && controls && <Dialog title={t('fork')} close={() => setFork(null)} t={t}><NativeForkContent ledger={controls} sessionId={fork.sourceId} t={t} open={sessionId => {
            void controller.refresh(); controller.openSession(sessionId, 'horizontal'); setFork(null)
        }}/></Dialog>}
    </div>
}
