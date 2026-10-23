import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-modules/client';
import type {} from '@deepseek-ai/dsh-client-ui-layout/client';
import type { WebBootGraph } from '@deepseek-ai/dsh-client-modules/client';
import { independentBootBatches } from '../shared/boot-graph.ts';

/** Resume the full official roster after the first useful conversation paint.
 * This is a ClientEntries graph reconciliation, not another plugin runtime. */
export function installDeferredPlugins(ctx: Context): () => void {
    if (Reflect.get(globalThis, '__HAPI_DSH_STAGED_BOOT__') !== true) return () => {};
    let started = false;
    let frame = 0;
    let allowEmpty = false;
    const lifetime = new AbortController();
    const start = (): void => {
        if (started || lifetime.signal.aborted) return;
        started = true;
        observer.disconnect();
        clearTimeout(emptyWorkspace);
        stopPanel();
        frame = requestAnimationFrame(() => {
            frame = requestAnimationFrame(() => {
                if (lifetime.signal.aborted) return;
                performance.mark('hapi:deferred-plugins-start');
                void (async () => {
                    // A release may have changed while a slow client downloaded
                    // stage one. Reconcile the current authenticated Host graph.
                    const response = await fetch('hapi-dsh/bootstrap', { signal: lifetime.signal, cache: 'no-store' });
                    if (!response.ok) throw new Error(`Plugin graph HTTP ${response.status}`);
                    const payload = await response.json() as { graph: WebBootGraph };
                    if (lifetime.signal.aborted) return;
                    await ctx.modules.entries.sync(independentBootBatches(payload.graph));
                    const failures = ctx.modules.entries.state.getSnapshot().failures;
                    if (failures.length) throw new Error(`Official plugin activation failed: ${failures.map(failure => failure.id).join(', ')}`);
                    performance.mark('hapi:deferred-plugins-ready');
                })().catch(error => { if (!lifetime.signal.aborted) ctx.logger.error('Deferred official plugins failed to load', error); });
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
    return () => { lifetime.abort(); observer.disconnect(); stopPanel(); clearTimeout(emptyWorkspace); cancelAnimationFrame(frame); };
}
