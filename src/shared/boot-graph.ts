import type { WebBootGraph } from '@deepseek-ai/dsh-client-modules';
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver';

// These pages do not render a conversation. HMR joins the second stage too:
// its initial full-graph frame would otherwise undo the initial roster before
// the official boot kernel can mount the workspace.
const SECOND_STAGE = new Set([
    '@deepseek-ai/dsh-client-hmr',
    '@deepseek-ai/dsh-client-ui-settings-account',
    '@deepseek-ai/dsh-client-ui-plugin-manager',
    '@deepseek-ai/dsh-client-ui-sidebar-documentpreview',
    '@deepseek-ai/dsh-client-ui-open-in-app',
    '@deepseek-ai/dsh-client-ui-trajectory',
    '@deepseek-ai/dsh-client-ui-schedule',
    '@deepseek-ai/dsh-client-ui-agent-preset',
    '@deepseek-ai/dsh-client-ui-cordis',
    '@deepseek-ai/dsh-client-ui-settings-plugin-inventory',
    '@deepseek-ai/dsh-client-ui-settings-subagent',
    '@deepseek-ai/dsh-client-ui-message-feedback',
    '@deepseek-ai/dsh-client-ui-settings-web-search',
    '@deepseek-ai/dsh-client-ui-settings-plugins',
    '@deepseek-ai/dsh-client-ui-settings-shell',
    '@deepseek-ai/dsh-client-ui-settings-session-log',
    '@deepseek-ai/dsh-client-ui-settings-agent-loop',
    '@deepseek-ai/dsh-client-product-analytics',
]);

/** Compose data for the official loader; no upstream code or factories change.
 * Required dependency closures always win over the optional-page policy. */
export function workspaceBootGraph(graph: WebBootGraph): WebBootGraph {
    const rows = new Map(graph.entries.map(row => [row.id, row]));
    const keep = new Set<string>();
    const include = (id: string): void => {
        const row = rows.get(id) ?? rows.get(id.replace(/\/client$/, ''));
        if (!row || keep.has(row.id)) return;
        keep.add(row.id);
        for (const dependency of [...row.inject ?? [], ...row.external ?? []]) include(dependency);
    };
    for (const row of graph.entries) if (!SECOND_STAGE.has(row.id)) include(row.id);
    return independentBootBatches({ ...graph, entries: graph.entries.filter(row => keep.has(row.id)) });
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
