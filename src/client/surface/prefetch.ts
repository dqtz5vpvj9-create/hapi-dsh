/**
 * Bundle prefetch for a Host or pane graph.
 *
 * The caller passes the official initial-load batches. A full shared Host uses
 * its published phase combos; a filtered pane uses one single-resource batch
 * per retained row. These are the only URLs requested: it never constructs an
 * arbitrary combo URL. Evidence from the pinned Host
 * (`@deepseek-ai/dsh-client-modules/lib/index.js`): `/plugins` serves a fixed
 * `responses` map built in `compose()` from the phase combo artifacts and one
 * `buildCombo([record])` per package, and "Unknown URLs return 404"
 * (`fetchBundle`/`bundleResource`). A client-built subset combo is therefore not
 * a supported upstream contract, and no Host-side merge endpoint is added here
 * (this task stays inside the client plugin).
 *
 * The upstream loader issues the row requests through dependency-ordered
 * arrival, so on a slow or tunnelled Host the graph's ready time can follow the
 * longest serial arrival chain rather than the network's throughput. This module
 * warms the shared per-Host artifact cache (the same map the boot loader reads)
 * with bounded parallel fetches before/while the loader resolves the rows: one
 * request per published row URL per Host, deduplicated across every pane. Every
 * byte and every compiled wrapper is still shared; later panes hit the cache.
 * Failures are dropped from the cache so the loader's own retry/fallback path
 * still observes them.
 */

/** One graph row whose bundle the pane graph will evaluate. */
export interface PrefetchEntry {
    /** Document-relative or absolute bundle URL exactly as the loader requests it. */
    readonly url: string
}

export interface PrefetchOptions {
    readonly entries: readonly PrefetchEntry[]
    /** Host base URL the entry URLs resolve against (same resolution as the loader). */
    readonly baseUrl: string
    /** Per-Host artifact cache shared by every pane graph (`HostResources.artifacts`). */
    readonly artifacts: Map<string, Promise<string>>
    /**
     * Fetch one bundle's source text. Must use the pane Host's transport (Hub
     * proxying, token, Host base path) exactly like the boot loader does.
     */
    readonly load: (url: string) => Promise<string>
    /** Upper bound on bundles fetched at the same time. */
    readonly concurrency?: number
}

/**
 * Warm the artifact cache for one pane graph.
 *
 * Returns after every entry settled; individual failures are swallowed (the
 * loader reports them with its own diagnostics and fallback). Never overrides a
 * cache entry another pane already started, so concurrent panes of one Host
 * still share one request per bundle.
 *
 * @param options - entries, cache, transport and concurrency bound.
 * @returns promise settling after all prefetches finished.
 */
export async function prefetchPaneArtifacts(options: PrefetchOptions): Promise<void> {
    const limit = Math.max(1, Math.min(options.concurrency ?? 6, 32))
    const queue: string[] = []
    const seen = new Set<string>()
    for (const entry of options.entries) {
        const key = new URL(entry.url, options.baseUrl).href
        if (seen.has(key) || options.artifacts.has(key)) continue
        seen.add(key)
        queue.push(key)
    }
    let next = 0
    const worker = async (): Promise<void> => {
        for (;;) {
            const index = next++
            if (index >= queue.length) return
            const key = queue[index]!
            if (options.artifacts.has(key)) continue
            let pending: Promise<string>
            pending = options.load(key).catch(error => {
                if (options.artifacts.get(key) === pending) options.artifacts.delete(key)
                throw error
            })
            options.artifacts.set(key, pending)
            try { await pending } catch { /* The loader owns per-row diagnostics and fallback. */ }
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, worker))
}
