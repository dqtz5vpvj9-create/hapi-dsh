import assert from 'node:assert/strict';
import test from 'node:test';
import { catalogDisplayMetadata, catalogListFacts, catalogRowState } from '../src/hapi/catalog-metadata.ts';
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

test('share picker facts use the original list identity and content bit without exposing unrelated metadata', () => {
    const full = { metadataVersion: 2, hasConversationContent: true, metadata: { flavor: 'codex', codexSessionId: 'old-thread', codexHome: '/wrong-store' } };
    const summary = { metadataVersion: 3, hasConversationContent: false, metadata: { flavor: 'codex', agentSessionId: ' source-thread ', codexStoreId: '/source-store', name: ' ', summary: { text: 'Real title' }, token: 'private' } };
    assert.deepEqual(catalogListFacts(full, summary), { metadataPresent: true, flavor: 'codex', agentSessionId: 'source-thread', codexStoreId: '/source-store', hasTitleSignal: true, hasConversationContent: false });
    assert.equal(JSON.stringify(catalogListFacts(full, summary)).includes('private'), false);
    assert.deepEqual(catalogListFacts(full), { metadataPresent: true, flavor: 'codex', agentSessionId: 'old-thread', codexStoreId: null, hasTitleSignal: false, hasConversationContent: null });
});

test('newer original metadata keeps engine-specific IDs, original store fallback and explicit clears', () => {
    const summary = { metadataVersion: 2, hasConversationContent: true, metadata: { flavor: 'codex', agentSessionId: 'old', codexStoreId: '/old' } };
    assert.deepEqual(catalogListFacts({ metadataVersion: 3, metadata: { flavor: 'pi', piSessionId: ' pi-id ', codexSessionId: 'stale-codex', homeDir: '/original-home', codexHome: '/not-store' } }, summary), {
        metadataPresent: true, flavor: 'pi', agentSessionId: 'pi-id', codexStoreId: '/original-home', hasTitleSignal: false, hasConversationContent: true,
    });
    assert.equal(catalogListFacts({ metadata: { flavor: 'dsh', codexSessionId: 'stale' } }).agentSessionId, null);
    assert.equal(catalogListFacts({ metadata: { flavor: 'legacy-unknown', codexSessionId: 'legacy' } }).agentSessionId, 'legacy');
    assert.deepEqual(catalogListFacts({ metadataVersion: 4, metadata: null }, summary), { metadataPresent: false, flavor: null, agentSessionId: null, codexStoreId: null, hasTitleSignal: false, hasConversationContent: true });
});
