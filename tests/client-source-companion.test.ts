import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import type { SourceCompanionApi, SourceCompanionInfo, SourceCompanionLink, SourceCompanionReveal } from '../src/source-companion-types.ts';
import { SourceCompanionController } from '../src/client/source-companion-state.ts';

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const png = 'data:image/png;base64,iVBORw0KGgo=';
const info = (): SourceCompanionInfo => ({ hubId: 'original-hub', sourceUrl: 'http://127.0.0.1:3006', endpoint: { url: 'https://original-hapi.example', origin: 'configured' }, unavailableReason: null, warnings: [] });
const link = (hub = info()): SourceCompanionLink => ({ hubId: hub.hubId, endpointUrl: hub.endpoint!.url,
    link: `hapicompanion://bind?${new URLSearchParams({ hub: hub.endpoint!.url, code: 'fixture+opaque:team' })}` });
class Api implements SourceCompanionApi {
    reads = 0; reveals: SourceCompanionReveal[] = []; current = info(); result: SourceCompanionLink | undefined;
    pending: Promise<RemoteResult<SourceCompanionLink>> | undefined;
    async sourceCompanionInfo() { this.reads++; return { ok: true as const, value: structuredClone(this.current) }; }
    async sourceCompanionReveal(request: SourceCompanionReveal) {
        this.reveals.push(request);
        return this.pending ?? { ok: true as const, value: this.result ?? link(this.current) };
    }
}

test('opening Companion only reads metadata; explicit reveal, copy, and hide retain no saved credential', async () => {
    const api = new Api(), encoded: string[] = [], clipboard: string[] = [];
    const controller = new SourceCompanionController(api, async value => { encoded.push(value); return png; });
    assert.equal(api.reads, 0); await controller.start();
    assert.equal(api.reads, 1); assert.equal(api.reveals.length, 0); assert.equal(encoded.length, 0);
    await controller.reveal(); assert.deepEqual(api.reveals, [{ hubId: info().hubId, endpointUrl: info().endpoint!.url }]);
    assert.equal(controller.getSnapshot().qrDataUrl, png); assert.deepEqual(encoded, [link().link]);
    await controller.copy(async value => { clipboard.push(value); });
    assert.deepEqual(clipboard, [link().link]); assert.equal(controller.getSnapshot().copied, true);
    controller.hide(); assert.equal(controller.getSnapshot().phase, 'ready'); assert.equal(controller.getSnapshot().link, null);
    assert.equal(controller.getSnapshot().qrDataUrl, null); assert.equal(controller.getSnapshot().copied, false);
    await controller.copy(async value => { clipboard.push(value); }); assert.equal(clipboard.length, 1);
    controller.dispose(); await controller.reveal(); assert.equal(api.reveals.length, 1);
});

test('hiding or disposing a pending reveal discards its late secret before QR encoding', async () => {
    for (const close of ['hide', 'dispose'] as const) {
        const api = new Api(), pending = deferred<RemoteResult<SourceCompanionLink>>(); api.pending = pending.promise;
        let encoded = 0; const controller = new SourceCompanionController(api, async () => { encoded++; return png; });
        await controller.start(); const revealing = controller.reveal(); assert.equal(controller.getSnapshot().phase, 'revealing');
        controller[close](); pending.resolve({ ok: true, value: link() }); await revealing;
        assert.equal(controller.getSnapshot().link, null); assert.equal(controller.getSnapshot().qrDataUrl, null); assert.equal(encoded, 0);
    }
});

test('late QR and clipboard results cannot reopen a hidden link or replace a newer Hub view', async () => {
    const api = new Api(), pending = deferred<string>(), controller = new SourceCompanionController(api, () => pending.promise);
    await controller.start(); const reveal = controller.reveal(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(controller.getSnapshot().phase, 'revealed');
    const copied = deferred<void>(); const copying = controller.copy(() => copied.promise);
    api.current = { ...info(), hubId: 'second-hub', endpoint: { url: 'https://second-hapi.example', origin: 'configured' } };
    await controller.refresh(); pending.resolve(png); copied.resolve(); await Promise.all([reveal, copying]);
    assert.equal(controller.getSnapshot().info?.hubId, 'second-hub'); assert.equal(controller.getSnapshot().link, null);
    assert.equal(controller.getSnapshot().qrDataUrl, null); assert.equal(controller.getSnapshot().copied, false);
    assert.equal(api.reveals.length, 1, 'A metadata refresh never performs a second secret export');
    controller.dispose(); await controller.start(); assert.equal(controller.getSnapshot().phase, 'ready');
    assert.equal(controller.getSnapshot().link, null, 'Effect restart does not recover a previous secret');
});

test('a connection generation refresh forgets a pending old-Hub reveal and only re-reads current metadata', async () => {
    const api = new Api(), response = deferred<RemoteResult<SourceCompanionLink>>(); api.pending = response.promise;
    let encoded = 0; const controller = new SourceCompanionController(api, async () => { encoded++; return png; });
    await controller.start(); const reveal = controller.reveal();
    api.current = { ...info(), hubId: 'replacement-hub', endpoint: { url: 'https://replacement.example', origin: 'configured' } };
    // The installer calls this synchronously from the public connection/reset event.
    const refreshed = controller.refresh(); assert.equal(controller.getSnapshot().phase, 'loading');
    response.resolve({ ok: true, value: link() }); await Promise.all([refreshed, reveal]);
    assert.equal(controller.getSnapshot().info?.hubId, 'replacement-hub'); assert.equal(controller.getSnapshot().link, null);
    assert.equal(controller.getSnapshot().qrDataUrl, null); assert.equal(encoded, 0); assert.equal(api.reveals.length, 1);
});

test('QR and clipboard failures keep the explicit manual link without exposing diagnostic text', async () => {
    const api = new Api(), controller = new SourceCompanionController(api, async value => { throw new Error(`Renderer failure ${value}`); });
    await controller.start(); await controller.reveal();
    assert.equal(controller.getSnapshot().qrFailed, true); assert.equal(controller.getSnapshot().link, link().link);
    await controller.copy(async value => { throw new Error(`Clipboard failure ${value}`); });
    assert.equal(controller.getSnapshot().error, 'copy-failed'); assert.equal(controller.getSnapshot().copied, false);
    assert.equal(controller.getSnapshot().link, link().link);
    controller.hide(); assert.equal(controller.getSnapshot().error, null); assert.equal(controller.getSnapshot().qrFailed, false);
});

test('an unavailable endpoint or a mismatched secret response cannot be revealed', async () => {
    const api = new Api(); api.current = { ...info(), endpoint: null, unavailableReason: 'https-required' };
    let encoded = 0; const controller = new SourceCompanionController(api, async () => { encoded++; return png; });
    await controller.start(); await controller.reveal(); assert.equal(api.reveals.length, 0);
    api.current = info(); await controller.refresh();
    api.result = link({ ...info(), hubId: 'other-hub' }); await controller.reveal();
    assert.equal(controller.getSnapshot().error, 'invalid-response'); assert.equal(controller.getSnapshot().link, null); assert.equal(encoded, 0);
    api.result = { ...link(), link: `${link().link}&code=another-fixture` }; await controller.reveal();
    assert.equal(controller.getSnapshot().error, 'invalid-response'); assert.equal(controller.getSnapshot().link, null);
});
