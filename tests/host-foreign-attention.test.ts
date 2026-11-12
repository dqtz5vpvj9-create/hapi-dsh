/** Production observers/journals. Pairing inventory and authenticated transport are explicit boundaries. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { ForeignSourceNotifications, type ForeignAttentionMachine, type ForeignAttentionSource } from '../src/workspace/foreign-attention.ts';
import { SourceAttentionAggregateJournal, SourceNotificationObserver } from '../src/workspace/notification-events.ts';
import type { AppNotification } from '../src/notification-types.ts';
const scope = { accountId: 'synthetic-account', origin: 'https://workspace.fixture' };
const source: ForeignAttentionSource = { id: 'native-dsh', machineId: 'runner', engine: 'dsh', routeKind: 'federated-dsh' };
async function until(predicate: () => boolean): Promise<void> {
    for (let step = 0; step < 40 && !predicate(); step++) await new Promise<void>(resolve => setImmediate(resolve));
    assert.ok(predicate(), 'Expected asynchronous observation did not occur');
}
test('a paired Runner publishes unseen tasks without a Pane and unpairing stops subsequent notifications', async t => {
    const lifetime = new AbortController(), feed = new SourceAttentionAggregateJournal(lifetime.signal), notifications: AppNotification[] = [];
    const observer = new SourceNotificationObserver(async (_context, notification) => { notifications.push(notification); });
    let machines: ForeignAttentionMachine[] = [{ id: 'runner', online: true, generation: 'one', connectedAt: 1 }], changed = () => {};
    const states = new Map<string, string>();
    let authorized = true, catalogCalls = 0;
    const manager = new ForeignSourceNotifications({ context: { scope, authorizeSource: route => {
        assert.equal(route.hostId, 'runner'); if (!authorized) throw new Error('Revoked');
    } }, observer, status(key, state) { if (state) states.set(key, state); else states.delete(key); }, catalog: {
        machines: () => machines, subscribe(callback) { changed = callback; return () => { changed = () => {}; }; },
        async listSources() { catalogCalls++; return [source]; }, feed: () => feed,
    } });
    t.after(async () => { await manager.close(); lifetime.abort(); await observer.close(); });
    await until(() => [...states.values()].includes('watching'));
    const publish = (id: string) => feed.publish('never-opened', { id, kind: 'completed', createdAt: Date.now(), position: { kind: 'dsh', seq: 42 } });
    publish('completed'); await until(() => notifications.length === 1);
    assert.deepEqual(notifications[0]?.target.source, { kind: 'federated-dsh', hostId: 'runner', sessionId: 'never-opened' });
    changed(); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(catalogCalls, 1);
    authorized = false; publish('revoked'); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(notifications.length, 1);
    machines = []; changed(); authorized = true; publish('unpaired');
    await until(() => states.size === 0); assert.equal(notifications.length, 1);
});

test('a delayed catalog from an old connection cannot attach a source after the Runner is replaced', async t => {
    const lifetime = new AbortController(), feed = new SourceAttentionAggregateJournal(lifetime.signal), observer = new SourceNotificationObserver(async () => {});
    let machines: ForeignAttentionMachine[] = [{ id: 'runner', online: true, generation: 'old', connectedAt: 1 }], changed = () => {};
    const first = Promise.withResolvers<readonly ForeignAttentionSource[]>(), admitted: string[] = [];
    let calls = 0;
    const manager = new ForeignSourceNotifications({ context: { scope, authorizeSource() {} }, observer, status() {}, catalog: {
        machines: () => machines, subscribe(callback) { changed = callback; return () => {}; },
        listSources() { return ++calls === 1 ? first.promise : Promise.resolve([{ ...source, id: 'replacement' }]); },
        feed(_host, selected) { admitted.push(selected.id); return feed; },
    } });
    t.after(async () => { await manager.close(); lifetime.abort(); await observer.close(); });
    machines = [{ id: 'runner', online: true, generation: 'new', connectedAt: 2 }]; changed();
    first.resolve([{ ...source, id: 'stale' }]);
    await until(() => admitted.length > 0); assert.deepEqual(admitted, ['replacement']);
});
