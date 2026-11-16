/** Client routing; source ownership contracts live in Remote packages/native-runtime. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { RemoteStreamHandle } from '@deepseek-ai/dsh-typert-protocol';
import type { TerminalRemote } from '@deepseek-ai/dsh-api-terminal-controller/client';
import type { TerminalFrame, TerminalInput, WebTerminalId } from '@deepseek-ai/dsh-api-terminal-controller/types';
import { sourceSessionId } from '../src/remote/protocol.ts';
import { sourceTerminalRemote } from '../src/client/source-terminal-provider.ts';
import type {} from '../src/client-api.ts';
const session = { id: sourceSessionId({ machineId: 'source-machine', sourceId: 'source-terminal-fixture', engine: 'codex', nativeId: 'thread-one' }) };
const terminalId = 'source-shell' as WebTerminalId;

test('client routing preserves exact stream handles, uses the ordinary provider for DSH and never falls back', async () => {
    const calls: string[] = [], handle: RemoteStreamHandle<TerminalFrame, TerminalInput> = {
        async *[Symbol.asyncIterator]() {}, send() {}, end() {}, dispose() {},
    };
    const api = (kind: string): TerminalRemote => ({
        environment: async () => { calls.push(`${kind}:environment`); throw new Error('offline'); },
        shells: async () => { calls.push(`${kind}:shells`); throw new Error('offline'); },
        list: async () => { calls.push(`${kind}:list`); return { ok: true, value: [] }; },
        create: async () => { calls.push(`${kind}:create`); throw new Error('offline'); },
        retain: () => { calls.push(`${kind}:retain`); return handle as RemoteStreamHandle<never, never>; },
        attach: () => { calls.push(`${kind}:attach`); return handle; },
        rename: async () => { calls.push(`${kind}:rename`); return { ok: true, value: undefined }; },
        close: async () => { calls.push(`${kind}:close`); return { ok: true, value: undefined }; },
    });
    const remote = sourceTerminalRemote(api('ordinary'), api('source'));
    assert.equal(remote.attach(SessionId(session.id), terminalId), handle);
    await remote.list(SessionId('dsh-session'));
    await assert.rejects(remote.environment(SessionId(session.id)), /offline/);
    assert.deepEqual(calls, ['source:attach', 'ordinary:list', 'source:environment']);
});
