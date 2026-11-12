import test from 'node:test'
import assert from 'node:assert/strict'
import { HostBootQueue, preferredSourceBootHost } from '../src/client/surface/host-boot-queue.ts'
const tick = () => new Promise(resolve => setTimeout(resolve, 10))

test('foreground plugin graph initializes before background hosts without overlap', async () => {
    const order: string[] = []
    let release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    const queue = new HostBootQueue(() => 'foreground')
    queue.add('background', async () => { order.push('background') })
    queue.add('foreground', async () => { order.push('foreground'); await blocked })
    await tick()
    assert.deepEqual(order, ['foreground'])
    release(); await tick()
    assert.deepEqual(order, ['foreground', 'background'])
    queue.dispose()
})

test('disposing a queued Host never starts its graph', async () => {
    let starts = 0
    const queue = new HostBootQueue(() => undefined)
    queue.add('host', async () => { starts++ }); queue.dispose()
    await tick(); assert.equal(starts, 0)
})

test('local conversation paint precedes background graph work; selecting another Host bypasses the wait', async () => {
    let selected = 'local', pending = true
    const order: string[] = []
    const queue = new HostBootQueue(() => selected, () => pending)
    queue.add('remote', async () => { order.push('remote') })
    await tick(); assert.deepEqual(order, [])
    selected = 'remote'; queue.prioritize()
    await new Promise(resolve => setTimeout(resolve, 70))
    assert.deepEqual(order, ['remote'])
    pending = false; queue.dispose()
})


test('a newly focused Host bypasses an already loading background Host', async () => {
    const order: string[] = []
    let focus: string | undefined, release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    const queue = new HostBootQueue(() => focus)
    queue.add('slow', async () => { order.push('slow'); await blocked })
    await tick()
    queue.add('selected', async () => { order.push('selected') })
    focus = 'selected'; queue.prioritize()
    await tick(); assert.deepEqual(order, ['slow', 'selected'])
    release(); queue.dispose()
})

test('a saved local canonical prioritizes its paired online original before the shadow finishes opening', async () => {
    const address = { hostId: 'local', sessionId: 'hhpi:original:codex:codex:thread' };
    const paired = [{ id: 'other', online: true }, { id: 'original', online: true }];
    const order: string[] = [];
    const queue = new HostBootQueue(() => preferredSourceBootHost(address, paired), () => true);
    queue.add('other', async () => { order.push('other') });
    queue.add('original', async () => { order.push('original') });
    await tick();
    assert.deepEqual(order, ['original'], 'foreground pending cannot defer the actual origin as a background catalog');
    queue.dispose();
    assert.equal(preferredSourceBootHost(address, [{ id: 'original', online: false }]), 'local');
    assert.equal(preferredSourceBootHost(address, []), 'local');
    assert.equal(preferredSourceBootHost({ hostId: 'explicit', sessionId: address.sessionId }, paired), 'explicit');
    assert.equal(preferredSourceBootHost({ hostId: 'local', sessionId: 'hhpi:malformed' }, paired), 'local');
});
