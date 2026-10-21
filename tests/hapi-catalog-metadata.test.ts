import assert from 'node:assert/strict';
import test from 'node:test';
import { catalogDisplayMetadata, catalogRowState } from '../src/hapi/catalog-metadata.ts';
test('source search metadata preserves missing worktree paths and whitelists display fields without leaking arbitrary metadata', () => {
    const output = catalogDisplayMetadata({ path: '/must-not-invent-worktree-path', summary: { text: 'Original summary', private: 'hidden' },
        worktree: { name: 'branch-name', basePath: '/original/project', branch: 'feature/branch', env: { secret: 'hidden' } },
        codexAgentNickname: 'Planner', codexAgentRole: 'planner', codexSubagents: [{ nickname: 'Worker', role: 'coder', threadId: 'native-child', apiKey: 'hidden' }],
        credentials: { token: 'hidden' } });
    assert.deepEqual(output, { sourceSummary: 'Original summary', sourceWorktree: { name: 'branch-name', basePath: '/original/project', branch: 'feature/branch' },
        sourceSubagentSearch: ['Planner', 'planner', 'Worker', 'coder', 'native-child'] });
    assert.equal(JSON.stringify(output).includes('hidden'), false);
});
test('sidebar facts preserve unknown schedules and choose independent source watermarks including clears', () => {
    assert.deepEqual(catalogRowState({}), { todoProgress: null, futureScheduledMessageCount: null, nextScheduledAt: null, serviceTier: null, backgroundTaskCount: null, pendingRequestsCount: null });
    const summary = { updatedAt: 10, todosUpdatedAt: 20, todoProgress: { completed: 1, total: 3 }, agentStateVersion: 5, pendingRequestsCount: 2,
        futureScheduledMessageCount: 4, nextScheduledAt: 123456, serviceTier: 'fast', backgroundTaskCount: 3 };
    const full = { updatedAt: 5, todosUpdatedAt: 10, todos: [{ status: 'completed' }], agentStateVersion: 4, agentState: { requests: {} }, serviceTier: 'standard', backgroundTaskCount: 0 };
    assert.deepEqual(catalogRowState(full, summary), { todoProgress: { completed: 1, total: 3 }, futureScheduledMessageCount: 4, nextScheduledAt: 123456, serviceTier: 'fast', backgroundTaskCount: 3, pendingRequestsCount: 2 });
    assert.deepEqual(catalogRowState({ ...full, updatedAt: 30, todosUpdatedAt: 30, todos: undefined, agentStateVersion: 6 }, summary), {
        todoProgress: null, futureScheduledMessageCount: 4, nextScheduledAt: 123456, serviceTier: 'standard', backgroundTaskCount: 0, pendingRequestsCount: 0,
    });
});
