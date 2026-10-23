import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-modules/client';
import type {} from '@deepseek-ai/dsh-client-ui-layout/client';
import type { WebBootGraph } from '@deepseek-ai/dsh-client-modules/client';
import { deferredBootStages, independentBootBatches } from '../shared/boot-graph.ts';
import { observeForegroundActivity } from './foreground-activity.ts';

/** Give new reader input a turn between official graph reconciliations.
 * A stage already downloading may finish; the next stage waits for the reader.
 * Opening a panel deliberately asks for the complete official plugin roster. */
export async function syncDeferredStages(graph: WebBootGraph, options: {
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
        await options.sync(requested ? independentBootBatches(graph) : stage);
        options.signal.throwIfAborted();
        if (requested) return;
    }
}

/** Resume the full official roster after the first useful conversation paint.
 * This is a ClientEntries graph reconciliation, not another plugin runtime. */
export function installDeferredPlugins(ctx: Context): () => void {
    if (Reflect.get(globalThis, '__HAPI_DSH_STAGED_BOOT__') !== true) return () => {};
    let started = false;
    let frame = 0;
    let allowEmpty = false;
    const lifetime = new AbortController();
    const activity = observeForegroundActivity(document);
    const idle = async (): Promise<void> => {
        while (!lifetime.signal.aborted && activity.busy() && ctx.layout.panelInfo.getSnapshot().activePanelId === null) {
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        lifetime.signal.throwIfAborted();
    };
    const start = (): void => {
        if (started || lifetime.signal.aborted) return;
        started = true;
        observer.disconnect();
        clearTimeout(emptyWorkspace);
        stopPanel();
        activity.defer();
        frame = requestAnimationFrame(() => {
            frame = requestAnimationFrame(() => {
                if (lifetime.signal.aborted) return;
                void (async () => {
                    await idle();
                    performance.mark('hapi:deferred-plugins-start');
                    // A release may have changed while a slow client downloaded
                    // stage one. Reconcile the current authenticated Host graph.
                    const response = await fetch('hapi-dsh/bootstrap', { signal: lifetime.signal, cache: 'no-store' });
                    if (!response.ok) throw new Error(`Plugin graph HTTP ${response.status}`);
                    const payload = await response.json() as { graph: WebBootGraph };
                    if (lifetime.signal.aborted) return;
                    // Each cumulative stage retains existing official entries.
                    // Network arrival may finish the current stage during a
                    // swipe, but cannot start the rest of the roster behind it.
                    await syncDeferredStages(payload.graph, {
                        sync: graph => ctx.modules.entries.sync(graph), idle,
                        requested: () => ctx.layout.panelInfo.getSnapshot().activePanelId !== null,
                        signal: lifetime.signal,
                    });
                    const failures = ctx.modules.entries.state.getSnapshot().failures;
                    if (failures.length) throw new Error(`Official plugin activation failed: ${failures.map(failure => failure.id).join(', ')}`);
                    performance.mark('hapi:deferred-plugins-ready');
                })().catch(error => { if (!lifetime.signal.aborted) ctx.logger.error('Deferred official plugins failed to load', error); }).finally(() => activity.dispose());
            });
        });
    };
    const ready = (): void => {
        const focused = [...document.querySelectorAll<HTMLElement>('.hapi-pane-focused')].find(pane => pane.getClientRects().length > 0);
        if (focused?.querySelector('[data-hapi-pane-opening="ready"]')
            || allowEmpty && focused?.dataset.hapiPaneState === 'empty') start();
    };
    const observer = new MutationObserver(ready);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-hapi-pane-opening', 'data-hapi-pane-state', 'class'] });
    const stopPanel = ctx.layout.panelInfo.subscribe(() => { if (ctx.layout.panelInfo.getSnapshot().activePanelId !== null) start(); });
    // An empty workspace still gets its complete plugin menu. This never
    // turns a slow conversation into a reason to compete with its download.
    const emptyWorkspace = setTimeout(() => { allowEmpty = true; ready(); }, 10_000);
    ready();
    return () => { lifetime.abort(); activity.dispose(); observer.disconnect(); stopPanel(); clearTimeout(emptyWorkspace); cancelAnimationFrame(frame); };
}
