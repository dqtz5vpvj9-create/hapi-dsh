/**
 * One official AppFrame hosts every explicit Session view of its Host.
 *
 * The additive shell seat preserves the renderer's installed scope adapters.
 * Each portal is a separate occurrence of the public Conversation factory,
 * following the pinned ui-subagent sidebar-chat composition. No second root,
 * navigation selection, store adapter, or composer implementation is created.
 */
import type { Context } from '@deepseek-ai/cordis'
import { Component, memo, useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ConversationViewsProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsRenderFactories, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { WorkspacePaneNavigation } from '../pane-navigation.ts'
import { WorkspacePaneProvider } from './pane-context.tsx'
import { installSharedRightbar } from './shared-rightbar.tsx'
import { bindInitialHistory } from '../seamless/index.ts'
import { bindPaneReading } from '../reading-view.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface SlotMap {
        'hapi.workspace.session-view': { kind: 'single'; scope: 'session' }
        'hapi.workspace.shared-rightbar': { kind: 'single'; scope: 'session' }
    }
}

/** The caller owns the reference and releases it after removing this view. */
export interface SessionViewMount {
    readonly paneId: string
    /** A retired draft-transfer occurrence may coexist with its pane successor. */
    readonly instanceId?: string | undefined
    readonly reference: SessionReference
    readonly target: HTMLElement
    readonly navigation: WorkspacePaneNavigation
    /** The reference is ready and its registered view has committed. */
    readonly onReady?: (() => void) | undefined
    readonly onError?: ((error: unknown) => void) | undefined
}

export interface SessionViewHandle {
    /** Changing presentation preserves the factory occurrence and editor DOM. */
    update(options: { navigation?: WorkspacePaneNavigation | undefined }): void
    /** Waits for portal unmount before its owner may release the reference. */
    dispose(): Promise<void>
}

interface ViewLifetime { mounted: boolean; removed?: (() => void) | undefined }

interface Entry extends SessionViewMount {
    readonly key: number
    readonly lifetime: ViewLifetime
    readonly phase: 'loading' | 'ready' | 'error'
    readonly error?: unknown
}

type HostProps = PropsRuntime<'shell.overlay'> & PropsRenderSlots<'hapi.workspace.session-view' | 'hapi.workspace.shared-rightbar'>
type ContentProps = PropsRuntime<'hapi.workspace.session-view'> & PropsRenderFactories

/** A local factory position may render only children declared by that factory. */
function ChatViews({ renderSlot }: ConversationViewsProps): ReactNode {
    return renderSlot('conversation.session', { view: 'chat' })
}

/** Same public binding and phase inputs as the official embedded child chat. */
function SessionContent({ sessionId, useSession, useConversation, useSessions, renderFactorySlot }: ContentProps): ReactNode {
    const activeTargets = useConversation(value => value.activeTargets.size > 0)
    const summaryBlank = useSessions(state => state.byId[sessionId]?.blank)
    // Subscribe only to shell phase. Streaming text, queue receipts and draft
    // edits have their own subscriptions below this factory occurrence.
    const phase = useSession(session => {
        const active = activeTargets || (!session.blank && !session.awaitingFirstTurn) || session.running
        const blank = !active && !session.promptAttempted
        const parentPending = session.subagent?.address.mode === 'continuable' && session.subagent.parentAvailable === undefined
        if ((blank && session.openState === 'loading' && summaryBlank !== true) || parentPending) return 'settling'
        return blank && (session.openState === 'open' || summaryBlank === true) ? 'hero' : 'active'
    })
    return renderFactorySlot('conversation.content', {
        variant: 'embedded', phase, hero: phase === 'hero',
    }, { slots: { views: ChatViews } })
}

function Failure({ error }: { error: unknown }): ReactNode {
    return <div className="hapi-empty" role="alert"><p>{error instanceof Error ? error.message : String(error)}</p></div>
}

class ViewBoundary extends Component<{ onError?: ((error: unknown) => void) | undefined; children: ReactNode }, { error?: unknown }> {
    override state: { error?: unknown } = {}
    static getDerivedStateFromError(error: unknown): { error: unknown } { return { error } }
    override componentDidCatch(error: unknown): void { this.props.onError?.(error) }
    override render(): ReactNode { return this.state.error === undefined ? this.props.children : <Failure error={this.state.error}/> }
}

