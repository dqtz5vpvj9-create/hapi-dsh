import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from 'node:test';
import { NativeWorkbench } from '../src/hapi/workbench.ts';
import { HapiRequestError, type HapiSession } from '../src/codex/contracts.ts';
import type { HapiClient } from '../src/hapi/client.ts';
import type { FederationMount } from '../src/hub/federation.ts';
import { MAX_EDITABLE_BYTES, WORKBENCH_DOCUMENT_PATH, WORKBENCH_PREVIEW_PATH } from '../src/workbench-types.ts';
import { MAX_SOURCE_GENERATED_MEDIA } from '../src/hapi/generated-media.ts';

const source = { sourceSessionId: 'source-native', sourceHubId: 'source-hub', machineId: 'remote-machine' };
const original = '\ufefffirst\r\nsecond\r\n';
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
function fixture() {
    const session: HapiSession = { id: source.sourceSessionId, active: true, thinking: false, activeAt: 1, updatedAt: 1, metadataVersion: 1, agentStateVersion: 1,
        metadata: { path: '/remote/project', machineId: source.machineId }, namespace: 'authorized-fixture', seq: 1, createdAt: 1, thinkingAt: 0, agentState: null };
    const requests: Array<{ path: string; options: Parameters<HapiClient['request']>[1] }> = [];
    const binaries: Array<{ path: string; options: Parameters<HapiClient['readBinary']>[1] }> = [];
    let respond = async (path: string, _options: Parameters<HapiClient['request']>[1]): Promise<unknown> => {
        if (path.includes('/directory?')) return { success: true, entries: [{ name: 'README.md', type: 'file', size: 10 }] };
        if (path.includes('/file-info?')) return { success: true, entries: [{ path: 'notes.txt', size: Buffer.byteLength(original), modified: 4 }] };
        if (path.includes('/file?')) return { success: true, content: Buffer.from(original).toString('base64'), hash: digest(original), writable: true, modified: 4 };
        if (path.endsWith('/file')) return { success: true, hash: digest('saved'), modified: 5 };
        if (path.includes('/document-preview?')) return { previewId: 'preview-id', version: digest(original), length: 6 };
        return { success: true, stdout: 'source response' };
    };
    const client: Pick<HapiClient, 'hubId' | 'getSession' | 'request' | 'readBinary'> = {
        hubId: source.sourceHubId,
        getSession: async () => structuredClone(session),
        request: async (path, options) => { requests.push({ path, options }); return respond(path, options); },
        readBinary: async (path, options) => { binaries.push({ path, options }); return { data: Buffer.from('%PDF-1'), fileName: 'report.pdf', mimeType: 'application/pdf', status: options?.headers ? 206 : 200, headers: options?.headers ? { 'content-range': 'bytes 0-5/6' } : {} }; },
    };
    return { service: new NativeWorkbench(client), client, session, requests, binaries, respond: (value: typeof respond) => { respond = value; } };
}

test('native workbench resolves the original session/machine and delegates paths, never Hub cwd', async () => {
    const f = fixture();
    const directory = await f.service.nativeDirectory({ source });
    assert.equal(directory.machineId, 'remote-machine'); assert.equal(directory.cwd, '/remote/project');
    assert.equal(f.requests[0]?.path, '/api/sessions/source-native/directory?');
    await f.service.nativeGit({ source, kind: 'diff', path: 'name with space.ts', staged: true });
    assert.equal(f.requests[1]?.path, '/api/sessions/source-native/git-diff-file?path=name+with+space.ts&staged=true');
    await assert.rejects(f.service.nativeDirectory({ source: { ...source, sourceHubId: 'another-hub' } }), /another HAPI Hub/);
    await assert.rejects(f.service.nativeDocument({ source, document: { kind: 'file', path: 'file.ts', machineId: 'wrong-machine' } }), /another source machine/);
    f.session.metadata!.machineId = 'moved-machine';
    await assert.rejects(f.service.nativeDirectory({ source }), /another source machine/);
    assert.equal(f.requests.length, 2);
});

test('inactive and unbound native sessions cannot become local files or terminals', async () => {
    const f = fixture(); f.session.active = false;
    await assert.rejects(f.service.resolveSource(source), /offline/);
    f.session.active = true; delete f.session.metadata!.machineId;
    await assert.rejects(f.service.resolveSource(source), /no verified machine/);
    assert.equal(f.requests.length, 0);
});

test('file editing preserves source BOM/CRLF and forwards the exact optimistic hash once', async () => {
    const f = fixture();
    const file = await f.service.nativeDocument({ source, document: { kind: 'file', path: 'notes.txt' } });
    assert.equal(file.text, 'first\nsecond\n'); assert.deepEqual(file.format, { bom: true, eol: '\r\n' }); assert.equal(file.writable, true);
    await f.service.nativeFileSave({ source, path: 'notes.txt', text: 'changed\n', expectedHash: file.hash!, format: file.format! });
    const request = f.requests.at(-1)!;
    assert.equal(request.options?.method, 'PUT');
    assert.deepEqual(request.options?.body, { path: 'notes.txt', content: Buffer.from('\ufeffchanged\r\n').toString('base64'), expectedHash: digest(original) });
    assert.equal(f.requests.filter(request => request.options?.method === 'PUT').length, 1);
});

