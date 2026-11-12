import { useEffect } from 'react';
import type {} from '@deepseek-ai/dsh-client-ui-settings/client';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-modules/client';
import type {} from '@deepseek-ai/dsh-client-ui-layout/client';
import type { WebBootGraph } from '@deepseek-ai/dsh-client-modules/client';
import { assertStableBootEntries, deferredBootStages, independentBootBatches, workspaceResourceBootGraph } from '../shared/boot-graph.ts';
import { parseSessionResourceId, type WorkspaceController } from './controller.ts';
import { isSourceSessionId, parseSourceSessionId } from '../remote/protocol.ts';
import { observeForegroundActivity } from './foreground-activity.ts';

export type DeferredPluginDemand = (() => 'pending' | 'ready' | 'requested') & {
    subscribe?(listener: () => void): () => void;
};

/** Resource selection is an immediate demand. Passive loading waits for the
 * selected real reader, including its canonical's paired original Host. Empty
 * workspaces and legitimate read-only readers do not require an editable input. */
export function workspaceDeferredDemand(workspace: WorkspaceController, hostId = 'local'): DeferredPluginDemand {
    return Object.assign(() => {
        if (workspace.pendingStartupSourceId) return 'pending';
        const pane = workspace.store.focusedPane(), resource = pane.resource;
        if (resource.kind === 'empty') return hostId === 'local' ? 'ready' : 'pending';
        const address = parseSessionResourceId(resource.sessionId);
        if (hostId !== 'local' && address.hostId !== hostId) return 'pending';
        if (resource.kind !== 'chat') return 'requested';
        if (address.hostId === 'local' && isSourceSessionId(address.sessionId)) {
            try {
                const { machineId } = parseSourceSessionId(address.sessionId);
                if (workspace.getSnapshot().catalogDiscovery.hosts.some(host => host.id === machineId && host.phase !== 'unavailable')) return 'pending';
            } catch { return 'pending'; }
        }
        const surface = document.querySelector<HTMLElement>(`[data-hapi-pane-instance="${CSS.escape(pane.id)}"]`);
        if (surface?.dataset.hapiPaneOpening === 'ready') return 'ready';
        const row = workspace.getSnapshot().catalog.byId[resource.sessionId as import('@deepseek-ai/dsh-session/types').SessionId];
        return row?.projectionValues?.hhpiSource?.capabilities.send === false && surface?.querySelector('[data-chat-node-key]') ? 'ready' : 'pending';
    }, { subscribe: workspace.subscribe });
}

/** Download without activating entries, then give reader input a turn before
 * official graph reconciliation. Network arrival must not activate a plugin
 * in the middle of a gesture that began while its bundle was downloading.
 * Opening a panel deliberately asks for the complete official plugin roster. */
export async function syncDeferredStages(graph: WebBootGraph, options: {
    preload(graph: WebBootGraph): Promise<void>;
    sync(graph: WebBootGraph): Promise<void>;
    idle(): Promise<void>;
    requested(): boolean;
    signal: AbortSignal;
    /** Explicit cumulative feature groups; ordinary callers retain one closure per stage. */
    stages?: readonly WebBootGraph[];
}): Promise<void> {
    for (const stage of options.stages ?? deferredBootStages(graph)) {
        // A resolved sync promise alone only yields to microtasks. Input must
        // be dispatched before deciding whether another stage may begin.
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        options.signal.throwIfAborted();
        await options.idle();
        options.signal.throwIfAborted();
        const requested = options.requested();
        const next = requested ? independentBootBatches(graph) : stage;
        await options.preload(next);
        // A gesture can arrive while the network is pending. Yield a task so
        // its input events are seen before testing foreground ownership again.
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        options.signal.throwIfAborted();
        await options.idle();
        options.signal.throwIfAborted();
        await options.sync(next);
        options.signal.throwIfAborted();
        if (requested) return;
    }
}

/** Complete the official roster only on explicit Settings demand.
 * This is a ClientEntries graph reconciliation, not another plugin runtime. */
export interface DeferredPluginHost {
    /** A federated graph must fetch and preload through its own Host transport. */
    loadGraph(signal: AbortSignal): Promise<WebBootGraph>;
    preload(graph: WebBootGraph): Promise<void>;
    signal: AbortSignal;
}

