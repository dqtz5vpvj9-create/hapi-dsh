import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { filterSessions, sessionLocation, type WorkspaceController } from './controller.ts'
import { isInternalIdentifier, readableEngine, readableHost, stableLabel } from './locales.ts'
import type { WorkspaceKey, WorkspaceTranslate } from './locales.ts'
import { paneRectangles, panes, splitBoundaries, type PaneNode, type SplitBoundary, type WorkspaceWindow } from './model.ts'
import { PrefixKeys, runWorkspaceCommand, WORKSPACE_PREFIX_TIMEOUT_MS } from './shortcuts.ts'
import type { SessionSidebarProps, WorkspaceRootProps } from './slots.ts'
import { NativeSessionForm } from './new-session.tsx'
import { SourceSessionForm } from './source-session.tsx'
import { NativeForkContent } from './native-controls.tsx'
import { DshSessionForm } from './dsh-session.tsx'
import { nativeProjection, observedProjection, paneTitle, sessionActivity, sessionDestinations, sessionFolder, windowActivity, windowAlias, windowTitle, type ActivityKind } from '../workspace/presentation.ts'
import { useNarrowViewport } from '../workspace/viewport.ts'
import type { WorkspaceCatalogRow } from './controller.ts'
import type { SourceResolutionStatus } from './source-session-state.ts'
import type { SidebarFilter } from '../workspace/sidebar-state.ts'
import { projectSidebarRows, sidebarTree, type SidebarBranch, type SidebarTreeRow } from '../workspace/sidebar-tree.ts'
import type { WorkbenchSource } from '../workbench-types.ts'
import { isSourceChild, sourceIdentity } from '../workspace/legacy.ts'
import { NativeLibraryPanel, NativeSessionToolsPanel } from './native-library.tsx'
import { SourceSessionToolsPanel } from './source-lifecycle.tsx'
import { SourcePinButton } from './source-pin.tsx'
import { SidebarActionSurface } from './sidebar-action-surface.tsx'
import { sidebarActionFacts } from '../workspace/sidebar-actions.ts'
import { SourceExportPanel } from './source-export.tsx'
import { SourceTitlePanel } from './source-title-panel.tsx'
import { SourceMigrationPanel } from './source-history.tsx'
import { MachineHealthRow } from './machine-health-view.tsx'
import { useWorkspacePaneDrop, dropOnWorkspaceWindow } from './workspace-drag.tsx'
import { useWorkspaceLinks, WorkspaceLinkNotice } from './workspace-links.tsx'
import { acceptsWorkspaceDrag, writeWorkspaceDrag } from '../workspace/drag.ts'
import { SidebarScrollAnchor } from './sidebar-scroll.tsx'
import { SidebarWindow, type SidebarScrollObserver } from './sidebar-window.tsx'
import { SidebarSearchControls } from './sidebar-search-controls.tsx'
import { SessionRowState, SessionTime } from './sidebar-row-state.tsx'
import { buildSidebarSearchIndex, compareSidebarSearch, sourceWorktreeLabel } from '../workspace/sidebar-search.ts'
import { SidebarBookmarks } from '../workspace/sidebar-bookmarks.ts'
import { localDayKey, matchesSidebarTime, SidebarRecency, sidebarDayLabel, sidebarTimeRange } from '../workspace/sidebar-time.ts'
import { nextSidebarPreview, previousSidebarPreview, sidebarActiveRoots, sidebarActivityBuckets, sidebarBranchFacts, sidebarPreview, sidebarSessionActive, type SidebarActivityBucket } from '../workspace/sidebar-sections.ts'

const activityLabel: Record<ActivityKind, WorkspaceKey> = { error: 'activityError', permission: 'waitingPermission', input: 'waitingInput', running: 'running', background: 'background', idle: 'idle', offline: 'offline' }
const sourceResolutionLabel: Record<SourceResolutionStatus, WorkspaceKey> = {
    loading: 'sourceLoading', 'not-found': 'sourceNotFound', removed: 'sourceRemoved', denied: 'sourceDenied',
    transport: 'sourceTransport', 'not-ready': 'sourceNotReady', ambiguous: 'sourceAmbiguous', identity: 'sourceIdentityMismatch', unknown: 'sourceResolveFailed',
}

/** One readable label for a conversation; identifiers never stand in for titles. */
function readableTitle(raw: string | null | undefined, t: WorkspaceTranslate, max = 48): string {
    const label = stableLabel(raw, max)
    return !label || isInternalIdentifier(label) ? t('untitledConversation') : label
}

