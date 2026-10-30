import type { HhpiCatalogCapabilityStore } from '../remote-sessions.ts'

/** Mount HAPI-only client surfaces only after the HHPI catalog advertises legacy HAPI support. */
export function installWithLegacyHapiCapability(capability: HhpiCatalogCapabilityStore, install: () => () => void): () => void {
    let dispose: (() => void) | undefined
    let stopped = false
    const synchronize = (): void => {
        if (stopped) return
        const state = capability.getSnapshot()
        if (state.catalogReady && state.legacyHapi) {
            if (!dispose) dispose = install()
            return
        }
        const current = dispose
        dispose = undefined
        current?.()
    }
    const unsubscribe = capability.subscribe(synchronize)
    synchronize()
    return () => {
        if (stopped) return
        stopped = true
        unsubscribe()
        const current = dispose
        dispose = undefined
        current?.()
    }
}
