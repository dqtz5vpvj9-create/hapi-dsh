import type { ClientBundleRegistration } from '@deepseek-ai/dsh-client-modules/client'

type OfficialModules = typeof import('@deepseek-ai/dsh-client-modules/client')
declare const __HAPI_DSH_OFFICIAL_MODULES_SOURCE__: string

/** CSS module ids are filenames, not build identities. Each graph owns its tags. */
export function graphStyleQueries(document: ParentNode, surface: ParentNode) {
    const owner = (selector: string): ParentNode => /^\s*style(?:\[|:|$)/.test(selector) ? surface : document
    return {
        querySelector: (selector: string) => owner(selector).querySelector(selector),
        querySelectorAll: (selector: string) => owner(selector).querySelectorAll(selector),
    }
}

/** Evaluate the unchanged pinned loader against the same document as its plugins.
 * Its CSS inventory and HMR cleanup must not borrow the primary page's document. */
export function createGraphModules(document: Document, source = __HAPI_DSH_OFFICIAL_MODULES_SOURCE__): OfficialModules {
    let registration: ClientBundleRegistration | undefined
    new Function('window', 'document', source)({ __ModuleLoader__: { load(value: ClientBundleRegistration) { registration = value } } }, document)
    if (!registration) throw new Error('The official module loader did not register')
    const missing = (id: string): never => { throw new Error(`Unexpected platform import in the pinned module loader: ${id}`) }
    return registration.factory(Object.assign(missing, { async: async (id: string) => missing(id) })) as OfficialModules
}