/** Split raw failures (JSON, stack traces) into a readable line plus optional detail. */
function errorParts(message: string, t: WorkspaceTranslate): { summary: string; detail: string | null } {
    const text = (message ?? '').trim()
    if (!text) return { summary: t('errorSummary'), detail: null }
    const raw = /^[\[{]/.test(text) || /"code"\s*:|"stack"\s*:/.test(text)
    const first = text.split('\n')[0]!.trim()
    return { summary: raw ? t('errorSummary') : first.length > 180 ? `${first.slice(0, 180)}…` : first,
        detail: raw || text.includes('\n') || first !== text ? text : null }
}
function ActivityDot({ kind, pending, compacting, t }: { kind: ActivityKind; pending?: boolean; compacting?: boolean; t: WorkspaceTranslate }) {
    const title = t(compacting && kind === 'running' ? 'compacting' : activityLabel[kind])
    return <span className={`hapi-activity hapi-activity-${kind}`} data-activity={kind} title={title} aria-label={title}>
        <span className={`hapi-dot hapi-dot-${kind}`}/>{pending && kind !== 'permission' && kind !== 'input' && <span className="hapi-pending-badge" title={t('attention')}>!</span>}
    </span>
}

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
        {error && <p className="hapi-error" role="alert" title={error}>{error}</p>}
        <div className="hapi-button-row"><button type="button" onClick={close}>{t('cancel')}</button><button type="submit" disabled={pending || !value.trim()}>{t('save')}</button></div>
    </form></Dialog>
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
    controller: WorkspaceController; bind: (pane: PaneNode, visible: boolean) => ReactNode; create: () => void;
    t: WorkspaceTranslate
}) {
    const snapshot = controller.getSnapshot()
    const summary = pane.resource.kind !== 'empty' ? snapshot.catalog.byId[pane.resource.sessionId] : undefined
    const location = sessionLocation(summary)
    const lease = snapshot.leases.get(pane.id)
    const element = useRef<HTMLElement>(null)
    const lastVisibleSize = useRef<{ width: number; height: number } | null>(null)
    const drop = useWorkspacePaneDrop(controller, pane, hidden)
    useLayoutEffect(() => {
        const node = element.current
        if (!node) return
        node.inert = hidden
        if (hidden) return
        const measure = (): void => {
            const { width, height } = node.getBoundingClientRect()
            if (width > 0 && height > 0) lastVisibleSize.current = { width, height }
        }
        measure()
        const observer = new ResizeObserver(measure); observer.observe(node)
        return () => { observer.disconnect() }
    }, [hidden])
    useEffect(() => {
        if (hidden || !focused || snapshot.pickingSession || !summary || !(pane.resource.kind === 'chat' || (pane.resource.kind === 'view' || pane.resource.kind === 'document') && pane.resource.target?.type === 'conversation')) return
        const seen = (): void => { if (document.visibilityState === 'visible') controller.sidebar.markSeen(summary.id, summary.updatedAt) }
        seen(); document.addEventListener('visibilitychange', seen)
        return () => { document.removeEventListener('visibilitychange', seen) }
    }, [hidden, focused, snapshot.pickingSession, summary?.id, summary?.updatedAt, controller, pane.resource])
    const title = !summary && lease?.sourceResolution ? t('originalConversation') : paneTitle(pane, snapshot.catalog.byId, t('newPane'))
    return <section ref={element} className={`hapi-pane${focused ? ' hapi-pane-focused' : ''}`} style={{ ...style, ...(hidden ? { visibility: 'hidden', pointerEvents: 'none', ...(lastVisibleSize.current ?? {}) } : {}) }}
        data-pane-id={pane.id} data-session-id={pane.resource.kind === 'chat' ? pane.resource.sessionId : ''} aria-hidden={hidden}
        data-hapi-pane-visible={!hidden} aria-label={`${t('pane')}: ${title}`} tabIndex={focused && !hidden ? 0 : -1} {...drop.handlers}
        onFocusCapture={() => { if (!hidden) controller.store.focus(pane.id) }} onPointerDownCapture={() => { if (!hidden) controller.store.focus(pane.id) }}>
        <header className="hapi-pane-header">
            <ActivityDot {...sessionActivity(summary)} t={t}/>
            <span className="hapi-pane-title" title={[title, summary?.cwd].filter(Boolean).join('\n')} draggable={!hidden}
                onDragStart={event => { event.stopPropagation(); writeWorkspaceDrag(event.dataTransfer, { kind: 'pane', paneId: pane.id }) }}>{readableTitle(title, t, 72)}</span>
            <IconButton label={t('newPane')} icon="add" onClick={() => { controller.store.focus(pane.id); controller.store.split('horizontal'); controller.requestSessionPicker() }}/>
            <PaneMenu pane={pane} window={window} controller={controller} t={t}/>
            <IconButton label={t('closePane')} icon="close" onClick={() => controller.store.closePane(pane.id)}/>
        </header>
        <div className="hapi-pane-body">
            {pane.resource.kind === 'empty' ? <div className="hapi-empty"><WorkspaceIcon kind="grid" size={34}/><h2>{t('chooseSession')}</h2><p>{t('emptyHelp')}</p><button type="button" onClick={controller.requestSessionPicker}>{t('openConversation')}</button><button type="button" onClick={create}>{t('newSession')}</button><kbd>Ctrl B → %</kbd></div>
                : lease?.status === 'failed' ? (() => {
                    const error = errorParts(lease.error ?? '', t)
                    const detail = lease.sourceResolution && lease.error ? lease.error : error.detail
                    return <div className="hapi-lease-error" role="alert"><h2>{t('openFailed')}</h2>
                        <p>{lease.sourceResolution ? t(sourceResolutionLabel[lease.sourceResolution]) : error.summary}</p>
                        {detail && <details><summary>{t('technicalDetails')}</summary><pre>{detail}</pre></details>}
                        <button type="button" onClick={() => controller.retryPane(pane.id)}>{t('retry')}</button></div>
                })()
                : bind(pane, !hidden)}
        </div>
        {drop.position && <div className="hapi-dock-indicator" data-hapi-drop={drop.position} aria-hidden="true"/>}
    </section>
}

function PaneMenu({ pane, window, controller, t }: { pane: PaneNode; window: WorkspaceWindow; controller: WorkspaceController; t: WorkspaceTranslate }) {
    const layout = controller.getSnapshot().layout
    const row = pane.resource.kind === 'empty' ? undefined : controller.getSnapshot().catalog.byId[pane.resource.sessionId]
    const split = (axis: 'horizontal' | 'vertical'): void => { controller.store.focus(pane.id); controller.store.split(axis); controller.requestSessionPicker() }
    return <details className="hapi-menu hapi-pane-menu"><summary title={t('actions')} aria-label={t('actions')}><WorkspaceIcon kind="more"/></summary><div className="hapi-menu-content">
        {pane.resource.kind !== 'empty' && <>
            <button type="button" onClick={() => { if (pane.resource.kind !== 'empty') controller.openTab('guide', { sessionId: pane.resource.sessionId, beside: 'horizontal' }) }}>{t('pluginViewsBeside')}</button>
            <button type="button" onClick={() => { if (pane.resource.kind !== 'empty') controller.openTab('files', { sessionId: pane.resource.sessionId, beside: 'horizontal' }) }}>{t('projectFiles')}</button>
            <button type="button" onClick={() => { if (pane.resource.kind !== 'empty') controller.openTab('terminal', { sessionId: pane.resource.sessionId, beside: 'horizontal' }) }}>{t('terminal')}</button>
        </>}
        {row?.hostId === 'local' && sourceIdentity(row) && <button type="button" onClick={() => controller.openNativeTools(row.id)}>{t('sessionTools')}</button>}
        <button type="button" onClick={() => { controller.store.focus(pane.id); controller.requestSessionPicker() }}>{t('openConversation')}</button>
        <button type="button" onClick={() => split('horizontal')}>{t('splitHorizontal')}</button>
        <button type="button" onClick={() => split('vertical')}>{t('splitVertical')}</button>
        <button type="button" onClick={() => { controller.store.focus(pane.id); controller.store.toggleZoom() }}>{t(layout.zoomed[window.id] ? 'unzoom' : 'zoom')}</button>
        {layout.windows.filter(other => other.id !== window.id).map(other => <button type="button" key={other.id} onClick={() => controller.store.movePane(pane.id, other.id)}>{t('moveTo')} · {windowAlias(other, layout.windows.indexOf(other) + 1)}</button>)}
        <button type="button" onClick={() => controller.store.movePaneToNewWindow(pane.id)}>{t('moveToNewWindow')}</button>
        <button type="button" onClick={() => controller.store.closePane(pane.id)}>{t('closePane')}</button>
    </div></details>
}