test('mixed line endings are displayed without authorizing format-changing saves', async () => {
    const f = fixture();
    const bytes = 'first\r\nsecond\n';
    f.respond(async path => path.includes('/file-info?') ? { success: true, entries: [{ path: 'notes.txt', size: bytes.length }] }
        : { success: true, content: Buffer.from(bytes).toString('base64'), hash: digest(bytes), writable: true });
    const file = await f.service.nativeDocument({ source, document: { kind: 'file', path: 'notes.txt' } });
    assert.equal(file.format?.mixed, true); assert.equal(file.writable, false);
    await assert.rejects(f.service.nativeFileSave({ source, path: 'notes.txt', text: 'new', expectedHash: file.hash!, format: file.format! }), /Mixed line endings/);
    assert.equal(f.requests.length, 2);
});

test('conflicts remain conflicts and an unknown source save is never automatically replayed', async () => {
    const f = fixture();
    f.respond(async () => ({ success: false, code: 'conflict', error: 'Changed on source' }));
    assert.equal((await f.service.nativeFileSave({ source, path: 'notes.txt', text: 'draft', expectedHash: digest(original) })).code, 'conflict');
    f.respond(async () => { throw new HapiRequestError('Lost after dispatch', 'indeterminate', 401); });
    await assert.rejects(f.service.nativeFileSave({ source, path: 'notes.txt', text: 'draft', expectedHash: digest(original) }), /Lost after dispatch/);
    assert.equal(f.requests.length, 2);
});

test('file edit limit is UTF-8 bytes, and existing oversized files use bounded downloads', async () => {
    const f = fixture();
    await assert.rejects(f.service.nativeFileSave({ source, path: 'notes.txt', text: '漢'.repeat(Math.floor(MAX_EDITABLE_BYTES / 3) + 1), expectedHash: null }), /4 MiB/);
    assert.equal(f.requests.length, 0);
    f.respond(async () => ({ success: true, entries: [{ path: 'large.txt', size: MAX_EDITABLE_BYTES + 1 }] }));
    const result = await f.service.nativeDocument({ source, document: { kind: 'file', path: 'large.txt' } });
    assert.equal(result.text, null); assert.equal(result.writable, false); assert.equal(f.requests.length, 1);
});

test('artifact PDF bytes stay binary and are addressed by the native opaque ID', async () => {
    const f = fixture();
    const result = await f.service.nativeDocument({ source, document: { kind: 'artifact', artifactId: 'opaque/id', fileName: 'claimed.html', mimeType: 'text/html' } });
    assert.equal(result.mimeType, 'application/pdf'); assert.equal(result.fileName, 'report.pdf'); assert.equal(result.text, null);
    assert.equal(f.binaries[0]?.path, '/api/sessions/source-native/artifacts/opaque%2Fid');
});

test('generated media uses its real source registry, authoritative MIME, original limit and no invented conversion API', async () => {
    const f = fixture(); f.session.active = false;
    const document = { kind: 'generated-media' as const, imageId: 'opaque/media?source=1#file', fileName: 'source-hint.docx', mimeType: 'text/html' };
    f.client.readBinary = async (path, options) => {
        f.binaries.push({ path, options });
        return { data: Uint8Array.of(0, 1, 255), fileName: 'actual-original.mp4', mimeType: 'video/mp4', status: 200, headers: {} };
    };
    const value = await f.service.nativeDocument({ source, document });
    assert.equal(value.fileName, 'actual-original.mp4'); assert.equal(value.mimeType, 'video/mp4'); assert.equal(value.text, null);
    assert.equal(value.writable, false); assert.equal(value.officePreview, false);
    assert.equal(f.binaries[0]?.path, '/api/sessions/source-native/generated-images/opaque%2Fmedia%3Fsource%3D1%23file');
    assert.equal(f.binaries[0]?.options?.maxBytes, MAX_SOURCE_GENERATED_MEDIA);
    const query = new URL(value.downloadUrl, 'http://fixture.invalid').searchParams.get('request');
    assert.deepEqual(JSON.parse(query!), { source, document });
    await assert.rejects(f.service.nativePreview({ source, document }), /no Office conversion/);
    await assert.rejects(f.service.nativeDocument({ source: { ...source, machineId: 'wrong-machine' }, document }), /another source machine/);
    assert.equal(f.binaries.length, 1); assert.equal(f.requests.length, 0);
});

