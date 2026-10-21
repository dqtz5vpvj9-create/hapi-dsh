/** First catalog arrival is an observed lifecycle, never an empty-list or timer heuristic. */
export interface CatalogHostDiscovery {
    readonly id: string
    readonly label: string
    readonly phase: 'pending' | 'ready' | 'unavailable'
    readonly error: string | null
}
export interface WorkspaceCatalogDiscovery {
    readonly phase: 'pending' | 'ready' | 'partial'
    readonly source: 'pending' | 'ready' | 'unavailable'
    readonly sourceError: string | null
    readonly sourceBindingsPending: number
    readonly hosts: readonly CatalogHostDiscovery[]
}

/** Federation reports the actual first bootstrap result for each advertised Host.
 * A known offline Host never prevents the loaded catalogs from being used. */
export class CatalogDiscovery {
    private source: WorkspaceCatalogDiscovery['source'] = 'pending'
    private sourceError: string | null = null
    private readonly hosts = new Map<string, CatalogHostDiscovery>()

    observe(hosts: readonly { id: string; label: string; online: boolean }[], connected: boolean): void {
        this.source = connected ? 'ready' : 'unavailable'
        this.sourceError = null
        const current = new Set(hosts.map(host => host.id))
        for (const [id, host] of this.hosts) if (!current.has(id)) this.hosts.set(id, { ...host, phase: 'unavailable', error: null })
        for (const host of hosts) {
            if (host.id === 'local') continue
            const previous = this.hosts.get(host.id)
            this.hosts.set(host.id, { id: host.id, label: host.label,
                phase: !host.online ? 'unavailable' : previous?.phase === 'ready' ? 'ready'
                    : previous?.error ? 'unavailable' : 'pending',
                error: host.online ? previous?.error ?? null : null,
            })
        }
    }
    sourceFailed(message: string): void { this.source = 'unavailable'; this.sourceError = message }
    hostReady(id: string, label: string): void {
        if (id !== 'local') this.hosts.set(id, { id, label, phase: 'ready', error: null })
    }
    hostFailed(id: string, label: string, message: string): void {
        if (id !== 'local') this.hosts.set(id, { id, label, phase: 'unavailable', error: message })
    }
    /** A saved pane can name a Host that has not been booted yet; only a real phase is authoritative. */
    host(id: string): CatalogHostDiscovery | undefined { return id === 'local' ? undefined : this.hosts.get(id) }
    get sourcePhase(): WorkspaceCatalogDiscovery['source'] { return this.source }
    get sourceFailure(): string | null { return this.sourceError }
    snapshot(localReady: boolean, sourceBindingsPending = 0): WorkspaceCatalogDiscovery {
        const hosts: CatalogHostDiscovery[] = [{ id: 'local', label: 'DSH', phase: localReady ? 'ready' : 'pending', error: null }, ...this.hosts.values()]
        const bindings = this.source === 'ready' ? sourceBindingsPending : 0
        const pending = this.source === 'pending' || bindings > 0 || hosts.some(host => host.phase === 'pending')
        const partial = this.source === 'unavailable' || hosts.some(host => host.phase === 'unavailable')
        return { phase: pending ? 'pending' : partial ? 'partial' : 'ready', source: this.source,
            sourceError: this.sourceError, sourceBindingsPending: bindings, hosts }
    }
}
