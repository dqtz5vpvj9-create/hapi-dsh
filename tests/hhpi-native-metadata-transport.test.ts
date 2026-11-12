/** Actual helper process boundary; no native execution or production source. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { nativeMetadata } from '../src/remote/codex-metadata.ts';
import type { DirectCodexConfig } from '../src/remote/protocol.ts';

const source: DirectCodexConfig = { id: 'source', machineId: 'fixture', engine: 'codex' };

test('source helper batches precise lifecycle absence and preserves unfamiliar rollout layouts', async () => {
    const { NativeMetadataReader } = await import('../src/remote/codex-metadata.ts');
    const { DatabaseSync } = await import('node:sqlite');
    const { mkdir } = await import('node:fs/promises');
    const { join, resolve } = await import('node:path');
    const home = await mkdtemp('/mnt/cache/data-cache/hhpi-lifecycle-channel-');
    const db = new DatabaseSync(join(home, 'state_5.sqlite')); db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY)'); db.close();
    const createdAt = 1794351600, clock = (createdAt * 1000).toString(16).padStart(12, '0');
    const threadId = `${clock.slice(0, 8)}-${clock.slice(8)}-7000-8000-000000000001`;
    const reader = new NativeMetadataReader({ ...source, historyMetadata: { command: process.execPath, args: [resolve('src/remote/codex-metadata-helper.mjs')] } });
    const request = { kind: 'lifecycle' as const, home, candidates: [{ threadId, createdAt }] };
    try {
        assert.deepEqual(await reader.lifecycles(request, new AbortController().signal), { absent: [threadId] });
        await mkdir(join(home, 'archived_sessions', 'unfamiliar-nested-layout'), { recursive: true });
        assert.deepEqual(await reader.lifecycles(request, new AbortController().signal), { absent: [] }, 'unknown layouts cannot authorize omission');
    } finally { await reader.dispose(); await rm(home, { recursive: true, force: true }); }
});

test('an unavailable native index is a history-capability failure, never an access revocation', async () => {
    const home = await mkdtemp('/mnt/cache/data-cache/hhpi-missing-metadata-');
    try {
        await assert.rejects(nativeMetadata(source, { home, threadId: 'thread', limit: 20 }, new AbortController().signal),
            { code: 'HISTORY_UNAVAILABLE' }, 'accepted browser history must not be purged as UNSUPPORTED permission revocation');
    } finally { await rm(home, { recursive: true, force: true }); }
});

test('cancelling an explicit source read terminates a nonresponsive metadata helper without touching execution', async () => {
    const stop = new AbortController();
    const pending = nativeMetadata({ ...source, historyMetadata: { command: process.execPath,
        args: ['-e', 'process.stdin.resume(); setInterval(() => {}, 1000)'] } },
        { home: '/synthetic', threadId: 'thread', limit: 20 }, stop.signal);
    const reason = new DOMException('Reader left this page', 'AbortError');
    stop.abort(reason);
    await assert.rejects(pending, error => error === reason);
});

// This helper models only the private process protocol. Native SQLite and
// native ordinal behavior are exercised by hhpi-bounded-native-open.test.ts.
test('second/third metadata pages share one source process and cancelling one reader preserves another', async () => {
    const { writeFile, readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { NativeMetadataReader } = await import('../src/remote/codex-metadata.ts');
    const home = await mkdtemp('/mnt/cache/data-cache/hhpi-shared-metadata-'), script = join(home, 'helper.mjs'), counter = join(home, 'starts');
    await writeFile(script, `import {appendFileSync} from 'node:fs';import {createInterface} from 'node:readline';
appendFileSync(${JSON.stringify(counter)},'start\\n');
const value={items:[],turns:[],hasBefore:false,hasAfter:false,coordinates:'fixture',first:null,last:null};let held;
for await(const line of createInterface({input:process.stdin})){
 const message=JSON.parse(line);if(message.request.threadId==='hold'){held=message.id;continue;}
 process.stdout.write(JSON.stringify({id:message.id,result:value})+'\\n');
 if(held){process.stdout.write(JSON.stringify({id:held,result:value})+'\\n');held=undefined;}
}`);
    const reader = new NativeMetadataReader({ ...source, historyMetadata: { command: process.execPath, args: [script] } });
    const request = { home: '/synthetic', threadId: 'normal', limit: 20 };
    try {
        reader.warm();
        for (let i = 0; i < 3; i++) await reader.read(request, new AbortController().signal);
        const cancelled = new AbortController();
        const held = reader.read({ ...request, threadId: 'hold' }, cancelled.signal);
        const other = reader.read(request, new AbortController().signal);
        cancelled.abort(new DOMException('Reader closed', 'AbortError'));
        await assert.rejects(held, { name: 'AbortError' });
        assert.equal((await other).coordinates, 'fixture');
        await reader.read(request, new AbortController().signal);
        assert.equal((await readFile(counter, 'utf8')).trim().split('\n').length, 1, 'metadata requests and Panes never create another SSH/helper process');
    } finally { await reader.dispose(); await reader.dispose(); await rm(home, { recursive: true, force: true }); }
});

test('an operational deadline retires a hung metadata channel and the next read opens a fresh source process', async () => {
    const { writeFile, readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { NativeMetadataReader } = await import('../src/remote/codex-metadata.ts');
    const home = await mkdtemp('/mnt/cache/data-cache/hhpi-metadata-timeout-'), script = join(home, 'helper.mjs'), counter = join(home, 'starts');
    await writeFile(script, `import {appendFileSync} from 'node:fs';import {createInterface} from 'node:readline';
appendFileSync(${JSON.stringify(counter)},'start\\n');
for await(const line of createInterface({input:process.stdin})){
 const message=JSON.parse(line);if(message.request.threadId==='hang')continue;
 process.stdout.write(JSON.stringify({id:message.id,result:{items:[],turns:[],hasBefore:false,hasAfter:false,coordinates:'recovered',first:null,last:null}})+'\\n');
}`);
    const reader = new NativeMetadataReader({ ...source, historyMetadata: { command: process.execPath, args: [script] } }, 1000);
    const request = { home: '/synthetic', threadId: 'normal', limit: 20 };
    try {
        await reader.read(request, new AbortController().signal);
        await assert.rejects(reader.read({ ...request, threadId: 'hang' }, new AbortController().signal), { code: 'HISTORY_UNAVAILABLE' });
        assert.equal((await reader.read(request, new AbortController().signal)).coordinates, 'recovered');
        assert.equal((await readFile(counter, 'utf8')).trim().split('\n').length, 2);
    } finally { await reader.dispose(); await rm(home, { recursive: true, force: true }); }
});