function ViewFrame({ entry, children }: { entry: Entry; children: ReactNode }): ReactNode {
    const announced = useRef(false)
    useLayoutEffect(() => {
        entry.lifetime.mounted = true
        return () => { entry.lifetime.mounted = false; entry.lifetime.removed?.() }
    }, [entry.lifetime])
    useLayoutEffect(() => {
        if (entry.phase === 'ready' && !announced.current) { announced.current = true; entry.onReady?.() }
    }, [entry.phase, entry.onReady])
    return <div data-hapi-session-view={entry.reference.sessionId} data-hapi-session-pane={entry.paneId}
        style={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%', width: '100%', overflow: 'hidden' }}>
        {entry.phase === 'error' ? <Failure error={entry.error}/> : children}
    </div>
}

/** The pin caches both public faces; unchanged entries need no sibling render.
 * Session, locale, and slot subscriptions below remain independently active. */
const SessionOccurrence = memo(function SessionOccurrence({ entry, SessionProvider, renderSlot }:
    Pick<HostProps, 'SessionProvider' | 'renderSlot'> & { entry: Entry }): ReactNode {
    return <WorkspacePaneProvider value={entry.navigation}>
        <ViewBoundary onError={entry.onError}>
            <ViewFrame entry={entry}>
                <SessionProvider session={entry.reference}>
                    {renderSlot('hapi.workspace.session-view', {})}
                    {renderSlot('hapi.workspace.shared-rightbar', {})}
                </SessionProvider>
            </ViewFrame>
        </ViewBoundary>
    </WorkspacePaneProvider>
})

/**
 * Install exactly once per official Client Context. The graph owner must render
 * that Context's AppFrame once; portals inherit its public scope and slot hosts.
 * Closing a handle never releases a different view or terminates execution.
 */
export function installSessionViewHost(ctx: Context): {
    mount(options: SessionViewMount): SessionViewHandle
    size(): number
    dispose(): void
} {
    const entries = new Map<string, Entry>()
    const initialHistory = new Map<string, () => void>()
    const listeners = new Set<() => void>()
    let snapshot: readonly Entry[] = []
    let sequence = 0
    let disposed = false
    const publish = (): void => {
        snapshot = [...entries.values()]
        for (const listener of listeners) listener()
    }
    const subscribe = (listener: () => void): (() => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
    const getSnapshot = (): readonly Entry[] => snapshot
    const Host = ({ SessionProvider, renderSlot }: HostProps): ReactNode => {
        const views = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
        return <>{views.map(entry => createPortal(
            <SessionOccurrence entry={entry} SessionProvider={SessionProvider} renderSlot={renderSlot}/>, entry.target, String(entry.key),
        ))}</>
    }
    const disposers: Array<() => void> = []
    try {
        disposers.push(ctx.slots.inject('shell.overlay', () => ctx.slots.register({
            name: 'shell.overlay', id: 'hapi.workspace.session-views',
            children: {
                'hapi.workspace.session-view': { kind: 'single', scope: 'session' },
                'hapi.workspace.shared-rightbar': { kind: 'single', scope: 'session' },
            },
        }, Host)))
        disposers.push(ctx.slots.inject('hapi.workspace.session-view', () => ctx.slots.register({ name: 'hapi.workspace.session-view' }, SessionContent)))
        disposers.push(installSharedRightbar(ctx))
    } catch (error) { for (const dispose of disposers.reverse()) dispose(); throw error }
    return {
        mount(options) {
            if (disposed) throw new Error('The Host session-view surface is disposed')
            const identity = options.instanceId ?? options.paneId
            if (entries.has(identity)) throw new Error(`Pane ${options.paneId} already has a session view on this Host`)
            let entry: Entry = { ...options, key: ++sequence, lifetime: { mounted: false }, phase: 'loading' }
            entries.set(identity, entry); publish()
            const stopHistory = bindInitialHistory(options.target, options.reference, options.navigation)
            const stopReading = bindPaneReading(ctx, options.target, options.reference, options.navigation)
            const uninitialHistory = (): void => { stopHistory(); stopReading() }
            initialHistory.set(identity, uninitialHistory)
            let live = true
            let removed: Promise<void> | undefined
            void options.reference.ready.then(() => {
                if (!live || disposed) return
                entry = { ...entry, phase: 'ready' }; entries.set(identity, entry); publish()
            }, error => {
                if (!live || disposed) return
                entry = { ...entry, phase: 'error', error }; entries.set(identity, entry); publish()
                entry.onError?.(error)
            })
            return {
                update(next) {
                    if (!live || disposed || next.navigation === undefined || next.navigation === entry.navigation) return
                    entry = { ...entry, navigation: next.navigation }; entries.set(identity, entry); publish()
                },
                dispose() {
                    if (removed) return removed
                    live = false
                    uninitialHistory()
                    initialHistory.delete(identity)
                    removed = entry.lifetime.mounted ? new Promise<void>(resolve => { entry.lifetime.removed = resolve }) : Promise.resolve()
                    if (entries.get(identity)?.key === entry.key) { entries.delete(identity); publish() }
                    return removed
                },
            }
        },
        size: () => entries.size,
        dispose() {
            if (disposed) return
            disposed = true
            for (const dispose of initialHistory.values()) dispose()
            initialHistory.clear(); entries.clear(); publish()
            for (const dispose of disposers.reverse()) dispose()
            listeners.clear()
        },
    }
}
