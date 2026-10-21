import type { ISessions, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/**
 * An official refresh can resolve with a folded transport failure before the
 * Peer connects. Only this graph's observable catalog proves a retain target.
 * Retry reads while connecting; never infer ownership from another graph.
 */
export function waitForCatalogSession(
    sessions: Pick<ISessions, 'list' | 'refresh'>,
    sessionId: SessionId,
    signal: AbortSignal,
    options: { timeoutMs?: number; retryMs?: number; accept?: (session: SessionSummary) => boolean } = {},
): Promise<void> {
    signal.throwIfAborted()
    const available = (): boolean => {
        const row = sessions.list.getSnapshot().byId[sessionId]
        return row !== undefined && (options.accept?.(row) ?? true)
    }
    if (available()) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
        let done = false
        let retry: ReturnType<typeof setTimeout> | undefined
        let unsubscribe: (() => void) | undefined
        let lastFailure: unknown
        const settle = (error?: unknown): void => {
            if (done) return
            done = true
            clearTimeout(timeout)
            if (retry !== undefined) clearTimeout(retry)
            unsubscribe?.()
            signal.removeEventListener('abort', abort)
            if (error === undefined) resolve()
            else reject(error)
        }
        const check = (): boolean => {
            if (done) return true
            if (!available()) return false
            settle()
            return true
        }
        const abort = (): void => { settle(signal.reason ?? new Error('Conversation opening was cancelled')) }
        const timeout = setTimeout(() => {
            const error = new Error('This conversation is not listed by its Host yet. The original HAPI catalog may still be attaching existing sessions; retry the pane once the catalog has loaded.')
            error.name = 'SessionCatalogTimeout'
            Object.assign(error, { sessionId, cause: lastFailure })
            settle(error)
        }, options.timeoutMs ?? 30_000)
        const refresh = async (): Promise<void> => {
            if (check()) return
            try { await sessions.refresh() }
            catch (error) { lastFailure = error }
            if (!check()) retry = setTimeout(() => { void refresh() }, options.retryMs ?? 1_000)
        }
        signal.addEventListener('abort', abort, { once: true })
        unsubscribe = sessions.list.subscribe(check)
        if (signal.aborted) abort()
        else void refresh()
    })
}

/** Prefixes of display Sessions owned by the HAPI adapter, never ordinary DSH sessions. */
const SOURCE_DISPLAY_ID = /^hapi-(?:codex|observed)-[0-9a-f]{32}(?:-r\d+)?$/

export function isSourceDisplaySessionId(sessionId: string): boolean {
    return SOURCE_DISPLAY_ID.test(sessionId)
}

/** `x-r2` and `x` are the same logical display Session across a rewind generation. */
export function displaySessionBaseId(sessionId: string): string {
    return sessionId.replace(/-r\d+$/, '')
}

export function displaySessionRevision(sessionId: string): number | undefined {
    const match = /-r(\d+)$/.exec(sessionId)
    return match ? Number(match[1]) : undefined
}

/**
 * Why a saved pane cannot attach its target. Each reason carries the human
 * explanation and the concrete next step; raw identifiers and transport text
 * stay in `detail` so they never become the primary error message.
 */
export type PaneOpenFailure = 'address-invalid' | 'host-offline' | 'catalog-loading' | 'source-offline'
    | 'source-archived' | 'source-not-found' | 'source-hub-changed' | 'session-archived'
    | 'session-not-listed' | 'binding-denied' | 'binding-failed'

export interface PaneOpenState {
    readonly reason: PaneOpenFailure
    /** The catalog can still publish this target; retry without user action. */
    readonly transient: boolean
    /** A manual retry is meaningful once the stated condition changes. */
    readonly retryable: boolean
    readonly message: string
    readonly nextStep: string
    readonly detail: string
}

export interface PaneOpenContext {
    /** `source` panes carry an original HAPI Session identity; `display` panes only a DSH display id. */
    readonly kind: 'source' | 'display'
    readonly label: string
    readonly hostId: string
    readonly sessionId: string
    readonly sourceSessionId?: string
    /** Hub identity recorded with the saved pane. */
    readonly savedHubId?: string
    /** Hub identity the Host currently reports; null before the first catalog. */
    readonly currentHubId?: string | null
    readonly sourcePhase: 'pending' | 'ready' | 'unavailable'
    readonly sourceError?: string | null
    /** The official Host Session list (not the HAPI source catalog) state. */
    readonly localPhase: 'pending' | 'ready'
    readonly hostRegistered: boolean
    readonly hostOnline: boolean
    /** Enough calm catalog time has passed to treat an absence as authoritative. */
    readonly settled: boolean
    readonly archived?: boolean
    readonly sourceLifecycle?: string | null
    readonly machineLabel?: string
    readonly machineOnline?: boolean
    /** Raw retain/source error; reported in `detail`, never as the headline. */
    readonly error?: string
}

const detailOf = (values: ReadonlyArray<string | undefined>): string => values.filter((value): value is string => Boolean(value && value.trim())).join(' · ')

function paneOpen(reason: PaneOpenFailure, state: Omit<PaneOpenState, 'reason' | 'detail'>, detail: string): PaneOpenState {
    return { reason, ...state, detail }
}

