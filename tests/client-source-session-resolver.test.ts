/** Public Remote/catalog protocol fixtures, with no alternate renderer or retained Session. */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import { resolveOriginalSession } from '../src/client/source-session-resolver.ts';
import { SourceResolutionError, sourceResolutionFailure } from '../src/client/source-session-state.ts';

function catalog() {
    const id = 'official-display' as SessionId;
    let row: SessionSummary = { id, displayTitle: 'Synthetic', running: false, blank: false, updatedAt: 1, retainedBy: {} };
    const listeners = new Set<() => void>(); let reads = 0;
    const list = {
        getSnapshot: (): SessionListState => ({ ids: [id], byId: { [id]: row }, phase: 'ready', projectionsBySession: {} }),
        subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    };
    return { list, refresh: async () => { reads++; }, reads: () => reads, listenerCount: () => listeners.size,
        project(hubId: string, sourceSessionId: string) {
            row = { ...row, projectionValues: { hapi: { hubId, hapiSessionId: sourceSessionId } } as never };
            for (const listener of [...listeners]) listener();
        } };
}
const source = { hubId: 'original-hub', sourceSessionId: 'original-source' };

test('source loading failures preserve authoritative missing, removed, denied and transport distinctions', () => {
    for (const [status, expected] of [[404, 'not-found'], [410, 'removed'], [401, 'denied'], [403, 'denied'], [500, 'transport'], [503, 'transport'], [408, 'transport'], [429, 'transport']] as const) {
        assert.equal(sourceResolutionFailure({ message: 'Synthetic source response', details: { status } }), expected);
    }
    assert.equal(sourceResolutionFailure({ details: { sourceCode: 'source_not_ready' } }), 'not-ready');
    assert.equal(sourceResolutionFailure({ details: { sourceCode: 'source_hub_mismatch' } }), 'identity');
    assert.equal(sourceResolutionFailure({ details: { sourceCode: 'source_identity_mismatch' } }), 'identity');
    assert.equal(sourceResolutionFailure({ details: { outcome: 'indeterminate' } }), 'transport');
    assert.equal(sourceResolutionFailure(new Error('English text mentions 404 or removed without a source status')), 'unknown');
    assert.equal(sourceResolutionFailure(new SourceResolutionError('ambiguous', 'Multiple source bindings')), 'ambiguous');
});

test('exact source hydration waits for the official projection, including a temporarily same-named foreign Hub', async () => {
    const sessions = catalog(), lifetime = new AbortController(); let ready = false;
    const waiting = resolveOriginalSession({ sourceSessionResolve: async request => ({ ok: true, value: { ...request, sessionId: 'official-display' } }) }, sessions, source, lifetime.signal)
        .then(() => { ready = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(ready, false, 'a display header alone is insufficient');
    sessions.project('foreign-hub', source.sourceSessionId); await Promise.resolve(); assert.equal(ready, false);
    sessions.project(source.hubId, 'foreign-source'); await Promise.resolve(); assert.equal(ready, false);
    sessions.project(source.hubId, source.sourceSessionId); await waiting;
    assert.equal(ready, true); assert.equal(sessions.listenerCount(), 0); assert.equal(sessions.reads(), 1);
});

test('a response for another source is rejected before refreshing or following its display', async () => {
    for (const change of [{ hubId: 'foreign-hub' }, { sourceSessionId: 'foreign-source' }]) {
        const sessions = catalog();
        await assert.rejects(resolveOriginalSession({ sourceSessionResolve: async request => ({ ok: true, value: { ...request, ...change, sessionId: 'official-display' } }) },
            sessions, source, new AbortController().signal), /another original session/);
        assert.equal(sessions.reads(), 0); assert.equal(sessions.listenerCount(), 0);
    }
});

test('disposing a pending source wait stops catalog reads and ignores a late Remote result', async () => {
    const sessions = catalog(), lifetime = new AbortController(); let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const waiting = resolveOriginalSession({ sourceSessionResolve: async request => { await gate; return { ok: true, value: { ...request, sessionId: 'official-display' } }; } },
        sessions, source, lifetime.signal);
    lifetime.abort(new Error('Workspace closed')); finish();
    await assert.rejects(waiting, /Workspace closed/);
    assert.equal(sessions.reads(), 0); assert.equal(sessions.listenerCount(), 0);
});
