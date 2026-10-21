import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { RemoteError, type PeerId, type RemoteInvocation } from '@deepseek-ai/dsh-typert-protocol';
import { SourceCompanionService } from '../src/hapi/source-companion.ts';
import { companionOrigin, sourceCompanionLinkSchema, type SourceCompanionReveal } from '../src/source-companion-types.ts';

declare module '@deepseek-ai/dsh-typert-protocol' {
    interface PrincipalMap { 'companion-fixture-guest': { readonly kind: 'companion-fixture-guest' } }
}
function invocation(kind: 'owner' | 'companion-fixture-guest' = 'owner'): RemoteInvocation {
    const controller = new AbortController();
    return { service: 'hapi', request: { namespace: 'hapi', method: 'sourceCompanionReveal', args: {} }, signal: controller.signal,
        peer: { id: 'companion-test' as PeerId, ctx: new Context(), principal: { kind }, signal: controller.signal, interactions: 'answer', dispose: async () => { controller.abort(); } },
        async *uplink<In>() { /* The Companion Remote is unary and never consumes an uplink. */ } };
}
const endpoint = 'https://original-hapi.example';
const request = { hubId: 'original-hub', endpointUrl: endpoint };
const credential = 'fixture+opaque/%?#&=value:team';

test('Companion info never reads a credential; only an active owner with the exact Hub and endpoint can reveal it', async () => {
    let reads = 0;
    const service = new SourceCompanionService({ hubId: request.hubId, sourceUrl: endpoint, readCredential: () => { reads++; return credential; } });
    const owner = invocation(), guest = invocation('companion-fixture-guest');
    for (const caller of [undefined, guest]) {
        assert.throws(() => service.info(caller), { code: 'hapi/request', details: { outcome: 'rejected', status: 403, sourceCode: 'companion_owner_required' } });
        assert.throws(() => service.reveal(caller, request), { code: 'hapi/request', details: { outcome: 'rejected', status: 403, sourceCode: 'companion_owner_required' } });
    }
    assert.deepEqual(service.info(owner), { hubId: request.hubId, sourceUrl: endpoint, endpoint: { url: endpoint, origin: 'source' }, unavailableReason: null, warnings: [] });
    assert.equal(reads, 0);
    for (const invalid of [{ ...request, hubId: 'another-hub' }, { ...request, endpointUrl: 'https://another-hub.example' }]) {
        assert.throws(() => service.reveal(owner, invalid), { code: 'hapi/request', details: { outcome: 'rejected', status: 409, sourceCode: 'companion_source_changed' } });
    }
    assert.throws(() => service.reveal(owner, { ...request, unexpected: credential } as SourceCompanionReveal), { code: 'hapi/request', details: { outcome: 'rejected', status: 400, sourceCode: 'companion_request_invalid' } });
    assert.equal(reads, 0, 'No failed request may reach the configured credential reader');
    const link = service.reveal(owner, request); assert.equal(reads, 1);
    const parsed = new URL(link.link);
    assert.equal(parsed.protocol, 'hapicompanion:'); assert.equal(parsed.hostname, 'bind');
    assert.equal(parsed.searchParams.get('hub'), endpoint); assert.equal(parsed.searchParams.get('code'), credential);
    assert.equal(sourceCompanionLinkSchema.safeParse(link).success, true);
    assert.equal(JSON.stringify(service.info(owner)).includes(credential), false);
    await owner.peer.dispose();
    assert.throws(() => service.reveal(owner, request), { code: 'hapi/request', details: { outcome: 'rejected', status: 409, sourceCode: 'companion_call_closed' } });
    assert.equal(reads, 1);
});

test('Companion uses only the configured original-Hub alias and never strips a source path or upgrades HTTP silently', () => {
    let reads = 0; const readCredential = () => { reads++; return credential; };
    for (const [sourceUrl, reason] of [['http://127.0.0.1:3006', 'https-required'], ['https://hub.example/api-prefix', 'origin-required']] as const) {
        const service = new SourceCompanionService({ hubId: request.hubId, sourceUrl, readCredential });
        const info = service.info(invocation());
        assert.equal(info.endpoint, null); assert.equal(info.unavailableReason, reason);
        assert.throws(() => service.reveal(invocation(), request), { code: 'hapi/request', details: { outcome: 'rejected', status: 409, sourceCode: 'companion_endpoint_unavailable' } });
    }
    const service = new SourceCompanionService({ hubId: request.hubId, sourceUrl: 'http://127.0.0.1:3006/api-prefix', companionUrl: `${endpoint}/`, readCredential });
    assert.deepEqual(service.info(invocation()).endpoint, { url: endpoint, origin: 'configured' });
    assert.equal(new URL(service.reveal(invocation(), request).link).searchParams.get('hub'), endpoint);
    assert.equal(reads, 1);
    for (const address of ['http://hub.example', 'https://hub.example/prefix', 'https://user:private@hub.example', 'https://hub.example/?query=value', 'https://hub.example/#fragment', 'https://hub.example/?', 'https://hub.example/#']) {
        assert.equal(companionOrigin(address), null);
        assert.throws(() => new SourceCompanionService({ hubId: request.hubId, sourceUrl: endpoint, companionUrl: address, readCredential }), /must be an HTTPS origin/);
    }
    assert.equal(companionOrigin('https://HUB.example:443/'), 'https://hub.example');
    assert.equal(companionOrigin('https://hub.example:8443/'), 'https://hub.example:8443');
    assert.equal(reads, 1);
});

test('credential failure is sanitized, namespaces stay opaque, and callers cannot mutate the service binding', () => {
    const owner = invocation();
    const unavailable = new SourceCompanionService({ hubId: request.hubId, sourceUrl: endpoint, readCredential() { throw new Error(`Private fixture diagnostic ${credential}`); } });
    assert.throws(() => unavailable.reveal(owner, request), error => {
        assert.ok(error instanceof RemoteError); assert.equal(error.details.sourceCode, 'companion_credential_unavailable');
        assert.equal(String(error).includes(credential), false); assert.equal(error.cause, undefined); return true;
    });
    const service = new SourceCompanionService({ hubId: request.hubId, sourceUrl: endpoint, readCredential: () => ` \n${credential}\t ` });
    const info = service.info(owner); info.hubId = 'changed-in-caller'; info.endpoint!.url = 'https://changed.example';
    assert.equal(new URL(service.reveal(owner, request).link).searchParams.get('code'), credential);
    const loopback = new SourceCompanionService({ hubId: request.hubId, sourceUrl: 'https://localhost:3006', readCredential: () => credential });
    assert.deepEqual(loopback.info(owner).warnings, ['loopback-host']);
    assert.equal('paired' in service.info(owner), false, 'There is no source pairing acknowledgement endpoint');
    assert.equal(sourceCompanionLinkSchema.safeParse({ ...service.reveal(owner, request), endpointUrl: 'https://other.example' }).success, false);
});