/**
 * Classify a pane whose saved target is not currently available. This is the
 * single place that distinguishes a transient catalog attach from an offline
 * source, an archived/deleted session, a changed Hub identity, and a Host
 * binding rejection. Callers render `message` + `nextStep`; `detail` is only
 * for diagnostics.
 */
export function paneOpenState(context: PaneOpenContext): PaneOpenState {
    const detail = detailOf([`host=${context.hostId}`, `session=${context.sessionId}`,
        context.sourceSessionId ? `source=${context.sourceSessionId}` : undefined,
        context.savedHubId ? `savedHub=${context.savedHubId}` : undefined,
        context.currentHubId ? `currentHub=${context.currentHubId}` : undefined,
        context.sourceError ? `sourceError=${context.sourceError}` : undefined,
        context.error ? `error=${context.error}` : undefined])
    const sourceHosted = context.kind === 'source' || isSourceDisplaySessionId(context.sessionId)
    if (!context.hostRegistered) {
        return paneOpen('host-offline', { transient: true, retryable: true,
            message: context.label
                ? `The workspace for ${context.label} is not connected right now.`
                : 'The machine that owns this pane is not connected right now.',
            nextStep: 'This pane reopens automatically when the machine reconnects; check the Runner connection before retrying.',
        }, detail)
    }
    if (!context.hostOnline) {
        return paneOpen('host-offline', { transient: true, retryable: true,
            message: context.label
                ? `${context.label} is offline, so this pane cannot attach its conversation.`
                : 'The machine that owns this pane is offline, so the conversation cannot attach yet.',
            nextStep: 'Reconnect the machine; the pane reopens automatically once the Host is reachable.',
        }, detail)
    }
    if (sourceHosted && context.sourcePhase === 'unavailable') {
        const machine = context.machineLabel ? ` (${context.machineLabel})` : ''
        return paneOpen('source-offline', { transient: true, retryable: true,
            message: `The original HAPI Hub${machine} is unreachable, so the source session behind this pane cannot be resolved.`,
            nextStep: 'No execution is interrupted by this view. Restore the Hub/Runner connection and the pane reopens by itself.',
        }, detail)
    }
    if (context.localPhase === 'pending' || (sourceHosted && context.sourcePhase === 'pending') || !context.settled) {
        return paneOpen('catalog-loading', { transient: true, retryable: true,
            message: 'The Host is still loading its conversation catalog. Existing HAPI sessions attach in the background and can take a while on a large catalog.',
            nextStep: 'This pane opens automatically as soon as its session is listed.',
        }, detail)
    }
    if (context.sourceLifecycle === 'archived' || context.archived) {
        return paneOpen(sourceHosted ? 'source-archived' : 'session-archived', { transient: false, retryable: true,
            message: sourceHosted
                ? 'The original HAPI session is archived, so it is not attached to the workspace.'
                : 'This conversation is archived, so it is not listed by its Host.',
            nextStep: 'Restore the conversation (unarchive), then retry this pane or open it from the sidebar.',
        }, detail)
    }
    if (sourceHosted) {
        const changedHub = Boolean(context.savedHubId && context.currentHubId && context.savedHubId !== context.currentHubId)
        const hubNote = changedHub ? ' It was saved against a different HAPI Hub identity than the one this Host serves now.' : ''
        return paneOpen(changedHub ? 'source-hub-changed' : 'source-not-found',
            { transient: false, retryable: true,
                message: `The original HAPI session is no longer listed by its Hub after the catalog finished loading. It may have been deleted or archived.${hubNote}`,
                nextStep: 'Open the conversation again from the unified sidebar to rebind this pane; if the Hub no longer lists it, close the pane.',
            }, detail)
    }
    return paneOpen('session-not-listed', { transient: false, retryable: true,
        message: 'The Host no longer lists this conversation after its catalog finished loading.',
        nextStep: 'Open the conversation from the sidebar; if it is gone, close this pane.',
    }, detail)
}

/** A saved address that cannot be resolved at all is data, not a transient failure. */
export function invalidPaneAddressState(address: string, error: unknown): PaneOpenState {
    return paneOpen('address-invalid', { transient: false, retryable: false,
        message: 'This saved pane address is not a conversation this workspace can open.',
        nextStep: 'Close the pane or choose a conversation from the sidebar.',
    }, detailOf([`address=${address}`, error instanceof Error ? error.message : error === undefined ? undefined : String(error)]))
}

/** Map a rejected official `SessionReference.ready` to an actionable state. */
export function bindingFailureState(context: PaneOpenContext): PaneOpenState {
    const raw = context.error ?? ''
    const detail = detailOf([`host=${context.hostId}`, `session=${context.sessionId}`,
        context.sourceSessionId ? `source=${context.sourceSessionId}` : undefined, `error=${raw}`])
    if (/forbidden|unauthori[sz]ed|permission|denied|access/i.test(raw)) {
        return paneOpen('binding-denied', { transient: false, retryable: true,
            message: 'The Host refused to give this workspace access to the conversation.',
            nextStep: 'Check the original session permission on the Hub, then retry the pane.',
        }, detail)
    }
    return paneOpen('binding-failed', { transient: false, retryable: true,
        message: 'The Host could not attach this conversation to the workspace.',
        nextStep: 'Retry the pane; if it keeps failing, reopen the conversation from the sidebar and check the Host log.',
    }, detail)
}
