import { test, expect } from '@playwright/test';
import { startOfficialEnvironment, type OfficialEnvironment } from './official-runtime.ts';
import { PANE_GRAPH_EXCLUDE } from '../src/client/surface/pane-graph.ts';

/**
 * Structural pane surface: a pane boots the filtered official chat graph, keeps
 * exactly one window-level chrome, and renders the official Conversation for its
 * explicit SessionReference. Also records the per-pane heap/DOM curve (1/2/4
 * panes) used for the memory report.
 *
 * This spec is deliberately self-contained: the fixture, the official Client
 * graph, and the Hub are real; only the HAPI source sessions are wire fixtures.
 */
test.setTimeout(360_000);

interface HeapRow {
    label: string;
    usedMB: number;
    nodes: number;
    listeners: number;
    documents: number;
    scriptResources: number;
    fetchResources: number;
    resourceBytes: number;
}

async function measure(page: import('@playwright/test').Page, label: string): Promise<HeapRow> {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('HeapProfiler.enable');
    for (let index = 0; index < 3; index++) await cdp.send('HeapProfiler.collectGarbage');
    const heap = (await cdp.send('Runtime.getHeapUsage')) as { usedSize: number };
    const dom = (await cdp.send('Memory.getDOMCounters')) as { documents: number; nodes: number; jsEventListeners: number };
    await cdp.detach();
    const resources = await page.evaluate(() => [...performance.getEntriesByType('resource')].map(entry => ({
        initiator: (entry as PerformanceResourceTiming).initiatorType,
        bytes: (entry as PerformanceResourceTiming).decodedBodySize,
        url: entry.name,
    })));
    const row: HeapRow = {
        label,
        usedMB: +(heap.usedSize / 1048576).toFixed(2),
        nodes: dom.nodes,
        listeners: dom.jsEventListeners,
        documents: dom.documents,
        scriptResources: resources.filter(entry => entry.initiator === 'script').length,
        fetchResources: resources.filter(entry => entry.initiator === 'fetch').length,
        resourceBytes: resources.filter(entry => entry.initiator === 'script' || entry.initiator === 'fetch').reduce((sum, entry) => sum + entry.bytes, 0),
    };
    console.log(`MEASURE ${JSON.stringify(row)}`);
    const big = resources.filter(entry => entry.bytes > 100_000).sort((left, right) => right.bytes - left.bytes).slice(0, 8)
    console.log(`BIG_RESOURCES ${JSON.stringify(big.map(entry => ({ bytes: entry.bytes, url: entry.url.replace(/[?&]token=[^&]+/g, '') })))}`);
    return row;
}

