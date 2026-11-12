/** Actual diagnostic schema/reporting; transport is the explicit boundary fixture. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { uploadFailure, uploadFailureLimit, uploadFailureSchema, type UploadFailure } from '../src/upload-diagnostics.ts';
import { createComposerUploadFailureObserver, createUploadFailureReporter } from '../src/client/upload-failure-report.ts';
import { createSourceUploadAppend } from '../src/client/source-upload-transport.ts';

test('attachment diagnostics allow only fixed operational fields and never inspect messages or payloads', () => {
    const report = uploadFailure('draft-checkpoint', 'hhpi', 'development', {
        name: 'QuotaExceededError', code: 'private-session-id', status: 403,
        get message() { throw new Error('message must not be read'); }, body: 'private bytes', nameOfFile: 'private.png',
    });
    assert.deepEqual(report, { stage: 'draft-checkpoint', source: 'hhpi', build: 'development', name: 'QuotaExceededError', code: 'unknown', status: 403 });
    assert.equal(uploadFailureSchema.safeParse({ ...report, sessionId: 'private' }).success, false);
    assert.equal(uploadFailureSchema.safeParse({ ...report, build: 'x'.repeat(65) }).success, false);
    assert.equal(uploadFailureSchema.safeParse({ ...report, code: 'private/path' }).success, false);
    assert.equal(uploadFailureSchema.safeParse({ ...report, stage: 'unknown stage' }).success, false);
});

test('page and Host counters bound failures without retaining user keys', () => {
    let time = 100;
    for (const maximum of [6, 30]) {
        const allowed = uploadFailureLimit(maximum, () => time);
        for (let index = 0; index < maximum; index++) assert.equal(allowed(), true);
        assert.equal(allowed(), false); time += 60_000; assert.equal(allowed(), true);
    }
});

test('private failure reporting is bounded and synchronous/asynchronous reporting failures stay silent', async () => {
    const reports: UploadFailure[] = [];
    const report = createUploadFailureReporter(async value => { reports.push(value); throw new Error('transport failed'); });
    for (let index = 0; index < 9; index++) report('image-preparation', 'hhpi', new TypeError('private filename'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(reports.length, 6); assert.ok(reports.every(value => value.name === 'TypeError'));
    assert.doesNotThrow(() => createUploadFailureReporter(() => { throw new Error('disconnected'); })('source-resolution', 'hhpi', null));
});

test('official composer observer reports each mounted error occurrence once, with no invented provider stage', () => {
    const reports: unknown[] = [], observe = createComposerUploadFailureObserver((...args) => reports.push(args));
    const file = {}, attachments = [{ id: 'local-only', file }];
    const error = { status: 'error', reason: 'IMAGE_TOO_LARGE', get message() { throw new Error('must not read'); } };
    observe('ordinary', attachments, { 'local-only': error }); observe('ordinary', attachments, { 'local-only': error });
    assert.deepEqual(reports, [['composer-error', 'ordinary', { reason: 'IMAGE_TOO_LARGE' }]]);
    observe('ordinary', attachments, { 'local-only': { status: 'uploading' } });
    observe('ordinary', attachments, { 'local-only': error });
    assert.equal(reports.length, 2, 'a real retry failure is a new occurrence');
});

test('chunk HTTP failures preserve only status/code while retaining the original error behavior', async () => {
    const append = createSourceUploadAppend(async () => new Response('private response body', { status: 503 }));
    await assert.rejects(append({ target: { hostId: 'host', sessionId: 'session' }, uploadId: 'transfer', offset: 0, data: new Uint8Array([1]) },
        { scope: 'scope', signal: new AbortController().signal, assertAllowed() {} }), error => {
        assert.equal((error as { code: string }).code, 'upload/http'); assert.equal((error as { status: number }).status, 503);
        assert.equal(String(error).includes('private response'), false); return true;
    });
});
