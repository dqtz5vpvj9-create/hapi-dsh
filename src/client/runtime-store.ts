/** One unchanged official store engine and persistence namespace per Client graph. */
type OfficialStore = typeof import('@deepseek-ai/dsh-client-store')

// Embedded by scripts/build.mjs from the pinned npm source and dependencies.
// The module is evaluated per graph, so its localStorage closure is not shared
// with the primary Web application or another pane.
declare const __HAPI_DSH_OFFICIAL_STORE_SOURCE__: string

export const GRAPH_STORE_MODULE = '@deepseek-ai/dsh-client-store'

export function graphStorage(storage: Storage, hostId: string, instanceId: string): Storage {
    const prefix = `hapi-dsh:host:${hostId}:pane:${instanceId}:`
    const keys = (): string[] => {
        const result: string[] = []
        for (let index = 0; index < storage.length; index++) {
            const key = storage.key(index)
            if (key?.startsWith(prefix)) result.push(key)
        }
        return result
    }
    return {
        getItem: key => storage.getItem(`${prefix}${key}`),
        setItem: (key, value) => storage.setItem(`${prefix}${key}`, value),
        removeItem: key => storage.removeItem(`${prefix}${key}`),
        clear: () => { for (const key of keys()) storage.removeItem(key) },
        key: index => keys()[index]?.slice(prefix.length) ?? null,
        get length() { return keys().length },
    }
}

export function createGraphStore(storage: Storage, source = __HAPI_DSH_OFFICIAL_STORE_SOURCE__): OfficialStore {
    const load = new Function('localStorage', `${source}\nreturn __HAPI_DSH_OFFICIAL_STORE__;\n//# sourceURL=hapi-dsh-official-store.js`)
    return load(storage) as OfficialStore
}
