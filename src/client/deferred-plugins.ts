import { useEffect } from 'react';
import type {} from '@deepseek-ai/dsh-client-ui-settings/client';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-modules/client';
import type {} from '@deepseek-ai/dsh-client-ui-layout/client';
import type { WebBootGraph } from '@deepseek-ai/dsh-client-modules/client';
import { deferredBootStages, independentBootBatches } from '../shared/boot-graph.ts';

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
}): Promise<void> {
    for (const stage of deferredBootStages(graph)) {
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

export function installDeferredPlugins(ctx: Context, host?: DeferredPluginHost): () => void {
    if (!host && Reflect.get(globalThis, '__HAPI_DSH_STAGED_BOOT__') !== true) return () => {};
    let started = false;
    let frame = 0;
    let settingsRequested = false;
    let removeDemand = (): void => {};
    const lifetime = new AbortController();
    const signal = host ? AbortSignal.any([lifetime.signal, host.signal]) : lifetime.signal;
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
        while (!signal.aborted && !settingsRequested) {
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        signal.throwIfAborted();
    };
    const start = (): void => {
        if (started || signal.aborted) return;
        started = true;

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
                    // Each cumulative stage retains existing official entries.
                    // Downloading does not own entry activation. Check reader
                    // activity again after each stage's resources have arrived.
                    await syncDeferredStages(graph, {
                        preload, sync: graph => ctx.modules.entries.sync(graph), idle,
                        requested: () => settingsRequested,
                        signal,
                    });
                    const failures = ctx.modules.entries.state.getSnapshot().failures;
                    if (failures.length) throw new Error(`Official plugin activation failed: ${failures.map(failure => failure.id).join(', ')}`);
                    performance.mark('hapi:deferred-plugins-ready');
                    removeDemand();
                })().catch(error => {
                    if (!signal.aborted) {
                        // Retry only on another explicit Settings demand. The
                        // official entries.sync reconciles failed entries even
                        // at the same revision; it owns module invalidation.
                        // The mark is the bounded, browser-visible failure fact;
                        // ctx.logger remains in its in-process buffer.
                        started = false;
                        performance.mark('hapi:deferred-plugins-failed');
                        ctx.logger.error('Deferred official plugins failed to load', error);
                    }
                }).finally(() => {
                    for (const link of preloadLinks) link.remove();
                    preloadLinks.clear();
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
    // This mark covers the initial conversation roster only. Account and HMR
    // remain explicitly on demand; deferred-plugins-ready still means full sync.
    performance.mark('hapi:conversation-plugins-ready');
    return () => {
        lifetime.abort(); removeDemand(); cancelAnimationFrame(frame);
        for (const link of preloadLinks) link.remove();
        preloadLinks.clear();
    };
}
