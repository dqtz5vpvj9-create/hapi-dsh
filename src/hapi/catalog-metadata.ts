import type { CatalogSession } from '../client-api.ts';
import { record } from '../codex/native.ts';

/** Original HAPI shared/src/sessionSummary.ts identity rules, 0f8ef697
 * (AGPL-3.0-only, copyright HAPI contributors). Known flavors never borrow a
 * stale native ID from another engine. This deliberately does not use codexHome. */
const agentIdFields: Readonly<Record<string, string>> = {
    claude: 'claudeSessionId', codex: 'codexSessionId', gemini: 'geminiSessionId', dsh: 'dshSessionId',
    opencode: 'opencodeSessionId', grok: 'grokSessionId', agy: 'agySessionId', cursor: 'cursorSessionId',
    kimi: 'kimiSessionId', copilot: 'copilotSessionId', pi: 'piSessionId', qoder: 'qoderSessionId',
};
const legacyAgentIdFields = ['codexSessionId', 'claudeSessionId', 'geminiSessionId', 'opencodeSessionId',
    'grokSessionId', 'agySessionId', 'cursorSessionId', 'kimiSessionId', 'copilotSessionId'] as const;
const textOrNull = (value: unknown): string | null => typeof value === 'string' ? value : null;

/** Whitelisted original list facts, separate from a DSH display's synthesized title and blank flag. */
export function catalogListFacts(fullValue: unknown, summaryValue?: unknown): NonNullable<CatalogSession['sourceListFacts']> {
    const full = record(fullValue), summary = record(summaryValue);
    // Metadata has its own version. A more recent message timestamp does not
    // make an older metadata snapshot authoritative for native identity.
    const fullIsNewer = full && typeof full.metadataVersion === 'number' && typeof summary?.metadataVersion === 'number'
        && full.metadataVersion > summary.metadataVersion;
    const useSummary = summary !== undefined && !fullIsNewer;
    const metadata = record((useSummary ? summary : full)?.metadata);
    const flavor = textOrNull(metadata?.flavor);
    let agentSessionId: string | null = null;
    if (useSummary) agentSessionId = textOrNull(metadata?.agentSessionId)?.trim() || null;
    else if (metadata) {
        const field = flavor && Object.hasOwn(agentIdFields, flavor) ? agentIdFields[flavor] : undefined;
        if (field) agentSessionId = textOrNull(metadata[field])?.trim() || null;
        else {
            for (const candidate of legacyAgentIdFields) if (metadata[candidate] !== undefined && metadata[candidate] !== null) {
                agentSessionId = textOrNull(metadata[candidate])?.trim() || null; break;
            }
        }
    }
    return {
        metadataPresent: metadata !== undefined, flavor, agentSessionId,
        codexStoreId: textOrNull(metadata?.codexStoreId ?? (!useSummary ? metadata?.homeDir : undefined)),
        hasTitleSignal: Boolean(textOrNull(metadata?.name)?.trim() || textOrNull(record(metadata?.summary)?.text)?.trim()),
        hasConversationContent: typeof summary?.hasConversationContent === 'boolean' ? summary.hasConversationContent : null,
    };
}

/** Original HAPI search fields only; arbitrary Runner metadata never enters the browser catalog. */
export function catalogDisplayMetadata(value: unknown): Pick<CatalogSession, 'sourceSummary' | 'sourceWorktree' | 'sourceSubagentSearch'> {
    const metadata = record(value), summary = record(metadata?.summary), worktree = record(metadata?.worktree);
    const children = Array.isArray(metadata?.codexSubagents) ? metadata.codexSubagents : [];
    const fields: unknown[] = [metadata?.codexAgentNickname, metadata?.codexAgentRole, metadata?.codexAgentPath,
        ...children.flatMap(value => { const child = record(value); return [child?.nickname, child?.role, child?.path, child?.threadId]; })];
    return {
        sourceSummary: typeof summary?.text === 'string' ? summary.text : null,
        sourceWorktree: worktree && typeof worktree.name === 'string' && typeof worktree.basePath === 'string'
            ? { name: worktree.name, basePath: worktree.basePath, ...(typeof worktree.worktreePath === 'string' ? { worktreePath: worktree.worktreePath } : {}),
                ...(typeof worktree.branch === 'string' ? { branch: worktree.branch } : {}) } : null,
        sourceSubagentSearch: [...new Set(fields.filter((field): field is string => typeof field === 'string' && field.length > 0))],
    };
}

const count = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
/** Source: HAPI shared/src/sessionSummary.ts. Schedules are only available on
 * the original list DTO; a delivery journal is not a substitute for this count. */
export function catalogRowState(fullValue: unknown, summaryValue?: unknown): NonNullable<CatalogSession['sourceRowState']> {
    const full = record(fullValue), summary = record(summaryValue), rawProgress = record(summary?.todoProgress);
    const fullTodos = Array.isArray(full?.todos) ? full.todos : null;
    const preferFullTodos = (fullTodos !== null || typeof full?.todosUpdatedAt === 'number') && (typeof summary?.todosUpdatedAt !== 'number'
        || typeof full?.todosUpdatedAt === 'number' && full.todosUpdatedAt >= summary.todosUpdatedAt);
    const completed = count(rawProgress?.completed), total = count(rawProgress?.total);
    const progress = completed !== null && total !== null && completed <= total ? { completed, total } : null;
    const requests = record(record(full?.agentState)?.requests);
    const preferFullRequests = full && (typeof summary?.agentStateVersion !== 'number'
        || typeof full.agentStateVersion === 'number' && full.agentStateVersion >= summary.agentStateVersion);
    const latest = full && (!summary || typeof summary.updatedAt !== 'number'
        || typeof full.updatedAt === 'number' && full.updatedAt >= summary.updatedAt) ? full : summary;
    return {
        todoProgress: preferFullTodos ? fullTodos && fullTodos.length > 0 ? { completed: fullTodos.filter(todo => record(todo)?.status === 'completed').length, total: fullTodos.length } : null : progress,
        futureScheduledMessageCount: count(summary?.futureScheduledMessageCount),
        nextScheduledAt: typeof summary?.nextScheduledAt === 'number' && Number.isFinite(summary.nextScheduledAt) ? summary.nextScheduledAt : null,
        serviceTier: typeof latest?.serviceTier === 'string' ? latest.serviceTier : null,
        backgroundTaskCount: count(latest?.backgroundTaskCount),
        pendingRequestsCount: preferFullRequests && full?.agentState !== undefined ? Object.keys(requests ?? {}).length : count(summary?.pendingRequestsCount),
    };
}
