import type { WebBootGraph } from '@deepseek-ai/dsh-client-modules';
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver';

const HMR = '@deepseek-ai/dsh-client-hmr';

// Only independent views wait. Chat/input/attachment renderers, source services,
// theme/locale, General's real Settings launcher and first-run Models remain in
// the initial graph. Unknown plugins also remain initial; required closures win.
const RESOURCE_VIEWS = new Set([
    '@deepseek-ai/dsh-client-ui-file-actions',
    '@deepseek-ai/dsh-client-ui-open-in-app',
    '@deepseek-ai/dsh-client-ui-sidebar-documentpreview',
    '@deepseek-ai/dsh-client-ui-sidebar-terminal',
    '@deepseek-ai/dsh-client-ui-sidebar-files',
    // Independent additive header/inspector entries also need to become
    // reachable without asking the user to open an unrelated Settings page.
    '@deepseek-ai/dsh-client-ui-jobs',
    '@deepseek-ai/dsh-client-ui-schedule',
    '@deepseek-ai/dsh-session-log-export',
    '@deepseek-ai/dsh-experimental-client-ui-agent-team',
]);
const SECOND_STAGE = new Set([
    ...RESOURCE_VIEWS,
    HMR,
    '@deepseek-ai/dsh-client-ui-settings-account',
    '@deepseek-ai/dsh-client-product-analytics',
    '@deepseek-ai/dsh-client-ui-shortcuts',
    '@deepseek-ai/dsh-client-ui-settings-plugin-inventory',
    '@deepseek-ai/dsh-client-ui-settings-subagent',
    '@deepseek-ai/dsh-client-ui-settings-web-search',
    '@deepseek-ai/dsh-client-ui-settings-plugins',
    '@deepseek-ai/dsh-client-ui-settings-shell',
    '@deepseek-ai/dsh-client-ui-settings-session-log',
    '@deepseek-ai/dsh-client-ui-settings-agent-loop',
]);

type BootEntry = WebBootGraph['entries'][number];
function includeDependencies(rows: ReadonlyMap<string, BootEntry>, id: string, keep: Set<string>): void {
    const row = rows.get(id) ?? rows.get(id.replace(/\/client$/, ''));
    if (!row || keep.has(row.id)) return;
    keep.add(row.id);
    for (const dependency of [...row.inject ?? [], ...row.external ?? []]) includeDependencies(rows, dependency, keep);
}

/** Compose data for the official loader; no upstream code or factories change.
 * Required dependency closures always win over the optional-page policy. */
export function workspaceBootGraph(graph: WebBootGraph): WebBootGraph {
    const rows = new Map(graph.entries.map(row => [row.id, row]));
    const keep = new Set<string>();
    for (const row of graph.entries) if (!SECOND_STAGE.has(row.id)) includeDependencies(rows, row.id, keep);
    return independentBootBatches({ ...graph, entries: graph.entries.filter(row => keep.has(row.id)) });
}

/** One cumulative resource/utility stage, loaded on resource demand or after the
 * selected reader is complete. Settings subpages stay on explicit demand. */
export function workspaceResourceBootGraph(graph: WebBootGraph): WebBootGraph {
    const rows = new Map(graph.entries.map(row => [row.id, row]));
    const keep = new Set(workspaceBootGraph(graph).entries.map(row => row.id));
    for (const id of RESOURCE_VIEWS) includeDependencies(rows, id, keep);
    return independentBootBatches({ ...graph, entries: graph.entries.filter(row => keep.has(row.id)) });
}

/** A newly fetched optional roster may add entries, but cannot replace an
 * already running reader/source/input. Revision changes use controlled update. */
export function assertStableBootEntries(graph: WebBootGraph,
    active: readonly Pick<BootEntry, 'id' | 'rev' | 'inject' | 'external'>[]): void {
    const rows = new Map(graph.entries.map(row => [row.id, row]));
    const signature = (row: Pick<BootEntry, 'rev' | 'inject' | 'external'>): string =>
        JSON.stringify([row.rev, row.inject ?? [], row.external ?? []]);
    for (const row of active) {
        const next = rows.get(row.id);
        if (!next || signature(next) !== signature(row)) {
            throw new Error(`Deferred graph changes active entry ${row.id}; a controlled update is required`);
        }
    }
}

/** Each official sync adds one optional entry and its complete dependency
 * closure. Callers can yield to a reader between syncs without removing any
 * existing entry. All stages use this fresh Host graph, including its revs.
 * HMR and optional entries needing it join the final complete graph. A required
 * stage-one dependency on HMR wins: it was already present and stays present. */
export function deferredBootStages(graph: WebBootGraph): readonly WebBootGraph[] {
    const rows = new Map(graph.entries.map(row => [row.id, row]));
    const keep = new Set(workspaceBootGraph(graph).entries.map(row => row.id));
    const stages: WebBootGraph[] = [];
    for (const row of graph.entries) {
        if (keep.has(row.id) || row.id === HMR) continue;
        const closure = new Set<string>();
        includeDependencies(rows, row.id, closure);
        if (!keep.has(HMR) && closure.has(HMR)) continue;
        for (const id of closure) keep.add(id);
        stages.push(independentBootBatches({ ...graph, entries: graph.entries.filter(entry => keep.has(entry.id)) }));
    }
    // Even an all-required graph gets one sync: its revisions may have changed
    // while this browser downloaded its original first-stage carrier.
    if (keep.size < rows.size || stages.length === 0) stages.push(independentBootBatches(graph));
    return stages;
}

/** Keep full-graph reconciliation from executing a combo containing factories
 * already registered by stage one. Also reusable by supported Web carriers. */
export function independentBootBatches(graph: WebBootGraph): WebBootGraph {
    const bootstrap = graph.batches.filter(batch => batch.phase === 'bootstrap');
    const bootIds = new Set(bootstrap.flatMap(batch => batch.entries));
    // Exact official single-resource URLs retain their independent immutable
    // cache identities across HAPI releases and avoid downloading omitted pages
    // through a combo that also contains a required module.
    return { ...graph, batches: [...bootstrap, ...graph.entries.filter(row => !bootIds.has(row.id)).map(row => ({
        phase: 'application' as const, url: row.url, rev: row.rev, entries: [row.id],
    }))] };
}

/** The supported index-inject hook owns the carrier's initial roster only.
 * The Host graph, plugin inventory and plugin-event stream stay complete. */
export function stageWorkspaceBoot(table: IndexInjection[], graph: WebBootGraph): void {
    const boot = table.find(row => row.kind === 'global' && row.name === '__DSH_BOOT__');
    if (!boot || boot.kind !== 'global') return;
    const first = workspaceBootGraph(graph);
    const oldPreloads = new Set(graph.batches.filter(batch => batch.phase === 'application').map(batch => batch.url));
    for (let index = table.length - 1; index >= 0; index--) {
        const row = table[index]!;
        if (row.kind === 'script-preload' && oldPreloads.has(row.src)) table.splice(index, 1);
    }
    boot.value = first;
    table.push({ kind: 'global', name: '__HAPI_DSH_STAGED_BOOT__', value: true });
    table.push(...first.batches.filter(batch => batch.phase === 'application').map(batch => ({ kind: 'script-preload' as const, src: batch.url })));
}