export function WorkspaceRoot({ controller, api, language, t, uploadInitialFile, preferences, prepareNavigation, runnerSkew }: WorkspaceRootProps) {
    const links = useWorkspaceLinks(preferences, prepareNavigation)
    const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
    const { layout } = snapshot
    const [stage, setStage] = useState<HTMLDivElement | null>(null)
    const [help, setHelp] = useState(false)
    const [switcher, setSwitcher] = useState(false)
    const [rename, setRename] = useState<WorkspaceWindow | null>(null)
    const [prefix, setPrefix] = useState(false)
    const mobile = useNarrowViewport()
    const windowTabs = useRef<HTMLDivElement>(null)
    const paneTabs = useRef<HTMLDivElement>(null)
    const active = controller.store.active()
    const activePane = controller.store.focusedPane()
    useLayoutEffect(() => {
        windowTabs.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
        paneTabs.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }, [layout.activeWindowId, layout.focused[active.id], mobile])
    useEffect(() => {
        const node = windowTabs.current
        if (!node) return
        let amount = 0, lastAt = 0
        const wheel = (event: WheelEvent): void => {
            if (event.ctrlKey || event.metaKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return
            if (node.scrollWidth > node.clientWidth + 1) {
                event.preventDefault(); node.scrollLeft += event.deltaY; return
            }
            const now = performance.now()
            if (now - lastAt > 350) amount = 0
            amount += event.deltaY
            event.preventDefault()
            if (Math.abs(amount) >= 45 && now - lastAt > 180) {
                controller.store.cycleWindow(amount > 0 ? 1 : -1); lastAt = now; amount = 0
            }
        }
        node.addEventListener('wheel', wheel, { passive: false })
        return () => { node.removeEventListener('wheel', wheel) }
    }, [controller])
    useEffect(() => {
        const keys = new PrefixKeys()
        let timeout: ReturnType<typeof setTimeout> | undefined
        const clear = (): void => { keys.clear(); setPrefix(false); if (timeout) clearTimeout(timeout) }
        const keydown = (event: KeyboardEvent): void => {
            if (event.isComposing || event.repeat) return
            const inDialog = event.target instanceof Element && event.target.closest('dialog[open], [role="dialog"]')
            const modalOpen = [...document.querySelectorAll<HTMLElement>('dialog[open], [role="dialog"][aria-modal="true"]')]
                .some(dialog => dialog.getClientRects().length > 0 && getComputedStyle(dialog).visibility !== 'hidden')
            if (inDialog || modalOpen) { clear(); return }
            const result = keys.key(event, performance.now())
            setPrefix(result.armed)
            if (timeout) clearTimeout(timeout)
            if (result.armed) timeout = setTimeout(clear, WORKSPACE_PREFIX_TIMEOUT_MS)
            if (result.consumed) { event.preventDefault(); event.stopImmediatePropagation() }
            if (result.command) {
                try { runWorkspaceCommand(controller.store, result.command, () => setHelp(true), () => setSwitcher(true), controller.requestSessionPicker) }
                catch (error) { controller.report(error) }
            }
        }
        window.addEventListener('keydown', keydown, true)
        window.addEventListener('blur', clear)
        return () => { window.removeEventListener('keydown', keydown, true); window.removeEventListener('blur', clear); if (timeout) clearTimeout(timeout) }
    }, [controller])
    const action = (operation: () => void): void => { try { operation() } catch (error) { controller.report(error) } }
    const bind = (pane: PaneNode, visible: boolean): ReactNode => {
        const lease = snapshot.leases.get(pane.id)
        if (!lease?.reference) return <div className="hapi-loading" role="status">{t(lease?.sourceResolution === 'loading' ? 'sourceLoading' : 'loading')}</div>
        if (pane.resource.kind === 'empty') return null
        const host = controller.host(lease.hostId)
        const focused = controller.store.focusedPane().id === pane.id
        const options = { paneId: pane.id, focused, visible }
        if (host?.renderPane) return host.renderPane(lease.reference, pane.resource, options)
        return <div className="hapi-loading" role="status">{t('loading')}</div>
    }
    const shortcuts: Array<[string, WorkspaceKey]> = [
        ['%', 'splitHorizontal'], ['"', 'splitVertical'], ['c', 'newWindow'], ['n / p', 'nextWindow'],
        ['o', 'nextPane'], ['← ↑ → ↓ / h j k l', 'focusDirection'], ['w', 'windowList'], ['z', 'zoom'], ['x', 'closePane'], ['u', 'restoreWindow'], ['1…9', 'windowNumber'],
    ]
    return <div className={`hapi-workspace${mobile ? ' hapi-workspace-mobile' : ''}`} data-hapi-workspace="" onClickCapture={links.capture}>
        <header className="hapi-workspace-toolbar">
            <div className="hapi-workspace-brand"><WorkspaceIcon kind="grid"/><strong>HAPI</strong>{layout.windows.length > 1 && <span>{windowAlias(active, layout.windows.indexOf(active) + 1)}</span>}</div>
            <div className="hapi-workspace-tools">
                <details className="hapi-menu"><summary aria-label={t('newSession')} title={t('newSession')}><WorkspaceIcon kind="add"/></summary><div className="hapi-menu-content">
                    <button type="button" onClick={() => controller.requestNewSession('dsh')}>DSH · {t('newSession')}</button>
                    <button type="button" onClick={() => controller.requestNewSession('codex')}>Codex · {t('newSession')}</button>
                    <button type="button" onClick={() => controller.requestNewSession('source')}>{t('sourceEngines')} · {t('newSession')}</button>
                    <button type="button" onClick={controller.openNativeLibrary}>{t('nativeHistory')}</button>
                </div></details>
                <IconButton label={t('splitHorizontal')} icon="horizontal" onClick={() => action(() => { controller.store.split('horizontal'); controller.requestSessionPicker() })}/>
                <IconButton label={t('splitVertical')} icon="vertical" onClick={() => action(() => { controller.store.split('vertical'); controller.requestSessionPicker() })}/>
                <IconButton label={t(layout.zoomed[active.id] ? 'unzoom' : 'zoom')} icon="zoom" pressed={layout.zoomed[active.id] === true} onClick={() => controller.store.toggleZoom()}/>
                <IconButton label={t('restoreWindow')} icon="restore" disabled={!controller.store.canRestoreWindow()} onClick={() => action(() => controller.store.restoreWindow())}/>
                <IconButton label={t('shortcuts')} icon="help" onClick={() => setHelp(true)}/>
            </div>
        </header>
        {runnerSkew}
        {snapshot.notice && <div className="hapi-notice" role="alert"><span title={snapshot.notice}>{snapshot.notice}</span>{snapshot.conflict ? <><button type="button" onClick={() => controller.resolveConflict('local')}>{t('keepLocal')}</button><button type="button" onClick={() => controller.resolveConflict('server')}>{t('useServer')}</button></> : snapshot.persistence === 'failed' && <button type="button" onClick={controller.retryPersistence}>{t('retry')}</button>}<IconButton label={t('dismiss')} icon="close" onClick={controller.clearNotice}/></div>}
        <WorkspaceLinkNotice links={links} language={language}/>
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
                        const position = (zoomed || mobile) && focused ? { left: 0, top: 0, width: 100, height: 100 } : rectangle
                        return <WorkspacePane key={pane.id} pane={pane} window={window} focused={focused} hidden={!visible || Boolean((zoomed || mobile) && !focused)}
                            style={{ left: `${position.left}%`, top: `${position.top}%`, width: `${position.width}%`, height: `${position.height}%` }} controller={controller} bind={bind} create={() => controller.requestNewSession()} t={t}/>
                    })}
                    {!zoomed && !mobile && splitBoundaries(window.root).map(boundary => <ResizeHandle key={`${boundary.splitId}:${boundary.boundary}`} boundary={boundary} controller={controller} stage={stage} t={t}/>)}
                </div>
            })}
        </div>
        {mobile && <nav className="hapi-mobile-pane-bar" aria-label={t('pane')}>
            <IconButton label={t('allChats')} icon="sidebar" onClick={controller.requestSessionPicker}/>
            <div className="hapi-pane-tabs" role="tablist" aria-label={t('pane')} ref={paneTabs}>
                {panes(active.root).map((pane, index) => {
                    const paneName = paneTitle(pane, snapshot.catalog.byId, t('newPane'))
                    return <button type="button" role="tab" key={pane.id} aria-selected={pane.id === activePane.id} onClick={() => controller.store.focus(pane.id)}
                        title={paneName}><span>P{index + 1}</span><span>{readableTitle(paneName, t, 36)}</span></button>
                })}
            </div>
            <button type="button" className="hapi-pane-add" aria-label={t('newPane')} onClick={() => { controller.store.split('horizontal'); controller.requestSessionPicker() }}>P+</button>
            <PaneMenu pane={activePane} window={active} controller={controller} t={t}/>
        </nav>}
        <footer className="hapi-statusbar">
            <div role="tablist" aria-label={t('window')} className="hapi-window-tabs" ref={windowTabs}>
                {layout.windows.map((window, index) => {
                    const paneCount = panes(window.root).length
                    const paneName = windowTitle(window, layout.focused[window.id], snapshot.catalog.byId, t('newPane'))
                    // A renamed window keeps its name; an auto window identifies the focused conversation.
                    const label = window.autoName === false ? readableTitle(windowAlias(window, index + 1), t) : readableTitle(paneName, t)
                    return <button type="button" role="tab" key={window.id} aria-selected={window.id === active.id}
                        className={window.id === active.id ? 'hapi-window-tab-active' : ''} onClick={() => controller.store.selectWindow(window.id)}
                        onDragOver={event => { if (acceptsWorkspaceDrag(event.dataTransfer)) { event.preventDefault(); event.stopPropagation() } }}
                        onDrop={event => dropOnWorkspaceWindow(controller, window.id, event)}
                        onDoubleClick={() => setRename(window)} title={[label, paneName !== label ? paneName : null, paneCount > 1 ? t('paneCount', { n: paneCount }) : null].filter(Boolean).join('\n')}>
                        <ActivityDot kind={windowActivity(window, snapshot.catalog.byId)} t={t}/><span className="hapi-window-position">{index + 1}</span>
                        <span className="hapi-window-label">{label}</span>
                        {paneCount > 1 && <span className="hapi-window-count" aria-label={t('paneCount', { n: paneCount })}>{paneCount}</span>}</button>
                })}
            </div>
            <IconButton label={t('newWindow')} icon="add" onClick={() => action(() => { controller.store.createWindow(); controller.requestSessionPicker() })}/>
            <details className="hapi-menu hapi-window-menu"><summary title={t('more')} aria-label={t('more')}><WorkspaceIcon kind="more"/></summary><div className="hapi-menu-content">
                <button type="button" onClick={() => setRename(active)}>{t('renameWindow')}</button>
                <button type="button" onClick={() => setSwitcher(true)}>{t('windowList')}</button>
                <button type="button" onClick={() => controller.store.closeWindow(active.id)} title={t('closeHelp')}>{t('closeWindow')}</button>
            </div></details>
            <button type="button" className={`hapi-prefix${prefix ? ' hapi-prefix-active' : ''}`} onClick={() => setHelp(true)}>{t(prefix ? 'prefixReady' : 'prefix')}</button>
            <span className={`hapi-persistence hapi-persistence-${snapshot.persistence}`} title={t(snapshot.persistence)} aria-label={t(snapshot.persistence)}>●</span>
        </footer>
        {snapshot.nativePanel?.kind === 'library' && <Dialog title={t('nativeHistory')} close={controller.closeNativePanel} t={t}>
            <NativeLibraryPanel api={api} machines={snapshot.machines} language={language} onOpen={id => { void controller.refresh(); controller.openSession(id); controller.closeNativePanel() }}/>
        </Dialog>}
        {snapshot.nativePanel?.kind === 'session' && <Dialog title={t('sessionTools')} close={controller.closeNativePanel} t={t}>
            {observedProjection(snapshot.catalog.byId[snapshot.nativePanel.sessionId]) ? <SourceSessionToolsPanel api={api}
                sessionId={snapshot.catalog.byId[snapshot.nativePanel.sessionId]?.sourceSessionId ?? snapshot.nativePanel.sessionId} language={language}
                onSuccessor={id => { const from = snapshot.nativePanel?.kind === 'session' ? snapshot.nativePanel.sessionId : null; if (!from) return; controller.closeNativePanel(); void controller.openSuccessorSession(from, id).catch(controller.report) }}
                initialAction={snapshot.nativePanel.initialAction} onOpen={id => { void controller.refresh(); controller.openSession(id); controller.closeNativePanel() }}/>
                : <NativeSessionToolsPanel api={api} sessionId={snapshot.catalog.byId[snapshot.nativePanel.sessionId]?.sourceSessionId ?? snapshot.nativePanel.sessionId}
                machineId={sessionLocation(snapshot.catalog.byId[snapshot.nativePanel.sessionId]).machineId} language={language}
                {...(snapshot.nativePanel.initialAction && snapshot.nativePanel.initialAction !== 'fork' ? { initialAction: snapshot.nativePanel.initialAction } : {})}
                onSuccessor={id => { const from = snapshot.nativePanel?.kind === 'session' ? snapshot.nativePanel.sessionId : null; if (!from) return; controller.closeNativePanel(); void controller.openSuccessorSession(from, id).catch(controller.report) }}
                onOpen={id => { void controller.refresh(); controller.openSession(id); controller.closeNativePanel() }}/>}
        </Dialog>}
        {switcher && <Dialog title={t('windowList')} close={() => setSwitcher(false)} t={t}><div className="hapi-window-switcher">
            {layout.windows.map((window, index) => {
                const count = panes(window.root).length
                const paneName = windowTitle(window, layout.focused[window.id], snapshot.catalog.byId, t('newPane'))
                return <button type="button" key={window.id} aria-current={window.id === active.id ? 'page' : undefined}
                    onClick={() => { controller.store.selectWindow(window.id); setSwitcher(false) }}><ActivityDot kind={windowActivity(window, snapshot.catalog.byId)} t={t}/>
                    <strong>W{index + 1}</strong><span>{window.autoName === false ? windowAlias(window, index + 1) : readableTitle(paneName, t)}</span><small>{t('paneCount', { n: count })}</small></button>
            })}
        </div></Dialog>}
        {rename && <RenameDialog key={rename.id} title={t('renameWindow')} initial={rename.name} save={name => controller.store.renameWindow(rename.id, name)} close={() => setRename(null)} t={t}/>}
        {snapshot.creation === 'choose' && <Dialog title={t('newSession')} close={controller.closeNewSession} t={t}><div className="hapi-new-choice">
            <button type="button" onClick={() => snapshot.creationContext?.machineId
                ? controller.requestNewSession('source', { ...snapshot.creationContext, engine: 'dsh' })
                : controller.requestNewSession('dsh')}><strong>DSH</strong><span>{t(snapshot.creationContext?.machineId ? 'sourceCreateHelp' : 'dshCreateHelp')}</span></button>
            <button type="button" onClick={() => controller.requestNewSession('codex')}><strong>Codex</strong><span>{t('nativeCreateHelp')}</span></button>
            <button type="button" onClick={() => controller.requestNewSession('source')}><strong>{t('sourceEngines')}</strong><span>{t('sourceCreateHelp')}</span></button>
            <button type="button" onClick={controller.openNativeLibrary}><strong>{t('nativeHistory')}</strong></button>
        </div></Dialog>}
        {snapshot.creation === 'codex' && <Dialog title={t('nativeNew')} close={controller.closeNewSession} t={t}><NativeSessionForm api={api} controller={controller} close={controller.closeNewSession} t={t} uploadInitialFile={uploadInitialFile}/></Dialog>}
        {snapshot.creation === 'source' && <Dialog title={`${t('sourceEngines')} · ${t('newSession')}`} close={controller.closeNewSession} t={t}><SourceSessionForm api={api} controller={controller} close={controller.closeNewSession} t={t} uploadInitialFile={uploadInitialFile}/></Dialog>}
        {snapshot.creation === 'dsh' && <Dialog title={`DSH · ${t('newSession')}`} close={controller.closeNewSession} t={t}><DshSessionForm controller={controller} close={controller.closeNewSession} t={t}/></Dialog>}
        {help && <Dialog title={t('shortcuts')} close={() => setHelp(false)} t={t}><p>{t('shortcutHint')}</p><dl className="hapi-shortcuts">{shortcuts.map(([key, label]) => <div key={key}><dt><kbd>{key}</kbd></dt><dd>{t(label)}</dd></div>)}</dl><p>{t('closeHelp')}</p></Dialog>}
    </div>
}

