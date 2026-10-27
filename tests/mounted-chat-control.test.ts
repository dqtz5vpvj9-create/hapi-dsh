import assert from 'node:assert/strict';
import test from 'node:test';
import type { Context } from '@deepseek-ai/cordis';
import {
    installPaneMountedChatConsumer, MOUNTED_CHAT_ATTRIBUTE, publishPaneMountedChat,
    requestOlderThroughMountedChat, resetMountedChatRegistrations, resolveMountedChatForPane,
    resolveMountedChatLatestForPane, toLatestThroughMountedChat,
    type MountedChatConsumerV1, type MountedChatControlV1,
} from '../src/client/mounted-chat-control.ts';

function control(older: () => Promise<void> = async () => {}): MountedChatControlV1 {
    return {
        version: 1,
        read: () => ({ revision: 1, anchor: null, following: true, hasOlder: true, busy: false }),
        subscribe: () => () => {},
        loadOlder: older,
        reveal: async () => {},
        toLatest: async () => {},
    };
}

function pane() {
    const dataset: Record<string, string | undefined> = {};
    return { dataset };
}

/** Minimal element whose closest() walks a fixed ancestry list. */
function element(ancestry: Array<{ dataset?: Record<string, string | undefined> }>) {
    return { closest: (selector: string) => ancestry.find(node => selector.includes(MOUNTED_CHAT_ATTRIBUTE) && node.dataset?.[MOUNTED_CHAT_ATTRIBUTE] !== undefined) ?? null };
}

function fakeContext() {
    const provided: Array<{ name: string; value: unknown }> = [];
    let unprovided = 0;
    const ctx = {
        reflect: {
            provide(name: string, value: unknown) {
                provided.push({ name, value });
                return () => { unprovided += 1; };
            },
        },
    } as unknown as Context;
    return { ctx, provided, unprovided: () => unprovided };
}

test('a mounted control is published under its own Pane and resolved from content inside it', () => {
    resetMountedChatRegistrations();
    const first = pane(), second = pane();
    const firstControl = control(), secondControl = control();
    publishPaneMountedChat(first, firstControl);
    publishPaneMountedChat(second, secondControl);
    assert.equal(first.dataset[MOUNTED_CHAT_ATTRIBUTE] !== undefined, true);
    assert.equal(resolveMountedChatForPane(element([first])), firstControl);
    assert.equal(resolveMountedChatForPane(element([second])), secondControl);
    assert.equal(resolveMountedChatForPane(element([])), undefined, 'content outside a registered Pane resolves nothing');
    // Unmounting one Pane must not clear the other Pane's control.
    publishPaneMountedChat(first, null);
    assert.equal(resolveMountedChatForPane(element([second])), secondControl);
    assert.equal(resolveMountedChatForPane(element([first])), undefined);
    assert.equal(first.dataset[MOUNTED_CHAT_ATTRIBUTE], undefined);
});

test('each Pane graph provides its own consumer and disposal stays scoped', () => {
    resetMountedChatRegistrations();
    const first = fakeContext(), second = fakeContext();
    const firstPane = pane(), secondPane = pane();
    const firstDispose = installPaneMountedChatConsumer(first.ctx, firstPane);
    const secondDispose = installPaneMountedChatConsumer(second.ctx, secondPane);
    assert.equal(first.provided[0]!.name, 'mountedChatConsumer');
    const firstConsumer = first.provided[0]!.value as MountedChatConsumerV1;
    const secondConsumer = second.provided[0]!.value as MountedChatConsumerV1;
    const firstControl = control(), secondControl = control();
    firstConsumer.onMountedChat?.(firstControl);
    secondConsumer.onMountedChat?.(secondControl);
    assert.equal(resolveMountedChatForPane(element([firstPane])), firstControl);
    assert.equal(resolveMountedChatForPane(element([secondPane])), secondControl);
    firstDispose();
    assert.equal(first.unprovided(), 1, 'only the disposed Pane unprovides its service');
    assert.equal(resolveMountedChatForPane(element([secondPane])), secondControl, 'the other Pane keeps its control');
    secondDispose();
    assert.equal(resolveMountedChatForPane(element([secondPane])), undefined);
});

test('a programmatic older request drives the pane control and reports fallback', async () => {
    const signals: AbortSignal[] = [];
    const signal = new AbortController().signal;
    assert.equal(await requestOlderThroughMountedChat(control(async () => { signals.push(signal) }), signal), true);
    assert.equal(signals.length, 1);
    assert.equal(await requestOlderThroughMountedChat(control(async () => { throw new Error('TARGET_UNAVAILABLE') }), signal), false,
        'a refused control page must fall back to the official DOM control');
    assert.equal(await requestOlderThroughMountedChat(undefined, signal), false,
        'no control keeps the official DOM path');
});

test('the pane consumer can fetch the newest source window for toLatest', async () => {
    resetMountedChatRegistrations();
    const fake = fakeContext();
    const target = pane();
    const calls: Array<{ sessionId: string; signal: AbortSignal }> = [];
    installPaneMountedChatConsumer(fake.ctx, target, async (sessionId, signal) => { calls.push({ sessionId, signal }) });
    const consumer = fake.provided[0]!.value as MountedChatConsumerV1;
    assert.equal(typeof consumer.readLatest, 'function', 'toLatest needs a source fetch on this consumer');
    const signal = new AbortController().signal;
    await consumer.readLatest?.('session-a', signal);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.sessionId, 'session-a');
    assert.equal(calls[0]!.signal, signal);
});

test('a tail landing prefers the pane control and falls back when unavailable', async () => {
    const signal = new AbortController().signal;
    let landed = 0;
    const accepting = { ...control(), toLatest: async () => { landed += 1 } };
    assert.equal(await toLatestThroughMountedChat(accepting, signal), true);
    assert.equal(landed, 1, 'the mounted control commits the tail landing');
    const failing = { ...control(), toLatest: async () => { throw new Error('TARGET_UNAVAILABLE') } };
    assert.equal(await toLatestThroughMountedChat(failing, signal), false, 'a refused control falls back to the source path');
    assert.equal(await toLatestThroughMountedChat(undefined, signal), false, 'no control keeps the source path');
});

test('toLatest is offered only when the consumer can fetch the newest source window', () => {
    resetMountedChatRegistrations();
    const withLatest = fakeContext(), withoutLatest = fakeContext();
    const firstPane = pane(), secondPane = pane();
    installPaneMountedChatConsumer(withLatest.ctx, firstPane, async () => {});
    installPaneMountedChatConsumer(withoutLatest.ctx, secondPane);
    const first = withLatest.provided[0]!.value as MountedChatConsumerV1;
    const second = withoutLatest.provided[0]!.value as MountedChatConsumerV1;
    const firstControl = control(), secondControl = control();
    first.onMountedChat?.(firstControl);
    second.onMountedChat?.(secondControl);
    assert.equal(resolveMountedChatForPane(element([firstPane])), firstControl, 'paging can use any mounted control');
    assert.equal(resolveMountedChatForPane(element([secondPane])), secondControl);
    assert.equal(resolveMountedChatLatestForPane(element([firstPane])), firstControl, 'a consumer with readLatest may land the tail');
    assert.equal(resolveMountedChatLatestForPane(element([secondPane])), undefined,
        'without readLatest the stale retained window must not be reported as the tail');
});
