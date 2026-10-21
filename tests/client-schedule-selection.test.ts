import test from 'node:test';
import assert from 'node:assert/strict';
import { persistSchedule, readScheduleSelection, resolveSchedule, scheduleError } from '../src/client/schedule-selection.ts';

test('a saved relative preset remains relative until the actual send, including after reload', () => {
    const selection = readScheduleSelection(JSON.parse(JSON.stringify({ type: 'preset', preset: '+30m' })));
    assert.equal(resolveSchedule(selection, 1000000), 2800000);
    assert.equal(resolveSchedule(selection, 1000000 + 10 * 60_000), 3400000);
    assert.equal(resolveSchedule({ type: 'absolute', ms: 2300000 }, 2000000), 2300000);
});
test('minute precision keeps the original 30-second grace and rejects invalid or distant times', () => {
    const now = 1800000;
    assert.equal(scheduleError(now - 30000, now), null);
    assert.equal(scheduleError(now - 30001, now), 'past');
    assert.equal(scheduleError(now + 7 * 86400_000, now), null);
    assert.equal(scheduleError(now + 7 * 86400_000 + 1, now), 'too-far');
    assert.equal(scheduleError(NaN, now), 'invalid');
    assert.equal(scheduleError(1.5, now), 'invalid');
});
test('older saved absolute drafts are preserved rather than converted to a new relative task', () => {
    const date = '2026-10-21T13:35';
    assert.deepEqual(readScheduleSelection(undefined, date), { type: 'absolute', ms: new Date(date).getTime() });
    assert.deepEqual(readScheduleSelection({ type: 'preset', preset: '+99h' }), { type: 'preset', preset: '+5m' });
});
test('submission persistence verifies readback and fails closed for disabled, full or discarding storage', () => {
    const request = { operationId: 'same-stable-request', text: 'do once', scheduledAt: 4000000 };
    assert.equal(persistSchedule(undefined, 'key', request), false);
    assert.equal(persistSchedule({ getItem: () => null, setItem: () => { throw new Error('Quota'); } }, 'key', request), false);
    assert.equal(persistSchedule({ getItem: () => null, setItem: () => {} }, 'key', request), false);
    const data = new Map<string, string>();
    assert.equal(persistSchedule({ getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); } }, 'key', request), true);
    assert.deepEqual(JSON.parse(data.get('key')!), request);
});
