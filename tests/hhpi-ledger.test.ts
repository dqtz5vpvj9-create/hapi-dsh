import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OperationLedger, CreationLedger } from '../src/remote/operation-ledger.ts';
import { SourceError } from '../src/remote/errors.ts';
import { sourceSessionId, parseSourceSessionId, type SourceOperation, type SourceReceipt, type SourceSession } from '../src/remote/protocol.ts';
import { parseSources } from '../src/remote/config.ts';
import { operationSchema, readSchema } from '../src/hhpi-api.ts';

const identity = { machineId: 'synthetic', sourceId: 'codex', engine: 'codex', nativeId: 'native:thread/%' };
const operation: SourceOperation = { sessionId: sourceSessionId(identity), operationId: 'one-write', kind: 'send', text: 'synthetic private prompt not stored in receipts' };
const accepted: SourceReceipt = { sessionId: operation.sessionId, operationId: operation.operationId, status: 'accepted', message: 'Native engine acknowledged.' };
async function directory(run: (path: string) => Promise<void>): Promise<void> {
    const path = await mkdtemp(join(tmpdir(), 'hhpi-ledger-')); try { await run(path); } finally { await rm(path, { recursive: true, force: true }); }
}
test('concurrent duplicate writes and a restarted ledger invoke the source exactly once', () => directory(async path => {
    let calls = 0; const gate = Promise.withResolvers<void>();
    const execute = async (): Promise<SourceReceipt> => { calls++; await gate.promise; return accepted; };
    const ledger = new OperationLedger(path);
    const a = ledger.run(operation, execute), b = ledger.run(operation, execute);
    assert.equal(a, b); gate.resolve(); assert.deepEqual(await a, accepted);
    assert.deepEqual(await new OperationLedger(path).run(operation, execute), accepted); assert.equal(calls, 1);
    const contents = await Promise.all((await readdir(path)).filter(name => name.endsWith('.json')).map(name => readFile(join(path, name), 'utf8')));
    assert.ok(contents.length > 0); assert.ok(contents.every(text => !text.includes(operation.text!)), 'receipts do not preserve raw prompt bodies');
}));
test('two independent ledger owners serialize the same source write', () => directory(async path => {
    let calls = 0;
    const execute = async (): Promise<SourceReceipt> => { calls++; return accepted; };
    const [a,b] = await Promise.all([new OperationLedger(path).run(operation, execute), new OperationLedger(path).run(operation, execute)]);
    assert.deepEqual(a,b); assert.equal(calls, 1);
}));
test('lost acknowledgement remains indeterminate after restart and is never resent', () => directory(async path => {
    let calls = 0;
    const uncertain = await new OperationLedger(path).run(operation, async () => { calls++; throw new SourceError('OUTCOME_UNKNOWN', 'Synthetic connection loss'); });
    assert.equal(uncertain.status, 'indeterminate');
    assert.deepEqual(await new OperationLedger(path).run(operation, async () => { calls++; return accepted; }), uncertain);
    assert.equal(calls, 1);
}));
test('a durable pre-dispatch uncertainty marker prevents replay after a process crash', () => directory(async path => {
    const gate = Promise.withResolvers<void>(); const entered = Promise.withResolvers<void>();
    const pending = new OperationLedger(path).run(operation, async () => { entered.resolve(); await gate.promise; return accepted; });
    await entered.promise;
    const files = (await readdir(path)).filter(name => name.endsWith('.json'));
    assert.equal(files.length,1);
    const journal = JSON.parse(await readFile(join(path, files[0]!), 'utf8')) as { receipt: SourceReceipt };
    assert.equal(journal.receipt.status, 'indeterminate');
    gate.resolve(); await pending;
    // Restore the exact durable marker representing termination before final acknowledgement persistence.
    await writeFile(join(path, files[0]!), JSON.stringify(journal));
    let calls = 0;
    const recovered = await new OperationLedger(path).run(operation, async () => { calls++; return accepted; });
    assert.equal(recovered.status, 'indeterminate'); assert.equal(calls, 0);
}));
test('operation identity collisions reject changed payloads without dispatch', () => directory(async path => {
    const ledger = new OperationLedger(path); await ledger.run(operation, async () => accepted);
    await assert.rejects(ledger.run({ ...operation, text: 'changed' }, async () => { throw new Error('must not execute'); }), { code: 'INVALID_REQUEST' });
}));
test('foreign acknowledgements preserve uncertainty and malformed receipts fail closed', () => directory(async path => {
    const ledger = new OperationLedger(path);
    await assert.rejects(ledger.run(operation, async () => ({ ...accepted, sessionId: 'another-session' })), { code: 'OUTCOME_UNKNOWN' });
    assert.equal((await ledger.run(operation, async () => accepted)).status, 'indeterminate');
    const file = (await readdir(path)).find(name => name.endsWith('.json'))!;
    await writeFile(join(path,file), '{bad');
    await assert.rejects(new OperationLedger(path).run(operation, async () => accepted), { code: 'TARGET_UNAVAILABLE' });
}));
test('native creation is deduplicated across owners and source scope separates equal request IDs', () => directory(async path => {
    const request = { sourceId: 'codex', operationId: 'create', cwd: '/synthetic' };
    const session = { ...identity, id: operation.sessionId } as SourceSession;
    let calls = 0;
    const run = async () => { calls++; return { sourceId: 'codex', operationId: 'create', status: 'accepted' as const, message: 'created', session }; };
    const a = await new CreationLedger(path,'machine-a').run(request,run);
    assert.deepEqual(await new CreationLedger(path,'machine-a').run(request,run),a); assert.equal(calls,1);
    await new CreationLedger(path,'machine-b').run(request,run); assert.equal(calls,2);
}));
test('source identities and private configuration reject aliases and unauthenticated network endpoints', () => {
    assert.deepEqual(parseSourceSessionId(sourceSessionId(identity)),identity);
    assert.notEqual(sourceSessionId(identity),sourceSessionId({...identity,machineId:'other'}));
    assert.throws(()=>parseSourceSessionId('hhpi:synthetic:codex:codex:native%3athread%2f%25'));
    assert.throws(()=>parseSources([{id:'c',machineId:'m',engine:'codex',endpoint:'ws://example.com:1234'}]));
    assert.throws(()=>parseSources([{id:'c',machineId:'m',engine:'codex',endpoint:'ws://127.0.0.1:1234?token=synthetic'}]));
    assert.throws(()=>parseSources([{id:'c',machineId:'m',engine:'codex',cwd:'relative'}]));
    assert.throws(()=>parseSources([{id:'c',machineId:'m',engine:'codex'},{id:'c',machineId:'n',engine:'codex'}]));
    assert.equal(parseSources([{id:'c',machineId:'m',engine:'codex',endpoint:'ws://127.0.0.1:1234'}]).length,1);
    assert.equal(readSchema.safeParse({sessionId:operation.sessionId,before:1,after:2}).success,false);
    assert.equal(operationSchema.safeParse({...operation,execute:'arbitrary'}).success,false);
});
