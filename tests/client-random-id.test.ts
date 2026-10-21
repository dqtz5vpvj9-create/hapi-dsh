import assert from 'node:assert/strict';
import test from 'node:test';
import { randomId } from '../src/client/random-id.ts';
import { webcrypto } from 'node:crypto';
import { initialWorkspace, WorkspaceStore } from '../src/client/model.ts';

test('randomId falls back to getRandomValues when randomUUID is unavailable', () => {
  const source = {
    getRandomValues: <T extends ArrayBufferView>(array: T): T => {
      new Uint8Array(array.buffer, array.byteOffset, array.byteLength).fill(0xab);
      return array;
    },
  };
  const id = randomId(source);
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('randomId keeps the native implementation when available', () => {
  const source = {
    randomUUID() { assert.equal(this, source); return 'native-id'; },
    getRandomValues() { throw new Error('The native method should be used'); },
  };
  assert.equal(randomId(source), 'native-id');
});

test('HTTP-compatible UUIDs use secure bytes and preserve UUID v4 version and variant bits', () => {
    let calls = 0;
    const source = {
        getRandomValues(bytes: Uint8Array) {
            assert.equal(this, source); assert.equal(bytes.length, 16); calls++;
            bytes.set(Array.from({ length: 16 }, (_, index) => index * 17)); return bytes;
        },
    } as unknown as Crypto;
    assert.equal(randomId(source), '00112233-4455-4677-8899-aabbccddeeff');
    assert.equal(calls, 1);
    for (const fill of [0, 255]) {
        const value = randomId({ getRandomValues: (bytes: Uint8Array) => bytes.fill(fill) } as unknown as Crypto);
        assert.match(value, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
});

test('UUID generation fails visibly when secure random bytes are unavailable', () => {
    assert.throws(() => randomId({} as Crypto), /Secure random generation is unavailable/);
    assert.throws(() => randomId({ getRandomValues() { throw new Error('Secure source denied'); } } as unknown as Crypto), /Secure source denied/);
});

test('real workspace defaults remain usable when the browser exposes only getRandomValues', () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    try {
        Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) } });
        const workspace = new WorkspaceStore(initialWorkspace(randomId));
        workspace.createWindow(); workspace.split('horizontal');
        const windowIds = workspace.getSnapshot().windows.map(window => window.id);
        assert.equal(new Set(windowIds).size, 2);
        assert.ok(windowIds.every(id => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)));
    } finally {
        if (previous) Object.defineProperty(globalThis, 'crypto', previous);
        else Reflect.deleteProperty(globalThis, 'crypto');
    }
});
