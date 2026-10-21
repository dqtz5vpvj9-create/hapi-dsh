import type { CatalogSession } from '../client-api.ts';
import { record } from '../codex/native.ts';

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
