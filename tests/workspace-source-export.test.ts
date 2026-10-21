/** Explicit source Remote API/download fixtures, not a physical Hub export. */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { HapiRemoteApi } from '../src/client-api.ts'
import { SourceExportController, SOURCE_EXPORT_FORMAT_KEY, downloadPreparedSourceExport } from '../src/client/source-export-state.ts'

const ok = <T>(value: T) => ({ ok: true as const, value })
const source = { sourceSessionId: 'original-hapi-id', sourceHubId: 'original-hub', machineId: 'original-machine' }
const ready = { type: 'ready' as const, url: '/hapi-dsh/source/export/receipt', fileName: 'original.json', bytes: 2 }

test('original default JSON and format preference retain source identity; a warning needs a separate authorized force request', async () => {
    const requests: Parameters<HapiRemoteApi['sourceExport']>[0][] = [], saved = new Map<string, string>()
    const controller = new SourceExportController({ sourceExport: async request => { requests.push(request); return ok(request.force ? ready : { type: 'warning', count: 20001, limit: 10000, estimatedBytes: 4096 }) } }, source,
        { getItem: key => saved.get(key) ?? null, setItem: (key, value) => { saved.set(key, value) } })
    assert.equal(controller.getSnapshot().format, 'json')
    assert.equal(await controller.prepare(true), null); assert.equal(requests.length, 0)
    assert.equal(await controller.prepare(), null); assert.equal(requests.length, 1)
    assert.equal(controller.getSnapshot().result?.type, 'warning')
    assert.deepEqual(await controller.prepare(true), ready)
    assert.deepEqual(requests, [{ source, format: 'json' }, { source, format: 'json', force: true }])
    assert.equal(saved.get(SOURCE_EXPORT_FORMAT_KEY), 'json')
    controller.setFormat('markdown'); assert.equal(controller.getSnapshot().result, null)
    assert.equal(await controller.prepare(true), null)
    assert.equal(requests.length, 2)
})

test('closing an export ignores a late preparation and never starts a duplicate download', async () => {
    let finish: ((value: Awaited<ReturnType<HapiRemoteApi['sourceExport']>>) => void) | undefined, calls = 0
    const controller = new SourceExportController({ sourceExport: () => { calls++; return new Promise(resolve => { finish = resolve }) } }, source)
    const pending = controller.prepare(); assert.equal(await controller.prepare(), null); assert.equal(calls, 1)
    controller.dispose(); finish!(ok(ready)); assert.equal(await pending, null)
    assert.equal(controller.getSnapshot().result, null)
})

test('preference failure remains visible but does not block this read-only export; old Markdown value is honored', async () => {
    const requests: Parameters<HapiRemoteApi['sourceExport']>[0][] = []
    const controller = new SourceExportController({ sourceExport: async request => { requests.push(request); return ok(ready) } }, source,
        { getItem: () => 'markdown', setItem: () => { throw new Error('device storage full') } })
    assert.equal(controller.getSnapshot().format, 'markdown')
    assert.deepEqual(await controller.prepare(), ready)
    assert.equal(controller.getSnapshot().persistenceError, 'device storage full')
    assert.equal(requests[0]!.format, 'markdown')
})

test('download requests use authenticated source bytes and reject foreign, truncated and cancelled responses', async () => {
    const requests: Array<{ url: string; options: RequestInit | undefined }> = []
    const fetcher: typeof fetch = async (url, options) => { requests.push({ url: String(url), options }); return new Response('{}') }
    const blob = await downloadPreparedSourceExport(ready, 'http://host.test/dsh/', fetcher)
    assert.equal(await blob.text(), '{}')
    assert.deepEqual(requests[0], { url: 'http://host.test/hapi-dsh/source/export/receipt', options: { credentials: 'same-origin', cache: 'no-store', redirect: 'error' } })
    await assert.rejects(downloadPreparedSourceExport({ ...ready, url: 'https://other.test/export' }, 'http://host.test/', fetcher), /authenticated Host/)
    assert.equal(requests.length, 1)
    await assert.rejects(downloadPreparedSourceExport({ ...ready, bytes: 4 }, 'http://host.test/', fetcher), /incomplete/)
    const cancelled = new AbortController(); cancelled.abort()
    await assert.rejects(downloadPreparedSourceExport(ready, 'http://host.test/', fetcher, cancelled.signal), { name: 'AbortError' })
    assert.equal(requests.length, 2)
})
