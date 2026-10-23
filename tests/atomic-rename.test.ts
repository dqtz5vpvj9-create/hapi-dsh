import assert from 'node:assert/strict';
import test from 'node:test';
import { replacePrivateFile } from '../src/shared/atomic-rename.ts';

test('Windows retries a sharing violation with the same complete rename source', async () => {
    const calls: unknown[] = [];
    await replacePrivateFile('complete.tmp', 'credentials.json', async (from, to) => {
        calls.push([from, to]);
        if (calls.length === 1) throw Object.assign(new Error('sharing violation'), { code: 'EPERM' });
    }, 'win32');
    assert.deepEqual(calls, [['complete.tmp', 'credentials.json'], ['complete.tmp', 'credentials.json']]);
});

test('permanent rename failures and Unix errors remain errors', async () => {
    for (const [platform, code] of [['win32', 'ENOENT'], ['linux', 'EPERM']] as const) {
        let calls = 0;
        await assert.rejects(replacePrivateFile('complete.tmp', 'credentials.json', async () => {
            calls++;
            throw Object.assign(new Error('fixture failure'), { code });
        }, platform), { code });
        assert.equal(calls, 1);
    }
});
