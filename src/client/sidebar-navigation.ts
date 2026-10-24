import { randomId } from './random-id.ts'
/** Adapt the official sidebar through Cordis's public service-isolation seam. */
import { Context } from '@deepseek-ai/cordis'
import type { UiWorkspace } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type { WorkspaceController } from './controller.ts'

const SIDEBAR = '@deepseek-ai/dsh-client-ui-sidebar'

/**
 * SidebarRoot receives its New Session callback from uiWorkspace. Its child
 * declarations cannot be redeclared by a shadow entry, so keep that entire
 * official component/slot tree intact and change only the injected capability.
 * Entry.update() rebinds the official plugin through the normal Loader lifecycle.
 */
export async function installSidebarNavigation(ctx: Context, controller: Pick<WorkspaceController, 'requestNewSession'>): Promise<() => Promise<void>> {
    return installNavigation(ctx, SIDEBAR, { startSession: () => controller.requestNewSession() })
}

/** Plugin creation uses the Host's shared official draft owner, including append/preset semantics. */
export async function installEntrySessionNavigation(ctx: Context, navigation: Pick<UiWorkspace, 'startSession'>): Promise<() => Promise<void>> {
    return installNavigation(ctx, '@deepseek-ai/dsh-client-ui-entry-customization', navigation, true)
}

async function installNavigation(ctx: Context, pluginName: string, adapter: Pick<UiWorkspace, 'startSession'>, optional = false): Promise<() => Promise<void>> {
    const entry = [...ctx.loader.entries()].find(candidate => candidate.options.name === pluginName)
    // A profile may disable the optional More menus. Files and other pane
    // resources still work; there is no navigation capability to adapt then.
    if (!entry && optional) return async () => {}
    if (!entry) throw new Error(`The official DSH navigation plugin ${pluginName} is not present in the Client graph`)
    const original = entry.context.get('uiWorkspace') as UiWorkspace | undefined
    if (!original) throw new Error(`The official navigation capability for ${pluginName} is not available`)
    const priorIsolation = entry.options.isolate?.uiWorkspace
    const label = `hapi-dsh:sidebar:${randomId()}`
    const restore = async (): Promise<void> => {
        if (entry.options.isolate?.uiWorkspace !== label || ![...ctx.loader.entries()].includes(entry)) return
        const isolation = { ...entry.options.isolate }
        if (priorIsolation === undefined) delete isolation.uiWorkspace
        else isolation.uiWorkspace = priorIsolation
        await entry.update({ isolate: Object.keys(isolation).length ? isolation : null })
    }
    let release: (() => Promise<void>) | undefined
    try {
        await entry.update({ isolate: { ...entry.options.isolate, uiWorkspace: label } })
        // Context.isolate and its scope map are public Cordis APIs. Reading the
        // Loader-selected symbol joins its realm; neither Context nor the
        // upstream service/entry/component is patched or mutated here.
        const symbol = entry.context[Context.isolate].uiWorkspace
        if (!symbol) throw new Error('The Loader did not establish sidebar navigation isolation')
        const scope = ctx.isolate('uiWorkspace', symbol)
        // Supply precisely the public capability that the pinned Sidebar asks
        // for. Do not proxy or inherit the original Service: Cordis traces its
        // prototype methods by descriptor, which would bypass a Proxy get trap
        // and call the original startSession despite the adaptation.
        // Give the provider its own fiber in this realm. Providing from the
        // outer fiber would announce activation in that fiber's original realm
        // and leave the isolated sidebar dependency pending.
        const provider = scope.plugin({ name: 'hapi-sidebar-navigation', apply(providerContext: Context) {
            providerContext.reflect.provide('uiWorkspace', adapter)
        } })
        release = () => provider.dispose()
        await provider
    } catch (error) { await restore(); await release?.(); throw error }
    let disposed = false
    return async () => {
        if (disposed) return
        disposed = true
        try { await restore() } finally { await release?.() }
    }
}
