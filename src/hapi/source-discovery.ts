import type { HapiSessionSummary } from '../codex/contracts.ts'
import type { DiscoveredSourceSession } from '../source-discovery-types.ts'
import { catalogDisplayMetadata, catalogListFacts, catalogRowState } from './catalog-metadata.ts'

/** Original summaries remain discoverable before any display is attached. */
export function discoverSourceSession(hubId: string, source: HapiSessionSummary, attached: boolean): DiscoveredSourceSession {
    const metadata = source.metadata, facts = catalogListFacts(undefined, source), display = catalogDisplayMetadata(metadata)
    return {
        hubId, sourceSessionId: source.id, title: metadata?.name || metadata?.summary?.text || 'Untitled conversation',
        engine: metadata?.flavor ?? null, machineId: metadata?.machineId ?? null, machineName: metadata?.host ?? null,
        cwd: metadata?.path ?? null, nativeId: facts.agentSessionId, updatedAt: source.updatedAt,
        active: source.active, thinking: source.thinking,
        lifecycleState: typeof metadata?.lifecycleState === 'string' ? metadata.lifecycleState : null,
        summary: display.sourceSummary ?? null, worktree: display.sourceWorktree ?? null, subagentSearch: display.sourceSubagentSearch ?? [],
        pendingRequestsCount: catalogRowState(undefined, source).pendingRequestsCount,
        waitingOn: source.execution?.waitingOn ?? [], binding: attached ? 'attached' : 'pending', error: null,
    }
}
