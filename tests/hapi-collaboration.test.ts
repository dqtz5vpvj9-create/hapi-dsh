import assert from 'node:assert/strict';
import test from 'node:test';
import { HapiSessionExtras } from '../src/hapi/session-extras.ts';
import { acceptSourceStructuredState, sourceTeamProjection, type SourceWorkEvent, type SourceWorkLink } from '../src/source-collaboration-types.ts';
import type { HapiSession } from '../src/codex/contracts.ts';

const source = { sourceHubId: 'collaboration-hub', sourceSessionId: 'original-session', machineId: 'original-machine' };
const team = { teamName: 'Original team', members: [{ name: 'Planner', status: 'active' as const }], tasks: [{ id: 'task-1', title: 'Read original files', status: 'in_progress' as const, owner: 'Planner' }] };
const event: SourceWorkEvent = { id: 'event-1', ts: 1700000000000, sourceKind: 'session', sourceRef: 'another-session', sinkKind: 'session', sinkRef: source.sourceSessionId,
    eventType: 'task.updated', summary: 'Original hand-off', payloadJson: { message: 'original metadata' }, artifactRefs: [{ kind: 'file', ref: '/source/result.txt' }], tags: ['task'],
    relatedSessionId: source.sourceSessionId, relatedEventId: null, provenance: 'original-runner', idempotencyKey: null, dedupeKey: null, confidence: null, severity: null, expiresAt: null,
    principal: { kind: 'agent', id: 'Planner', on_behalf_of: 'human-owner' } };
const link: SourceWorkLink = { id: 'link-1', fromEventId: 'event-1', toEventId: 'event-2', relationType: 'triggered', createdAt: event.ts, metadataJson: { reason: 'original relation' } };
function fixture() {
    const calls: Array<{ path: string; method: string }> = [];
    const session = { id: source.sourceSessionId, metadata: { machineId: source.machineId, path: '/source' } } as HapiSession;
    const state = { enabled: true, events: [event], event, links: [link] };
    const extras = new HapiSessionExtras({ hubId: source.sourceHubId, getSession: async () => session,
        readBinary: async () => { throw new Error('No binary access is needed'); },
        request: async (path, options) => {
            calls.push({ path, method: options?.method ?? 'GET' });
            if (path === '/health') return { capabilities: { workGraph: state.enabled } };
            if (path.startsWith('/api/work-graph/events?')) return { events: state.events };
            if (path.endsWith('/links')) return { links: state.links };
            return { event: state.event };
        } });
    return { calls, state, extras };
}
test('original team payloads and independent watermarks preserve clears against stale full snapshots', () => {
    assert.deepEqual(sourceTeamProjection({ teamState: team, teamStateUpdatedAt: 20 }), { team, teamRevision: 20, teamError: null });
    assert.match(sourceTeamProjection({ teamState: { teamName: 123 } }).teamError!, /unsupported format/);
    const cleared = { teamStateUpdatedAt: 30, todosUpdatedAt: 40 };
    const stale = { teamState: team, teamStateUpdatedAt: 20, todos: [{ status: 'pending' }], todosUpdatedAt: 30 };
    const merged = { ...stale, ...acceptSourceStructuredState(cleared, stale) };
    assert.deepEqual(sourceTeamProjection(merged), { team: null, teamRevision: 30, teamError: null });
    assert.deepEqual(merged.todos, []); assert.equal(merged.todosUpdatedAt, 40);
    assert.deepEqual(acceptSourceStructuredState(cleared, { teamState: team, teamStateUpdatedAt: 31, todosUpdatedAt: 41 }), {});
});
test('source work ledger uses the original capability, source filter and bounded limit without mutations', async () => {
    const env = fixture();
    const result = await env.extras.sourceWorkGraph({ source, limit: 200 });
    assert.deepEqual(result, { available: true, events: [event], requestedLimit: 200 });
    assert.equal(env.calls[1]!.path, '/api/work-graph/events?related_session_id=original-session&limit=200');
    env.state.enabled = false;
    assert.deepEqual(await env.extras.sourceWorkGraph({ source }), { available: false, events: [], requestedLimit: 100 });
    assert.equal(env.calls.length, 3); assert.equal(env.calls.every(call => call.method === 'GET'), true);
    await assert.rejects(env.extras.sourceWorkGraph({ source: { ...source, machineId: 'wrong-machine' } }), /ownership changed/);
    await assert.rejects(env.extras.sourceWorkGraph({ source: { ...source, sourceHubId: 'wrong-hub' } }), /different Hub/);
    assert.equal(env.calls.length, 3);
});
test('work events and link inspection cannot cross source sessions or quietly attach unrelated links', async () => {
    const env = fixture();
    assert.deepEqual(await env.extras.sourceWorkGraphLinks({ source, eventId: event.id }), { event, links: [link] });
    env.state.events = [{ ...event, relatedSessionId: 'someone-else' }];
    await assert.rejects(env.extras.sourceWorkGraph({ source }), /another source conversation/);
    env.state.event = { ...event, relatedSessionId: 'someone-else' };
    const before = env.calls.length;
    await assert.rejects(env.extras.sourceWorkGraphLinks({ source, eventId: event.id }), /does not belong/);
    assert.equal(env.calls.length, before + 1);
    env.state.event = event; env.state.links = [{ ...link, fromEventId: 'unrelated-1', toEventId: 'unrelated-2' }];
    await assert.rejects(env.extras.sourceWorkGraphLinks({ source, eventId: event.id }), /another event/);
});