export function installDeferredPlugins(ctx: Context, host?: DeferredPluginHost, demand: DeferredPluginDemand = () => 'pending'): () => void {
    if (!host && Reflect.get(globalThis, '__HAPI_DSH_STAGED_BOOT__') !== true) return () => {};
    let started = false;
    let frame = 0;
    let settingsRequested = false;
    let resourcesReady = false;
    let removeDemand = (): void => {};
    const lifetime = new AbortController();
    const signal = host ? AbortSignal.any([lifetime.signal, host.signal]) : lifetime.signal;
    const activity = observeForegroundActivity(document);
    const preloaded = new Map<string, Promise<void>>();
    const preloadLinks = new Set<HTMLLinkElement>();
    const preload = host?.preload ?? (async (graph: WebBootGraph): Promise<void> => {
        const current = new Map(ctx.modules.manifest.modules.map(row => [row.id, row.rev]));
        await Promise.all(graph.entries.map(row => {
            if (current.get(row.id) === row.rev) return;
            let pending = preloaded.get(row.url);
            if (!pending) {
                pending = new Promise<void>((resolve, reject) => {
                    const link = document.createElement('link');
                    // The official loader uses same-origin classic scripts.
                    // Preload only warms that exact resource; it never executes
                    // a factory, edits the module table or creates a provider.
                    link.rel = 'preload'; link.as = 'script'; link.href = row.url;
                    const finish = (error?: unknown): void => {
                        signal.removeEventListener('abort', abort);
                        link.onload = link.onerror = null;
                        if (error) reject(error); else resolve();
                    };
                    const abort = (): void => finish(signal.reason);
                    link.onload = () => finish();
                    // Preload is a cache hint. Keep transport retry and error
                    // reporting with the official loader if that hint fails.
                    link.onerror = () => finish();
                    signal.addEventListener('abort', abort, { once: true });
                    preloadLinks.add(link);
                    document.head.append(link);
                });
                preloaded.set(row.url, pending);
            }
            return pending;
        }));
    });
    const idle = async (): Promise<void> => {
        while (!signal.aborted && !settingsRequested && demand() !== 'requested'
            && (resourcesReady || demand() !== 'ready' || activity.busy())) {
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        signal.throwIfAborted();
    };
    const start = (): void => {
        if (started || signal.aborted) return;
        started = true;
        let continueToSettings = false;

        frame = requestAnimationFrame(() => {
            frame = requestAnimationFrame(() => {
                if (signal.aborted) return;
                void (async () => {
                    await idle();
                    performance.mark('hapi:deferred-plugins-start');
                    // A release may have changed while a slow client downloaded
                    // stage one. Reconcile the current authenticated Host graph.
                    const loadGraph = host?.loadGraph ?? (async () => {
                        const response = await fetch('hapi-dsh/bootstrap', { signal, cache: 'no-store' });
                        if (!response.ok) throw new Error(`Plugin graph HTTP ${response.status}`);
                        return (await response.json() as { graph: WebBootGraph }).graph;
                    });
                    const graph = await loadGraph(signal);
                    signal.throwIfAborted();
                    assertStableBootEntries(graph, ctx.modules.manifest.modules);
                    const complete = settingsRequested;
                    let fullSynced = false;
                    // Each cumulative stage retains existing official entries.
                    // Downloading does not own entry activation. Check reader
                    // activity again after each stage's resources have arrived.
                    await syncDeferredStages(graph, {
                        preload, sync: async next => {
                            assertStableBootEntries(next, ctx.modules.manifest.modules);
                            await ctx.modules.entries.sync(next);
                            fullSynced = next.entries.length === graph.entries.length;
                        }, idle,
                        requested: () => settingsRequested,
                        signal,
                        stages: [complete ? independentBootBatches(graph) : workspaceResourceBootGraph(graph)],
                    });
                    const failures = ctx.modules.entries.state.getSnapshot().failures;
                    if (failures.length) throw new Error(`Official plugin activation failed: ${failures.map(failure => failure.id).join(', ')}`);
                    resourcesReady = true;
                    continueToSettings = !fullSynced && settingsRequested;
                    if (fullSynced) {
                        performance.mark('hapi:deferred-plugins-ready');
                        removeDemand();
                    } else performance.mark('hapi:resource-plugins-ready');
                })().catch(error => {
                    if (!signal.aborted) {
                        // Retry only on another explicit Settings/resource demand. The
                        // official entries.sync reconciles failed entries even
                        // at the same revision; it owns module invalidation.
                        // The mark is the bounded, browser-visible failure fact;
                        // ctx.logger remains in its in-process buffer.
                        started = false;
                        performance.mark('hapi:deferred-plugins-failed');
                        ctx.logger.error('Deferred official plugins failed to load', error);
                    }
                }).finally(() => {
                    started = false;
                    for (const link of preloadLinks) link.remove();
                    preloadLinks.clear();
                    if (continueToSettings && !signal.aborted) start();
                });
            });
        });
    };
    // The official Settings shell mounts its action outlet only while open.
    // This observes explicit Settings demand through the public slot contract;
    // the native trigger, keyboard shortcut and Account menu stay unchanged.
    const SettingsDemand = () => {
        useEffect(() => {
            settingsRequested = true; start();
            return () => { settingsRequested = false; };
        }, []);
        return null;
    };
    removeDemand = ctx.slots.inject('settings.action', () => ctx.slots.register({
        name: 'settings.action', id: 'hapi-account-demand',
    }, SettingsDemand));
    const removeResourceDemand = demand.subscribe?.(() => {
        if (!resourcesReady && demand() === 'requested') start();
    });
    // This mark covers the initial conversation roster only. Account and HMR
    // remain explicitly on demand; deferred-plugins-ready still means full sync.
    performance.mark('hapi:conversation-plugins-ready');
    start();
    return () => {
        lifetime.abort(); removeDemand(); removeResourceDemand?.(); cancelAnimationFrame(frame); activity.dispose();
        for (const link of preloadLinks) link.remove();
        preloadLinks.clear();
    };
}
