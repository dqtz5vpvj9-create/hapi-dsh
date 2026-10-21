import assert from 'node:assert/strict';
import test from 'node:test';
import { randomId } from '../src/client/random-id.ts';

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
  assert.equal(randomId({
    randomUUID: () => 'native-id',
    getRandomValues: <T extends ArrayBufferView>(array: T): T => array,
  }), 'native-id');
});