test('generated media downloads require normal DSH admission and preserve original response bytes and filename', async () => {
    const f = fixture(), bytes = Uint8Array.of(0, 82, 73, 70, 70, 255);
    f.client.readBinary = async (path, options) => { f.binaries.push({ path, options }); return { data: bytes, mimeType: 'audio/wav', fileName: '原始音频.wav', status: 200, headers: {} }; };
    const handlers = new Map<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>>();
    f.service.mount({ webServer: { register: route => { handlers.set(route.path, route.handler); return () => handlers.delete(route.path); }, registerUpgrade: () => () => {} },
        authorize: request => request.headers.authorization === 'fixture-owner' ? undefined : 401 });
    const input = { source, document: { kind: 'generated-media', imageId: 'audio/opaque', fileName: 'untrusted.png', mimeType: 'image/png' } };
    async function invoke(admitted: boolean) {
        let status = 0, headers: Record<string, string> = {}, body: unknown;
        const response = Object.assign(new EventEmitter(), { destroyed: false, writeHead(code: number, value: Record<string, string> = {}) { status = code; headers = value; }, end(value?: unknown) { body = value; } });
        await handlers.get(WORKBENCH_DOCUMENT_PATH)!({ method: 'GET', url: `${WORKBENCH_DOCUMENT_PATH}?request=${encodeURIComponent(JSON.stringify(input))}`,
            headers: admitted ? { authorization: 'fixture-owner' } : {} } as IncomingMessage, response as unknown as ServerResponse);
        return { status, headers, body };
    }
    try {
        assert.equal((await invoke(false)).status, 401); assert.equal(f.binaries.length, 0);
        const value = await invoke(true);
        assert.equal(value.status, 200); assert.deepEqual(value.body, bytes); assert.equal(value.headers['content-type'], 'audio/wav');
        assert.equal(value.headers['content-disposition'], `attachment; filename*=UTF-8''${encodeURIComponent('原始音频.wav')}`);
        assert.equal(value.headers['x-content-type-options'], 'nosniff'); assert.equal(f.binaries[0]?.options?.maxBytes, MAX_SOURCE_GENERATED_MEDIA);
        assert.equal(f.binaries[0]?.path, '/api/sessions/source-native/generated-images/audio%2Fopaque');
    } finally { f.service.close(); }
});

test('filesystem mutation preserves reviewed revision and create cannot silently overwrite', async () => {
    const f = fixture(); f.respond(async () => ({ success: false, code: 'conflict', error: 'Changed' }));
    const operation = { action: 'delete' as const, path: 'dir', recursive: true, expectedRevision: digest('entry') };
    const result = await f.service.nativeFileManage({ source, operation });
    assert.equal(result.code, 'conflict'); assert.deepEqual(f.requests[0]?.options?.body, operation);
    await assert.rejects(f.service.nativeFileManage({ source, operation: { action: 'delete', path: 'dir', recursive: true } } as never));
    assert.equal(f.requests.length, 1);
});

test('raw resource routes enforce DSH admission before source access and preserve preview ranges', async () => {
    const f = fixture();
    const handlers = new Map<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>>();
    const mount: FederationMount = { webServer: { register: route => { handlers.set(route.path, route.handler); return () => handlers.delete(route.path); }, registerUpgrade: () => () => {} }, authorize: request => request.headers.authorization === 'fixture-owner' ? undefined : 401 };
    f.service.mount(mount);
    async function invoke(path: string, payload: unknown, admitted: boolean, range?: string) {
        let status = 0, headers: unknown, body: unknown;
        const response = Object.assign(new EventEmitter(), { destroyed: false, writeHead(code: number, value?: unknown) { status = code; headers = value; }, end(value?: unknown) { body = value; } });
        await handlers.get(path)!({ method: 'GET', url: `${path}?request=${encodeURIComponent(JSON.stringify(payload))}`, headers: { ...(admitted ? { authorization: 'fixture-owner' } : {}), ...(range ? { range } : {}) } } as IncomingMessage, response as unknown as ServerResponse);
        return { status, headers: headers as Record<string, string>, body };
    }
    assert.equal((await invoke(WORKBENCH_DOCUMENT_PATH, { source, document: { kind: 'file', path: 'report.pdf' } }, false)).status, 401);
    assert.equal(f.binaries.length, 0);
    const preview = await f.service.nativePreview({ source, document: { kind: 'file', path: 'report.docx' }, version: digest(original) });
    assert.match(preview.url, /preview-id/);
    const result = await invoke(WORKBENCH_PREVIEW_PATH, { source, previewId: preview.previewId }, true, 'bytes=0-5');
    assert.equal(result.status, 206); assert.equal(result.headers['content-type'], 'application/pdf'); assert.equal(result.headers['content-range'], 'bytes 0-5/6');
    assert.equal(f.binaries[0]?.options?.headers?.Range, 'bytes=0-5');
    assert.equal(JSON.stringify(result).includes('fixture-owner'), false);
    f.service.close(); assert.equal(handlers.size, 0);
});
