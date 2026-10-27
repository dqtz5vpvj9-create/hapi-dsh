import assert from 'node:assert/strict';
import test from 'node:test';
import type { HapiSession } from '../src/codex/contracts.ts';
import { SourceSessionResolver } from '../src/hapi/source-session-resolver.ts';

/** Identity admission fakes; full Session execution is covered by hapi-catalog-startup.test.ts. */
function fixture() {
    let session = { id: 'original', metadata: { flavor: 'codex', codexNativeSession: true, codexSessionId: 'native-thread' } } as HapiSession;
    let display = { id: 'official-display', binding: { hubId: 'original-hub', hapiSessionId: 'original' }, sourceSession: session };
    let attached = false, gets = 0, nativeAttaches = 0, observedAttaches = 0, reconciles = 0;
    const native = {
        byHapiSession: () => attached ? display : undefined,
        attach: async () => { nativeAttaches++; attached = true; return display; },
        openSource: async (_id: string, source?: HapiSession) => {
            assert.equal(source, session, 'display admission must reuse this exact authoritative source reply');
            if (attached) reconciles++; else { nativeAttaches++; attached = true; }
            return display;
        },
    };
    const observed = { byHapiSession: () => undefined, attach: async () => { observedAttaches++; return undefined; }, openSource: async () => undefined };
    const resolver = new SourceSessionResolver({ hubId: 'original-hub', getSession: async () => { gets++; return session; } }, native, observed);
    return { resolver, changeSource: (value: HapiSession) => { session = value; }, changeDisplay: (hubId: string, sourceSessionId: string) => { display = { ...display, binding: { hubId, hapiSessionId: sourceSessionId } }; },
        counts: () => ({ gets, nativeAttaches, observedAttaches, reconciles }) };
}

test('an exact source request is coalesced and existing generations are reconciled before resolution', async () => {
    const f = fixture(), request = { hubId: 'original-hub', sourceSessionId: 'original' };
    const first = f.resolver.resolve(request), second = f.resolver.resolve(request);
    assert.equal(first, second);
    request.sourceSessionId = 'mutated-after-request';
    assert.deepEqual(await first, { hubId: 'original-hub', sourceSessionId: 'original', sessionId: 'official-display' });
    await f.resolver.resolve({ hubId: 'original-hub', sourceSessionId: 'original' });
    assert.deepEqual(f.counts(), { gets: 2, nativeAttaches: 1, observedAttaches: 0, reconciles: 1 });
});

test('foreign Hubs and invalid IDs are rejected before any source I/O', async () => {
    const f = fixture();
    await assert.rejects(f.resolver.resolve({ hubId: 'different-hub', sourceSessionId: 'original' }), /different original HAPI Hub/);
    for (const sourceSessionId of ['', ' ', 'bad\u0000id', 'x'.repeat(513)]) await assert.rejects(f.resolver.resolve({ hubId: 'original-hub', sourceSessionId }), /identity are required/);
    assert.deepEqual(f.counts(), { gets: 0, nativeAttaches: 0, observedAttaches: 0, reconciles: 0 });
});

test('source details and the final display must both confirm the requested original identity', async () => {
    const wrongSource = fixture(); wrongSource.changeSource({ id: 'another-original', metadata: {} } as HapiSession);
    await assert.rejects(wrongSource.resolver.resolve({ hubId: 'original-hub', sourceSessionId: 'original' }), /another session/);
    assert.equal(wrongSource.counts().nativeAttaches, 0);
    for (const [hubId, sourceSessionId] of [['other-hub', 'original'], ['original-hub', 'another-original']]) {
        const wrongDisplay = fixture(); wrongDisplay.changeDisplay(hubId!, sourceSessionId!);
        await assert.rejects(wrongDisplay.resolver.resolve({ hubId: 'original-hub', sourceSessionId: 'original' }), /session changed/);
    }
});
