/**
 * Pane-mode HAPI contributions.
 *
 * A pane must not evaluate this plugin's own client bundle again: the bundle is
 * ~4 MB and the pane only needs the context-bound contributions below. The root
 * graph calls these functions with the pane's Context instead, so the code is
 * materialized once per page while services and slot registrations still belong
 * to the pane. Exactly one installer runs per pane Context; a second attempt
 * fails loud instead of duplicating locale namespaces or slot contributions.
 */
import type { Context } from '@deepseek-ai/cordis'
import { en, zh } from './locales.ts'
import { installWorkspaceStyles } from './styles.ts'
import { installNativeIntegration } from './native-integration.tsx'
import { installSourceComposerBridge } from './source-composer.tsx'
import { installPaneMountedChatConsumer, type MountedChatPane } from './mounted-chat-control.ts'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from './remote-sessions.ts'
import type {} from './source-workspace-client.ts'
import type { SourceNativeNavigationOptions } from './source-native-navigation.tsx'

/** Marker attribute `installWorkspaceStyles` writes on its style element. */
const STYLE_MARKER = 'style[data-hapi-workspace-styles]'

/**
 * The workspace stylesheet is page-global. Install it only when the primary
 * graph has not already done so; a pane that reuses the primary stylesheet owns
 * no style element and therefore cannot remove it on close.
 */
function installPaneDocumentStyles(document: Document): () => void {
    if (document.head.querySelector(STYLE_MARKER)) return () => {}
    return installWorkspaceStyles(document)
}

async function disposeAll(disposers: Array<() => void | Promise<void>>): Promise<void> {
    let failure: unknown
    for (const dispose of disposers.reverse()) {
        try { await dispose() } catch (error) { failure ??= error }
    }
    if (failure !== undefined) throw failure
}

/**
 * Install the pane-only HAPI surfaces on an already-mounted remote face.
 *
 * Every installer registers into the supplied Context, so disposal is exactly
 * this function's ledger: a throw while installing unwinds everything completed
 * so far, and the returned disposer unwinds in reverse order on close.
 *
 * @param ctx - the pane graph's Context with the HAPI remote namespace mounted.
 * @returns asynchronous disposer owned by the caller's pane lifetime.
 */
export function installPaneNative(ctx: Context, navigation: SourceNativeNavigationOptions): () => Promise<void> {
    return installPaneNativeInternal(ctx, null, navigation)
}

function installPaneNativeInternal(ctx: Context, pane: MountedChatPane | null, navigation: SourceNativeNavigationOptions): () => Promise<void> {
    try { performance.mark(pane ? 'hapi-dsh:pane-native:with-pane' : 'hapi-dsh:pane-native:no-pane') } catch { /* diagnostics are optional */ }
    if (ctx.get('hapiPaneNative')) throw new Error('Pane HAPI surfaces are already installed on this Context')
    const disposers: Array<() => void | Promise<void>> = []
    try {
        const composer = installSourceComposerBridge(ctx)
        disposers.push(() => composer.dispose())
        disposers.push(installPaneDocumentStyles(document))
        // One consumer per Pane graph: the mounted Chat control is published
        // under this Pane's own element, so other panes never share or clear it.
        if (pane) {
            // `toLatest` asks this consumer to fetch the newest source window
            // before landing, so the control stays the single scroll owner.
            disposers.push(installPaneMountedChatConsumer(ctx, pane, async (sessionId, signal) => {
                const session = ctx.sessions.binding(sessionId as SessionId)?.session as
                    { returnToLive?: (signal?: AbortSignal) => boolean | Promise<boolean> } | undefined
                const landed = await session?.returnToLive?.(signal)
                if (landed !== true) throw new Error('The source has no newer window to land on')
            }))
        }
        const unlocale = ctx.locale.register('hapiWorkspace', { en, zh })
        disposers.push(unlocale)
        const integration = installNativeIntegration(ctx, composer, navigation)
        disposers.push(() => integration.dispose())
        const unprovide = ctx.reflect.provide('hapiPaneNative', integration)
        disposers.push(() => unprovide())
    } catch (error) {
        void disposeAll(disposers).catch(() => { /* Preserve the installation error. */ })
        throw error
    }
    return async () => { await disposeAll(disposers) }
}

/**
 * Mount the native bridge on a pane Context and install the pane-only surfaces.
 *
 * @param ctx - the activated pane graph Context.
 * @returns asynchronous disposer that removes the surfaces, then the namespace.
 */
export async function mountPaneNative(ctx: Context, navigation: SourceNativeNavigationOptions, pane?: MountedChatPane | null): Promise<() => Promise<void>> {
    return installPaneNativeInternal(ctx, pane ?? null, navigation)
}