export function SessionSidebar({ controller, controls, api, wide, expandSidebar, useWorkspaces, t }: SessionSidebarProps) {
    const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
    const sidebar = useSyncExternalStore(controller.sidebar.subscribe, controller.sidebar.getSnapshot)
    const { engine, machine, mode, filter, collapsed, expanded, folderOrder, pinInProgressSessions, showActiveSessionsOnly, sessionPreviewLimit, statusMode } = sidebar.preferences
    const workspaces = useWorkspaces(state => state)
    const mobile = useNarrowViewport()
    const [query, setQuery] = useState('')
    const [searchExpanded, setSearchExpanded] = useState(false)
    const [archived, setArchived] = useState(false)
    const [dateFrom, setDateFrom] = useState(''), [dateThrough, setDateThrough] = useState('')
    const [recency] = useState(() => new SidebarRecency())
    const [bookmarks] = useState(() => new SidebarBookmarks())
    const [previewCounts, setPreviewCounts] = useState<ReadonlyMap<string, number>>(() => new Map())
    const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
    const scrollObserver = useRef<SidebarScrollObserver>(null)
    const onScrollRestored = useCallback((offset: number) => { scrollObserver.current?.observeScroll(offset) }, [])
    const [rename, setRename] = useState<{ id: string; title: string } | null>(null)
    const [fork, setFork] = useState<{ id: string; sourceId: string } | null>(null)
    const [sourceDialog, setSourceDialog] = useState<{ kind: 'rename' | 'export' | 'migration'; row: WorkspaceCatalogRow; source: WorkbenchSource } | null>(null)
    const language = document.documentElement.lang || 'en'
    const input = useRef<HTMLInputElement>(null)
    const rows = useMemo(() => snapshot.catalog.ids.map(id => snapshot.catalog.byId[id]).filter(row => row !== undefined), [snapshot.catalog])
    const orderedIds = recency.reconcile(rows)
    const searchIndex = useMemo(() => buildSidebarSearchIndex(rows, query, sessionLocation), [rows, query])
    const activityDates = useMemo(() => new Set(rows.map(row => localDayKey(row.updatedAt))), [rows])
    const hasQuery = Boolean(query.trim())
    const timeRange = sidebarTimeRange(dateFrom, dateThrough)
    const bookmarkScope = JSON.stringify([query.trim().toLocaleLowerCase(), engine, machine, filter, archived, dateFrom, dateThrough, showActiveSessionsOnly])
    const revealSidebar = useRef(expandSidebar)
    revealSidebar.current = expandSidebar
    const locations = rows.map(sessionLocation)
    const engines = [...new Set(locations.map(location => location.engine))].sort()
    const machines = [...new Map(locations.flatMap(location => {
        const id = location.machineId ?? location.machineName
        return id ? [[id, location.machineName ?? id] as const] : []
    })).entries()].sort((a, b) => a[1].localeCompare(b[1]))
    const displayOwned = (id: string): boolean => !sourceIdentity(snapshot.catalog.byId[id]) && !isSourceChild(snapshot.catalog.byId[id])
    const archivedIds = new Set<string>([...workspaces.archivedSessionIds.filter(displayOwned), ...rows.filter(row => row.archived).map(row => row.id)])
    const pinnedIds = new Set<string>([...workspaces.pinnedSessionIds.filter(displayOwned), ...rows.filter(row => row.pinned).map(row => row.id)])
    const globalPinnedIds = new Set(rows.filter(row => row.sourcePinMode === 'global' || row.sourcePinMode === undefined && pinnedIds.has(row.id)).map(row => row.id as string))
    const selected = controller.store.focusedPane().resource
    const selectedId = selected.kind === 'empty' ? undefined : selected.sessionId
    const destinations = sessionDestinations(snapshot.layout)
    const matching = filterSessions(rows, query, engine, machine, searchIndex).filter(row => (archived ? archivedIds.has(row.id) : !archivedIds.has(row.id)) && matchesSidebarTime(row.updatedAt, timeRange))
    const matchingIds = new Set(matching.map(row => row.id as string))
    const matchingTree = sidebarTree(hasQuery ? matching : orderedIds.filter(id => matchingIds.has(id)).map(id => snapshot.catalog.byId[id]!))
    const branchFacts = sidebarBranchFacts(matchingTree, selectedId)
    const scopedTree = showActiveSessionsOnly ? sidebarActiveRoots(matchingTree, branchFacts) : matchingTree
    const counts = {
        all: scopedTree.length,
        running: scopedTree.filter(({ row }) => sessionActivity(row).running).length,
        attention: scopedTree.filter(({ row }) => ['error', 'permission', 'input'].includes(sessionActivity(row).kind) || branchFacts.get(row.id)?.pending).length,
        unread: scopedTree.filter(({ row }) => controller.sidebar.isUnread(row.id, row.updatedAt)).length,
    }
    const tree = scopedTree.filter(({ row }) => {
        const activity = sessionActivity(row)
        return filter === 'all' || (filter === 'running' && activity.running)
            || (filter === 'attention' && (['error', 'permission', 'input'].includes(activity.kind) || branchFacts.get(row.id)?.pending))
            || (filter === 'unread' && (controller.sidebar.isUnread(row.id, row.updatedAt) || branchFacts.get(row.id)?.selected))
    })
    const expandedIds = new Set(expanded)
    const showChildren = (branch: SidebarBranch): boolean => {
        const facts = branchFacts.get(branch.row.id)
        return Boolean(query.trim()) || Boolean(timeRange) || expandedIds.has(branch.row.id)
            || facts?.pendingDescendant === true || facts?.selected === true && selectedId !== branch.row.id
    }
    let previousRootTime: number | undefined
    const recentRows = projectSidebarRows(tree, showChildren).map(item => {
        const time = recency.timeFor(item.branch.row), followingDay = previousRootTime !== undefined
        const heading = item.depth === 0 ? sidebarDayLabel(time, previousRootTime, { today: t('today'), yesterday: t('yesterday') }, document.documentElement.lang || undefined) : null
        if (item.depth === 0) previousRootTime = time
        return { ...item, heading, followingDay, day: localDayKey(time) }
    })
    const action = (id: string, kind: 'pin' | 'unpin' | 'archive' | 'unarchive' | 'fork'): void => {
        const row = snapshot.catalog.byId[id]
        if (row?.hostId === 'local' && sourceIdentity(row)) {
            controller.openNativeTools(id, kind === 'unarchive' ? 'reopen' : kind === 'unpin' ? 'pin' : kind)
        } else void controller.sessionAction(id, kind).catch(controller.report)
    }
    const openSourceDialog = (kind: 'rename' | 'export' | 'migration', row: WorkspaceCatalogRow): void => {
        const facts = sidebarActionFacts(row), location = sessionLocation(row)
        if (!facts.localSource || !facts.source) return
        setSourceDialog({ kind, row, source: { sourceSessionId: facts.source.sessionId,
            ...(facts.source.hubId ? { sourceHubId: facts.source.hubId } : {}), ...(location.machineId ? { machineId: location.machineId } : {}) } })
    }
    const reseed = (): void => { recency.reconcile(rows, true) }
    useEffect(() => {
        if (!snapshot.pickingSession) return
        if (!mobile) revealSidebar.current()
        setSearchExpanded(true)
        const frame = requestAnimationFrame(() => {
            input.current?.focus()
            if (!mobile && input.current) controller.closeSessionPicker()
        })
        return () => { cancelAnimationFrame(frame) }
    }, [snapshot.pickingSession, mobile, wide, controller])
    useEffect(() => {
        if (!mobile || !snapshot.pickingSession) return
        const close = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') { event.preventDefault(); controller.closeSessionPicker() }
        }
        window.addEventListener('keydown', close)
        return () => { window.removeEventListener('keydown', close) }
    }, [mobile, snapshot.pickingSession, controller])
    if (!wide && !(mobile && snapshot.pickingSession)) return <div className="hapi-session-rail"><IconButton label={t('showSidebar')} icon="sidebar" onClick={expandSidebar}/><span>{rows.length}</span></div>
    const renderRow = ({ branch, depth, expanded: childrenVisible }: SidebarTreeRow): ReactNode => {
        const { row, children } = branch
        const facts = sidebarActionFacts(row), child = facts.child
        const location = sessionLocation(row)
        const machineLabel = readableHost(location.machineName ?? row.hostLabel)
        const worktree = sourceWorktreeLabel(row)
        const activity = sessionActivity(row)
        const isSelected = selectedId === row.id
        const unread = controller.sidebar.isUnread(row.id, row.updatedAt)
        const destination = destinations.get(row.id)
        return <div key={row.id} className="hapi-session-branch" style={{ '--hapi-row-depth': Math.min(depth, 8) } as CSSProperties}>
            <article className={`hapi-session-row${isSelected ? ' hapi-session-selected' : ''}`} data-session-row={row.id} data-session-view-anchor={`session:${row.id}`} data-unread={unread || undefined}>
                {children.length > 0 && <button type="button" className="hapi-tree-toggle" aria-label={`${t('subagents')} · ${row.displayTitle}`} aria-expanded={childrenVisible}
                    onClick={() => controller.sidebar.toggle('expanded', row.id)}>{childrenVisible ? '▾' : '▸'}<span>{children.length}</span></button>}
                <SidebarActionSurface rowId={row.id} title={row.displayTitle} label={t('actions')} icon={<WorkspaceIcon kind="more"/>} actions={<>
                    <button role="menuitem" type="button" onClick={() => controller.openSession(row.id)}>{t('openCurrent')}</button>
                    <button role="menuitem" type="button" onClick={() => controller.openSession(row.id, 'horizontal')}>{t('openBeside')}</button>
                    <button role="menuitem" type="button" onClick={() => controller.openSession(row.id, 'vertical')}>{t('openBelow')}</button>
                    <hr role="separator"/>
                    {!child && <button role="menuitem" type="button" onClick={() => facts.localSource ? openSourceDialog('rename', row) : setRename({ id: row.id, title: row.displayTitle })}>{t('rename')}</button>}
                    {facts.localSource && <button role="menuitem" type="button" onClick={() => controller.openNativeTools(row.id)}>{t('sessionTools')}</button>}
                    {facts.localSource && <button role="menuitem" type="button" onClick={() => controller.openNativeTools(row.id, 'pin')}>{t('editSummary')}</button>}
                    <button role="menuitem" type="button" onClick={() => unread ? controller.sidebar.markSeen(row.id, row.updatedAt) : controller.sidebar.markUnread(row.id, row.updatedAt)}>{t(unread ? 'markRead' : 'markUnread')}</button>
                    {!child && (facts.localSource ? <><SourcePinButton api={api} workspace={controller} row={row} mode="project" t={t}/><SourcePinButton api={api} workspace={controller} row={row} mode="global" t={t}/></>
                        : !facts.source && <button role="menuitem" type="button" onClick={() => action(row.id, pinnedIds.has(row.id) ? 'unpin' : 'pin')}>{t(pinnedIds.has(row.id) ? 'unpin' : 'pin')}</button>)}
                    {!child && (!facts.source || facts.localSource) && <button role="menuitem" type="button" disabled={location.engine === 'codex' && !controls} title={t('fork')} onClick={() => {
                        if (observedProjection(row)) controller.openNativeTools(row.id, 'fork')
                        else if (location.engine === 'codex') setFork({ id: row.id, sourceId: row.sourceSessionId })
                        else action(row.id, 'fork')
                    }}>{t('fork')}</button>}
                    {facts.localSource && <button role="menuitem" type="button" onClick={() => openSourceDialog('export', row)}>{t('exportSession')}</button>}
                    {facts.canMigrate && <button role="menuitem" type="button" onClick={() => openSourceDialog('migration', row)}>{t('migrateSession')}</button>}
                    {!child && <>
                        {facts.localSource && facts.sourceActive === true && <button role="menuitem" type="button" onClick={() => controller.openNativeTools(row.id, 'restart')}>{t('restartSession')}</button>}
                        {facts.localSource && facts.sourceActive !== null && <button role="menuitem" type="button" onClick={() => controller.openNativeTools(row.id, facts.sourceActive ? 'archive' : 'reopen')}>{t(facts.sourceActive ? 'archive' : 'unarchive')}</button>}
                        {facts.localSource && facts.sourceActive === false && <button role="menuitem" type="button" data-danger="true" onClick={() => controller.openNativeTools(row.id, 'delete')}>{t('deleteSession')}</button>}
                        {!facts.source && <button role="menuitem" type="button" onClick={() => action(row.id, archivedIds.has(row.id) ? 'unarchive' : 'archive')}>{t(archivedIds.has(row.id) ? 'unarchive' : 'archive')}</button>}
                    </>}
                    <hr role="separator"/>
                    {facts.sourceId && <button role="menuitem" type="button" onClick={() => { void navigator.clipboard.writeText(facts.sourceId!).catch(controller.report) }}>{t('copySourceId')}</button>}
                    {facts.source && <button role="menuitem" type="button" disabled={!facts.nativeId} title={facts.nativeId ?? t('nativeIdUnavailable')} onClick={() => { if (facts.nativeId) void navigator.clipboard.writeText(facts.nativeId).catch(controller.report) }}>{t('copyNativeId')}</button>}
                    <button role="menuitem" type="button" onClick={() => { void navigator.clipboard.writeText(facts.displayId).catch(controller.report) }}>{t(facts.source ? 'copyDisplayId' : 'copyId')}</button>
                </>}>{handlers => <button {...handlers} type="button" className="hapi-session-open" aria-haspopup="menu" aria-current={isSelected ? 'page' : undefined} onClick={event => controller.openSession(row.id, event.shiftKey ? 'horizontal' : undefined)} title={[row.displayTitle, readableEngine(location.engine), machineLabel, row.cwd, worktree].filter(Boolean).join('\n')}
                    draggable onDragStart={event => { event.stopPropagation(); writeWorkspaceDrag(event.dataTransfer, { kind: 'session', sessionId: row.id }) }}>
                    <div className="hapi-session-title"><ActivityDot {...activity} t={t}/><span>{pinnedIds.has(row.id) && '⌁ '}{row.displayTitle}</span>{unread && <span className="hapi-unread-dot" aria-label={t('unread')}/>}<SessionTime at={row.updatedAt} t={t}/></div>
                    <div className="hapi-session-meta"><span className={`hapi-engine hapi-engine-${location.engine === 'codex' ? 'codex' : 'dsh'}`} title={t('engine')}>{readableEngine(location.engine)}</span>
                        {machineLabel && <span className="hapi-ellipsis">{machineLabel}</span>}{destination ? <span className="hapi-session-destination" title={t('selected')}>{destination.label}</span> : <span className="hapi-ellipsis hapi-session-directory">{worktree ?? row.cwd?.split(/[\\/]/).filter(Boolean).at(-1)}</span>}
                    </div>
                    <div className="hapi-session-source-state"><SessionRowState state={row.sourceRowState} detailed={!mobile || statusMode === 'detailed'} t={t}/></div>
                </button>}</SidebarActionSurface>
            </article>
        </div>
    }
    const renderBranch = (branch: SidebarBranch): ReactNode => projectSidebarRows([branch], showChildren).map(renderRow)
    const renderRecentRow = (item: typeof recentRows[number]): ReactNode => <>
        {item.heading && <div className="hapi-session-date" data-session-scroll-anchor={`day:${item.day}:${item.id}`} data-following-day={item.followingDay || undefined}>{item.heading}</div>}
        {renderRow(item)}
    </>
    const pinned = tree.filter(({ row }) => globalPinnedIds.has(row.id))
    const unpinned = tree.filter(({ row }) => !globalPinnedIds.has(row.id))
    const buckets = sidebarActivityBuckets(unpinned, pinInProgressSessions, pinnedIds)
    const floated = new Set(Object.values(buckets).flat().map(branch => branch.row.id))
    const groups = new Map<string, { path: string; machine: string; children: SidebarBranch[]; sourceRow: WorkspaceCatalogRow }>()
    for (const branch of unpinned) {
        const folder = sessionFolder(branch.row)
        const group = groups.get(folder.key) ?? { ...folder, children: [], sourceRow: branch.row }
        if (!floated.has(branch.row.id)) group.children.push(branch)
        groups.set(folder.key, group)
    }
    const rank = (row: WorkspaceCatalogRow): number => sidebarSessionActive(row) ? sessionActivity(row).pending ? 0 : 1 : 2
    for (const group of groups.values()) group.children.sort((left, right) => Number(pinnedIds.has(right.row.id)) - Number(pinnedIds.has(left.row.id))
        || (hasQuery ? compareSidebarSearch(left.row, right.row, searchIndex) : rank(left.row) - rank(right.row)))
    const groupKeys = [...folderOrder.filter(key => groups.has(key)), ...[...groups.keys()].filter(key => !folderOrder.includes(key))]
    if (hasQuery) {
        const score = new Map([...groups].map(([key, group]) => [key, Math.max(0, ...group.children.map(branch => searchIndex.scores.get(branch.row.id) ?? 0))]))
        groupKeys.sort((left, right) => score.get(right)! - score.get(left)!)
    }
    const moveFolder = (key: string, delta: -1 | 1): void => {
        const index = groupKeys.indexOf(key), next = [...groupKeys]
        const target = index + delta
        if (index < 0 || target < 0 || target >= next.length) return
        ;[next[index], next[target]] = [next[target]!, next[index]!]
        controller.sidebar.change({ folderOrder: next })
    }
    const renderSection = (key: string, label: WorkspaceKey, sections: Array<{ label: WorkspaceKey; children: readonly SidebarBranch[] }>): ReactNode => {
        const total = sections.reduce((sum, section) => sum + section.children.length, 0)
        if (!total) return null
        const closed = collapsed.includes(key) && !query.trim() && !timeRange
        return <section className="hapi-sidebar-section" data-sidebar-section={key} aria-label={t(label)}>
            <button type="button" aria-expanded={!closed} onClick={() => controller.sidebar.toggle('collapsed', key)} data-session-scroll-anchor={`section:${key}`}><span>{closed ? '▸' : '▾'}</span><strong>{t(label)}</strong><span>{total}</span></button>
            {!closed && sections.filter(section => section.children.length).map(section => <div key={section.label} role="group" aria-label={t(section.label)}>
                {sections.length > 1 && <div className="hapi-bucket-heading">{t(section.label)}</div>}{section.children.map(branch => renderBranch(branch))}
            </div>)}
        </section>
    }
    const body = <div className={`hapi-session-sidebar${mobile && snapshot.pickingSession ? ' hapi-session-picker' : ''}`}>
        <header><strong>{t('allChats')}</strong><span className="hapi-sidebar-count" title={`${tree.length} ${t('sessions')}`}>{tree.length}</span>
            {snapshot.pickingSession && <button type="button" className="hapi-picker-back" onClick={controller.closeSessionPicker}>{t('backToWorkspace')}</button>}
            <IconButton label={t('refresh')} icon="refresh" onClick={() => { reseed(); void controller.refresh() }}/>
        </header>
        <SidebarSearchControls query={query} onQueryChange={setQuery} start={dateFrom} end={dateThrough} onDatesChange={(start, end) => { setDateFrom(start); setDateThrough(end) }}
            activityDates={activityDates} expanded={searchExpanded} onExpandedChange={setSearchExpanded} inputRef={input} t={t}/>
        <div className="hapi-sidebar-toolbar">
            <div className="hapi-list-modes" role="group" aria-label={t('allChats')}>
                <button type="button" aria-pressed={mode === 'recent'} onClick={() => { reseed(); controller.sidebar.change({ mode: 'recent' }) }}>{t('recent')}</button>
                <button type="button" aria-pressed={mode === 'folders'} onClick={() => { controller.sidebar.change({ mode: 'folders' }) }}>{t('folders')}</button>
            </div>
            <select className="hapi-status-select" aria-label={t('statusFilter')} value={filter} onChange={event => controller.sidebar.change({ filter: event.currentTarget.value as SidebarFilter })}>
                {(['all', 'running', 'attention', 'unread'] as SidebarFilter[]).map(key => <option key={key} value={key}>{t(key)}{counts[key] ? ` · ${counts[key]}` : ''}</option>)}
            </select>
            <button type="button" className="hapi-mark-all" onClick={() => controller.sidebar.markAllSeen(matching)} title={t('markAllRead')} aria-label={t('markAllRead')}>✓</button>
        </div>
        <details className="hapi-sidebar-options"><summary>{t('sidebarOptions')}</summary>
            <div className="hapi-session-filters">
                <select aria-label={t('engine')} value={engine} onChange={event => controller.sidebar.change({ engine: event.currentTarget.value })}><option value="">{t('allEngines')}</option>{engines.map(value => <option key={value} value={value}>{readableEngine(value)}</option>)}</select>
                <select aria-label={t('machine')} value={machine} onChange={event => controller.sidebar.change({ machine: event.currentTarget.value })}><option value="">{t('allMachines')}</option>{machines.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
            </div>
            <label><input type="checkbox" checked={pinInProgressSessions} onChange={event => controller.sidebar.change({ pinInProgressSessions: event.currentTarget.checked })}/>{t('floatActiveSessions')}</label>
            <label><input type="checkbox" checked={showActiveSessionsOnly} onChange={event => controller.sidebar.change({ showActiveSessionsOnly: event.currentTarget.checked })}/>{t('activeSessionsOnly')}</label>
            <label>{t('sessionPreviewLimit')}<input type="number" min={1} max={99} step={1} value={sessionPreviewLimit} onChange={event => { if (event.currentTarget.value) controller.sidebar.change({ sessionPreviewLimit: event.currentTarget.valueAsNumber }) }}/></label>
            <label>{t('mobileStatusMode')}<select aria-label={t('mobileStatusMode')} value={statusMode} onChange={event => controller.sidebar.change({ statusMode: event.currentTarget.value === 'detailed' ? 'detailed' : 'standard' })}>
                <option value="standard">{t('standardStatus')}</option><option value="detailed">{t('detailedStatus')}</option></select></label>
        </details>
        <div className="hapi-session-list" aria-label={t('allChats')} ref={setScrollElement}>
            <SidebarScrollAnchor view={mode} scope={bookmarkScope} bookmarks={bookmarks} hasSessions={rows.length > 0} sessions={recentRows} onScrollRestored={onScrollRestored}>
            {!tree.length && <p className="hapi-list-empty" role="status">{snapshot.catalog.phase === 'ready' ? t('noSessions') : t('loading')}</p>}
            {mode === 'recent' ? <SidebarWindow items={recentRows} scrollElement={scrollElement} scrollObserverRef={scrollObserver} selectedId={selectedId}
                narrow={mobile} renderItem={renderRecentRow} estimateSize={(item, base) => base + (item.heading ? item.followingDay ? 37 : 26 : 0)}/> : <>
                {renderSection('global-pinned', 'pinnedGroup', [{ label: 'pinnedGroup', children: pinned }])}
                {renderSection('in-progress', 'inProgressGroup', (['working', 'pending'] as SidebarActivityBucket[]).map(key => ({ label: key === 'working' ? 'running' : 'pendingGroup', children: buckets[key] })))}
                {renderSection('active', 'activeGroup', (['active', 'idle'] as SidebarActivityBucket[]).map(key => ({ label: key === 'active' ? 'activeGroup' : 'idleGroup', children: buckets[key] })))}
                {groupKeys.map((key, index) => {
                const group = groups.get(key)!, closed = collapsed.includes(key) && !query.trim() && !timeRange
                const cap = Math.min(Math.max(sessionPreviewLimit, previewCounts.get(key) ?? sessionPreviewLimit), group.children.length)
                const shown = sidebarPreview(group.children, cap, branchFacts)
                const previousCap = previousSidebarPreview(cap, sessionPreviewLimit)
                const previousSize = sidebarPreview(group.children, previousCap, branchFacts).length
                const hiddenCount = group.children.length - shown.length
                const fewer = previousCap < cap && shown.length > previousSize
                return <section key={key} className="hapi-folder" data-folder={key}>
                    <header data-session-scroll-anchor={`folder:${key}`}><button type="button" aria-expanded={!closed} onClick={() => controller.sidebar.toggle('collapsed', key)} title={`${group.machine} · ${group.path}`}>
                        <span>{closed ? '▸' : '▾'}</span><span className="hapi-folder-name">{group.path.split(/[\\/]/).filter(Boolean).at(-1) || t('unknownFolder')}</span><small>{group.machine}</small><span>{group.children.length}</span></button>
                        <details className="hapi-menu"><summary aria-label={t('more')}><WorkspaceIcon kind="more"/></summary><div className="hapi-menu-content">
                            <button type="button" disabled={!group.path} onClick={() => controller.requestNewSessionInDirectory(group.sourceRow.id, group.path)}>{t('newHere')}</button>
                            <button type="button" disabled={!group.path} onClick={() => { void navigator.clipboard.writeText(group.path).catch(controller.report) }}>{t('copyDirectory')}</button>
                            <button type="button" disabled={index === 0} onClick={() => moveFolder(key, -1)}>{t('folderUp')}</button><button type="button" disabled={index === groupKeys.length - 1} onClick={() => moveFolder(key, 1)}>{t('folderDown')}</button>
                        </div></details>
                    </header>
                    {!closed && <>{shown.map(branch => renderBranch(branch))}
                        {(hiddenCount > 0 || fewer) && <div className="hapi-folder-preview-actions">
                            {hiddenCount > 0 && <button type="button" onClick={() => setPreviewCounts(previous => new Map(previous).set(key, nextSidebarPreview(Math.max(cap, shown.length), sessionPreviewLimit, group.children.length)))}>{t('showMoreSessions')} · {Math.min(sessionPreviewLimit, hiddenCount)}</button>}
                            {fewer && <button type="button" onClick={() => setPreviewCounts(previous => new Map(previous).set(key, previousCap))}>{t('showFewerSessions')} · {shown.length - previousSize}</button>}
                        </div>}
                    </>}
                </section>
            })}</>}
            </SidebarScrollAnchor>
        </div>
        <label className="hapi-archived-toggle"><input type="checkbox" checked={archived} onChange={event => setArchived(event.currentTarget.checked)}/>{t('showArchived')}</label>
        <div className="hapi-sidebar-native"><button type="button" onClick={controller.openNativeLibrary}>{t('nativeHistory')}</button>
            <details><summary>{t('machines')} · {snapshot.machines.filter(machine => machine.online).length} / {snapshot.machines.length}</summary>
                {snapshot.machines.map(machine => <MachineHealthRow key={machine.id} machine={machine} language={language}/>)}
            </details>
        </div>
        {rename && <RenameDialog title={t('rename')} initial={rename.title} save={title => controller.renameSession(rename.id, title)} close={() => setRename(null)} t={t}/>}
        {sourceDialog && <Dialog title={t(sourceDialog.kind === 'rename' ? 'rename' : sourceDialog.kind === 'export' ? 'exportSession' : 'migrateSession')} close={() => setSourceDialog(null)} t={t}>
            {sourceDialog.kind === 'rename' ? <SourceTitlePanel api={api} source={sourceDialog.source} sessionId={sourceDialog.row.sourceSessionId} active language={language} onRename={title => controller.renameSession(sourceDialog.row.id, title)}/>
                : sourceDialog.kind === 'migration' ? <SourceMigrationPanel api={api} sessionId={sourceDialog.row.sourceSessionId} language={language} onOpen={id => { void controller.refresh(); controller.openSession(id); setSourceDialog(null) }}
                    onSuccessor={id => { const from = sourceDialog.row.id; setSourceDialog(null); void controller.openSuccessorSession(from, id).catch(controller.report) }}/>
                : <SourceExportPanel api={api} source={sourceDialog.source} language={language} preferences={controller.options.storage} mode="download" onDownloaded={() => setSourceDialog(null)}/>}
        </Dialog>}
        {fork && controls && <Dialog title={t('fork')} close={() => setFork(null)} t={t}><NativeForkContent ledger={controls} sessionId={fork.sourceId} t={t} open={sessionId => {
            void controller.refresh(); controller.openSession(sessionId, 'horizontal'); setFork(null)
        }}/></Dialog>}
    </div>
    return mobile && snapshot.pickingSession ? createPortal(<div className="hapi-mobile-session-layer" role="dialog" aria-modal="true" aria-label={t('allChats')}>{body}</div>, document.body) : body
}
