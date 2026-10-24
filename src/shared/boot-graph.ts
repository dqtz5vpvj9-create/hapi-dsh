import type { WebBootGraph } from '@deepseek-ai/dsh-client-modules';
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver';

const HMR = '@deepseek-ai/dsh-client-hmr';

// Account owns a large authorization bundle. It and HMR (whose first frame
// reconciles the full Host roster) load only after Settings is opened. All
// other UI plugins register their locale/outlets before transcript mounting:
// late global locale revisions otherwise re-render every retained outlet.
const SECOND_STAGE = new Set([
    HMR,
    '@deepseek-ai/dsh-client-ui-settings-account',
    '@deepseek-ai/dsh-client-product-analytics',
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