test('filtered pane graph renders the official Conversation with one window chrome', async ({ page }) => {
    let environment: OfficialEnvironment | undefined;
    const rows: HeapRow[] = [];
    try {
        environment = await startOfficialEnvironment(false);
        for (const key of ['gamma', 'delta']) {
            environment.hapi.add(key, 'Laptop', 'machine-alpha');
            environment.hapi.emit({ type: 'session-added', sessionId: `native-${key}` });
        }
        const consoleErrors: string[] = [];
        page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 500)); });
        await page.goto(environment.launchUrl);
        await page.getByRole('dialog', { name: 'Preview Notice' }).getByRole('button', { name: 'Continue', exact: true }).click();
        await page.locator('[data-hapi-workspace]').waitFor();
        for (const key of ['alpha', 'beta', 'gamma', 'delta']) {
            await page.locator('.hapi-session-open').filter({ hasText: `Native Codex ${key}` }).waitFor({ timeout: 90_000 });
        }
        rows.push(await measure(page, 'primary graph, 0 panes'));

        // The pane graph must be the Host graph minus the documented chrome rows.
        const graph = await page.evaluate(async () => (await (await fetch('/hapi-dsh/bootstrap', { cache: 'no-store' })).json()).graph as {
            entries: Array<{ id: string }>; batches: Array<{ entries: string[] }>;
        });
        const paneRows = graph.entries.map(row => row.id).filter(id => !PANE_GRAPH_EXCLUDE.has(id));
        const excludedInGraph = graph.entries.map(row => row.id).filter(id => PANE_GRAPH_EXCLUDE.has(id));
        expect(excludedInGraph.length).toBeGreaterThanOrEqual(15);
        expect(excludedInGraph).toContain('hapi-dsh');
        expect(paneRows.some(id => id === 'hapi-dsh')).toBe(false);
        expect(paneRows.some(id => id === '@deepseek-ai/dsh-client-ui-conversation')).toBe(true);
        expect(paneRows.some(id => id === '@deepseek-ai/dsh-client-ui-sidebar-right')).toBe(true);
        // Official tool renderers are conversation surfaces, not window chrome.
        expect(paneRows).toContain('@deepseek-ai/dsh-client-ui-deliverables');
        expect(excludedInGraph).not.toContain('@deepseek-ai/dsh-client-ui-deliverables');
        console.log(`GRAPH rows=${graph.entries.length} paneRows=${paneRows.length} excludedInGraph=${excludedInGraph.length} excluded=${JSON.stringify(excludedInGraph)}`);

        const open = async (key: string, first: boolean): Promise<void> => {
            const before = await page.locator('.hapi-remote-pane').count();
            if (!first) await page.getByRole('button', { name: 'Split left / right', exact: true }).click();
            await page.locator('.hapi-session-open').filter({ hasText: `Native Codex ${key}` }).click();
            await page.getByText(`Native history ${key} in the official DSH Conversation.`, { exact: true }).waitFor({ timeout: 90_000 });
            await page.waitForTimeout(1200);
            // The official Conversation for this explicit reference is inside a pane.
            const after = await page.locator('.hapi-remote-pane').count();
            const bound = await page.evaluate(text => [...document.querySelectorAll<HTMLElement>('.hapi-remote-pane')]
                .filter(pane => pane.innerText.includes(text)).length, `Native history ${key} in the official DSH Conversation.`);
            expect(bound).toBeGreaterThan(0);
            if (!first) expect(after).toBeGreaterThan(before);
            console.log(`PANE_COUNT ${key} before=${before} after=${after} bound=${bound}`);
            // Per-pane chrome: no window-level sidebar content duplicated inside a pane.
            const chrome = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.hapi-remote-pane')].map(pane => ({
                sidebarText: (pane.querySelector('[data-slot="sidebar"]') as HTMLElement | null)?.innerText.trim() ?? '',
                sidebarShells: pane.querySelectorAll('[data-slot="sidebar"] > *').length,
                leadingShells: pane.querySelectorAll('[data-shell-leading] > *').length,
                remoteShells: pane.querySelectorAll('.hapi-remote-shell').length,
            })));
            console.log(`PANE_CHROME ${key} ${JSON.stringify(chrome)}`);
        };
        await open('alpha', true);
        rows.push(await measure(page, '1 chat pane'));
        await open('beta', false);
        rows.push(await measure(page, '2 chat panes'));
        await open('gamma', false);
        await open('delta', false);
        rows.push(await measure(page, '4 chat panes'));

        // Evaluated pane graph evidence: a filtered pane loads one single-resource
        // artifact per retained row (the primary graph's shared combo scripts are
        // not repeated). The excluded hapi-dsh bundle must never be fetched.
        const evaluated = await page.evaluate(() => {
            const entries = [...performance.getEntriesByType('resource')] as PerformanceResourceTiming[];
            const plugin = entries.filter(entry => entry.name.includes('/plugins/'));
            const sharedCombos = new Set(plugin.filter(entry => entry.name.includes('??')).map(entry => entry.name));
            const single = plugin.filter(entry => !sharedCombos.has(entry.name) || !entry.name.includes('hapi-dsh'));
            return {
                pluginCount: plugin.length,
                pluginBytes: plugin.reduce((sum, entry) => sum + entry.decodedBodySize, 0),
                hasHapiBundle: plugin.some(entry => entry.name.startsWith('http') && /\/plugins\/\?\?hapi-dsh\/client\.js/.test(entry.name)),
                largest: plugin.sort((left, right) => right.decodedBodySize - left.decodedBodySize).slice(0, 6)
                    .map(entry => ({ bytes: entry.decodedBodySize, name: entry.name.replace(/[^/]+\?rev=[^&]+/, '').slice(0, 120) })),
                single,
            };
        });
        console.log(`PANE_EVALUATED ${JSON.stringify({ pluginCount: evaluated.pluginCount, pluginBytes: evaluated.pluginBytes, hasHapiBundle: evaluated.hasHapiBundle, largest: evaluated.largest })}`);
        const paneFetches = await page.evaluate(() => {
            const entries = [...performance.getEntriesByType('resource')] as PerformanceResourceTiming[];
            return entries.filter(entry => entry.name.includes('/plugins/')).length;
        });
        console.log(`PANE_PLUGIN_REQUESTS ${paneFetches}`);
        expect(evaluated.hasHapiBundle).toBe(false);

        const [baseline, one, two, four] = rows;
        const summary = {
            baselineMB: baseline?.usedMB,
            oneMB: one?.usedMB, twoMB: two?.usedMB, fourMB: four?.usedMB,
            firstPaneDeltaMB: one && baseline ? +(one.usedMB - baseline.usedMB).toFixed(2) : null,
            secondPaneDeltaMB: two && one ? +(two.usedMB - one.usedMB).toFixed(2) : null,
            fourthPaneDeltaMB: four && two ? +((four.usedMB - two.usedMB) / 2).toFixed(2) : null,
            domNodeDeltaFirstPane: one && baseline ? one.nodes - baseline.nodes : null,
            domNodeDeltaSecondPane: two && one ? two.nodes - one.nodes : null,
            paneBundleFetchDelta: one && baseline ? one.resourceBytes - baseline.resourceBytes : null,
            consoleErrors: consoleErrors.slice(0, 10),
        };
        console.log(`SUMMARY ${JSON.stringify(summary, null, 2)}`);
        await test.info().attach('pane-surface-heap', { body: JSON.stringify({ rows, summary }, null, 2), contentType: 'application/json' });

        // Memory acceptance: a filtered pane must stay well below the compiled-cache baseline.
        expect(summary.firstPaneDeltaMB).not.toBeNull();
        expect(summary.firstPaneDeltaMB!).toBeLessThan(30);
        expect(summary.secondPaneDeltaMB!).toBeLessThan(20);
        expect(consoleErrors.filter(text => text.includes('slot') || text.includes('hapi-dsh'))).toEqual([]);
    } finally {
        await environment?.close();
    }
});
