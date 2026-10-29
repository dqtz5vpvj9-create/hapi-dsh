import { HistoryProjectionSink } from '../src/shared/projection-event-sink.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionController } from '@deepseek-ai/dsh-api-session-controller'
import type { SessionHistoryRecord } from '@deepseek-ai/dsh-api-session-controller/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { NativeProjector } from '../src/codex/projector.ts'
import type { NativeRow } from '../src/codex/native.ts'
import type { HapiMessage, HapiMessagesPage, HapiTransport } from '../src/codex/contracts.ts'
import {
  DISPLAY_SEQ_OFFSET, DisplayHistoryWindows, SourceHistoryWindow, SourceHistoryWindowError,
  type HistoryWindowAgent, type SourceOutlineReader,
} from '../src/codex/source-window.ts'
import { HapiController } from '../src/index.ts'
import { HAPI_REMOTE } from '../src/client-api.ts'
import {
  SourceAttachmentError, SourceWindowAttachments, collectRecordImageRefs, sourceAttachmentErrorOf,
} from '../src/source-window-attachments.ts'
import {
  SourceAttachmentWireError, decodeSourceAttachmentValue, isAttachmentNotReferenced,
  readSourceAttachmentWithFallback,
} from '../src/source-attachment-types.ts'

/** Temporary state stays under the task's designated data-cache directory. */
const TEST_ROOT = process.env.HAPI_DSH_TEST_ROOT ?? '/mnt/cache/data-cache'
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC', 'base64')

interface App {
  readonly directory: string
  readonly ctx: Context
  readonly store: LocalAttachmentStore
  readonly controller: SessionController
  readonly sessions: Map<string, Session>
  close(): Promise<void>
}

/** Real official AttachmentStore and real SessionController command surface;
 * only the Host services the controller constructor touches are stubbed. */
async function app(): Promise<App> {
  const directory = await mkdtemp(join(TEST_ROOT, 'source-attachment-test-'))
  const ctx = new Context()
  const store = new LocalAttachmentStore(ctx, { dshHome: join(directory, 'official-store') })
  const sessions = new Map<string, Session>()
  ctx.provide('typert', {
    resources: { register() {} },
    lookups: { configure() {} },
    contexts: { configureHost() {} },
  })
  ctx.provide('sessionProjections', { register() {}, onChanged() { return () => {} } })
  ctx.provide('fileUploads', { registerAgentResolver() {} })
  ctx.provide('sessions', { get(id: string) { return sessions.get(id) } })
  const controller = new SessionController(ctx, {})
  return {
    directory, ctx, store, controller, sessions,
    async close() {
      await ctx.fiber.dispose()
      await rm(directory, { recursive: true, force: true })
    },
  }
}

function nativeUserRow(): NativeRow {
  return {
    kind: 'user', key: 'native:thread:turn:item', rowId: 'row-image', localId: 'local-image', seq: 1,
    createdAt: 1000, fingerprint: '', text: 'image', invoked: true, mode: 'queue', parts: [],
    execution: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1' },
  }
}

/** The same real detached NativeProjector path renderHistoryPage uses. */
function detachedHistoryPage(ref: ImageAttachmentRef): SessionHistoryRecord[] {
  const detached = new HistoryProjectionSink()
  const projector = new NativeProjector(detached, {
    model: () => 'fixture', provider: () => 'fixture', submittedMessage: () => undefined,
    content: () => [{ type: 'image', attachment: ref }], stream: () => {}, turnBase: 0,
  })
  projector.apply([nativeUserRow()])
  return detached.events.map(event => ({ type: 'event', event })) as SessionHistoryRecord[]
}

function seedSession(id: string, content: Parameters<typeof createUserMessage>[0]['content']): Session {
  const session = Session.create(SessionId(id))
  session.append('user/message', createUserMessage({ content, source: { kind: 'user' } }), { surfaceOp: 'append' })
  return session
}

function syntheticRef(index: number, options: { name?: string; bytes?: number } = {}): ImageAttachmentRef {
  return {
    attachmentId: `sha256:${index.toString(16).padStart(64, '0')}` as ImageAttachmentRef['attachmentId'],
    mediaType: 'image/png', bytes: options.bytes ?? 16, width: 1, height: 1,
    ...(options.name === undefined ? {} : { name: options.name }),
  }
}

function syntheticRecord(ref: ImageAttachmentRef): SessionHistoryRecord {
  return {
    type: 'event',
    event: {
      type: 'user/message', seq: 0, time: 1,
      data: { content: [{ type: 'image', attachment: ref }], source: { kind: 'user' } },
    },
  } as unknown as SessionHistoryRecord
}

function attachmentDenied(): RemoteError<'session/attachment-invalid'> {
  return new RemoteError('session/attachment-invalid', 'Image is not referenced by this session.',
    { reason: 'ATTACHMENT_NOT_REFERENCED' })
}

test('official in-memory protocol rejects a detached history image that the display log does not reference', async () => {
  const f = await app()
  try {
    const image = await f.store.saveImage({ data: PNG, mediaType: 'image/png', name: 'history.png' })
    const records = detachedHistoryPage(image)
    const refs = collectRecordImageRefs(records)
    assert.equal(refs.length, 1)
    assert.equal(String(refs[0]!.attachmentId), String(image.attachmentId))

    // The real display Session log has no image event. The bytes are already in
    // the official store, exactly as the probe's imported 41e986bf... image.
    const display = seedSession('display-seed', [{ type: 'text', text: 'seed without the history image' }])
    f.sessions.set(String(display.id), display)
    await assert.rejects(
      () => f.controller.attachment({ sessionId: display.id, attachmentId: image.attachmentId }),
      (error: unknown) => {
        assert.ok(error instanceof RemoteError)
        assert.equal(error.code, 'session/attachment-invalid')
        assert.deepEqual(error.details, { reason: 'ATTACHMENT_NOT_REFERENCED' })
        assert.equal(isAttachmentNotReferenced(error), true)
        return true
      },
    )

    // A seed image in the same real log still follows the official path.
    const seedWithImage = seedSession('display-seed-image', [{ type: 'image', attachment: image }])
    f.sessions.set(String(seedWithImage.id), seedWithImage)
    const official = await f.controller.attachment({ sessionId: seedWithImage.id, attachmentId: image.attachmentId })
    const expected = await f.store.readImage(image)
    assert.deepEqual(Buffer.from(official.data, 'base64'), Buffer.from(expected.data))
    assert.equal(official.attachment.attachmentId, image.attachmentId)

    // The bounded source-window index authorizes exactly the page-served ref.
    const grants = new SourceWindowAttachments('hapi-codex-display', 'source-session')
    assert.equal(grants.grant(records, 1), 1)
    const adapted = await grants.read(f.store, String(image.attachmentId), 1)
    assert.deepEqual(Buffer.from(adapted.data), Buffer.from(expected.data))
    assert.equal(adapted.ref.attachmentId, image.attachmentId)
  } finally { await f.close() }
})

test('a different source display cannot read another display grant; an unregistered id is denied', async () => {
  const f = await app()
  try {
    const image = await f.store.saveImage({ data: PNG, mediaType: 'image/png', name: 'one.png' })
    const first = new SourceWindowAttachments('hapi-codex-display-a', 'source-session')
    first.grant(detachedHistoryPage(image), 1)
    const second = new SourceWindowAttachments('hapi-codex-display-b', 'source-session')
    await assert.rejects(
      () => second.read(f.store, String(image.attachmentId), 1),
      (error: unknown) => error instanceof SourceAttachmentError && error.reason === 'ATTACHMENT_NOT_REFERENCED',
    )
    await assert.rejects(
      () => first.read(f.store, 'sha256:0000000000000000000000000000000000000000000000000000000000000000', 1),
      (error: unknown) => error instanceof SourceAttachmentError && error.reason === 'ATTACHMENT_NOT_REFERENCED',
    )
    // The authorized display still reads the real bytes.
    const expected = await f.store.readImage(image)
    assert.deepEqual(Buffer.from((await first.read(f.store, String(image.attachmentId), 1)).data), Buffer.from(expected.data))
  } finally { await f.close() }
})

test('page-body eviction does not revoke a visible grant, but clear and dispose do', async () => {
  const f = await app()
  try {
    const image = await f.store.saveImage({ data: PNG, mediaType: 'image/png', name: 'epoch.png' })
    const id = String(image.attachmentId)

    const grants = new SourceWindowAttachments('hapi-codex-display', 'source-session')
    grants.grant(detachedHistoryPage(image), 7)
    assert.equal(grants.epoch, 7)
    // The server page cache and this index are independent: an empty page or a
    // later page does not remove a still-visible image grant.
    grants.grant([], 7)
    const expected = await f.store.readImage(image)
    assert.deepEqual(Buffer.from((await grants.read(f.store, id, 7)).data), Buffer.from(expected.data))

    // A read request naming a newer epoch denies without mutating the current
    // generation. Only a proved reset/dispose revokes it.
    assert.throws(() => grants.authorize(id, 8), (error: unknown) =>
      error instanceof SourceAttachmentError && error.reason === 'ATTACHMENT_NOT_REFERENCED')
    assert.equal(grants.count, 1)
    assert.equal(grants.epoch, 7)
    assert.equal(grants.revocationReason, undefined)

    // A proved reset revokes the current epoch. A cached page from that epoch
    // cannot re-grant it.
    grants.clear('source-epoch-changed')
    assert.equal(grants.count, 0)
    assert.equal(grants.epoch, 7)
    assert.equal(grants.grant(detachedHistoryPage(image), 7), 0)
    assert.throws(() => grants.authorize(id, 7), (error: unknown) =>
      error instanceof SourceAttachmentError && error.reason === 'ATTACHMENT_NOT_REFERENCED')

    // A genuinely newer epoch may start a new generation; the old one stays
    // revoked.
    assert.equal(grants.grant(detachedHistoryPage(image), 8), 1)
    assert.equal(grants.epoch, 8)
    assert.equal(grants.authorize(id, 8).attachmentId, image.attachmentId)
    assert.deepEqual(Buffer.from((await grants.read(f.store, id, 8)).data), Buffer.from(expected.data))

    grants.dispose('display-retired')
    assert.equal(grants.disposed, true)
    assert.equal(grants.grant(detachedHistoryPage(image), 8), 0)
    await assert.rejects(() => grants.read(f.store, id, 8),
      (error: unknown) => sourceAttachmentErrorOf(error)?.reason === 'ATTACHMENT_WINDOW_CLOSED')
  } finally { await f.close() }
})

test('a late older-epoch page cannot rewind the epoch or clear the current grant', () => {
  const old = syntheticRef(1)
  const current = syntheticRef(2)
  const grants = new SourceWindowAttachments('display', 'source')
  assert.equal(grants.grant([syntheticRecord(old)], 1), 1)
  assert.equal(grants.grant([syntheticRecord(current)], 2), 1)
  // This is the parent repro: a late cached page from epoch 1 must not clear
  // valid epoch-2 refs or make epoch 1 current again.
  assert.equal(grants.grant([syntheticRecord(old)], 1), 0)
  assert.equal(grants.epoch, 2)
  assert.equal(grants.count, 1)
  assert.equal(grants.authorize(String(current.attachmentId), 2).attachmentId, current.attachmentId)
  assert.throws(() => grants.authorize(String(old.attachmentId), 1), (error: unknown) =>
    error instanceof SourceAttachmentError && error.reason === 'ATTACHMENT_NOT_REFERENCED')
  assert.throws(() => grants.authorize(String(current.attachmentId), 1), (error: unknown) =>
    error instanceof SourceAttachmentError && error.reason === 'ATTACHMENT_NOT_REFERENCED')

  // The second parent repro: clear revokes the generation, and the same epoch
  // cannot be re-granted by a cached old page.
  const revoked = new SourceWindowAttachments('display', 'source')
  assert.equal(revoked.grant([syntheticRecord(old)], 1), 1)
  revoked.clear('source-epoch-changed')
  assert.equal(revoked.grant([syntheticRecord(old)], 1), 0)
  assert.throws(() => revoked.authorize(String(old.attachmentId), 1), (error: unknown) =>
    error instanceof SourceAttachmentError && error.reason === 'ATTACHMENT_NOT_REFERENCED')
  assert.equal(revoked.epoch, 1)
  assert.equal(revoked.count, 0)
  assert.equal(revoked.revocationReason, 'source-epoch-changed')
})

test('grant metadata has hard count/byte caps and reclaims the oldest entry', async () => {
  const f = await app()
  try {
    const refs = [syntheticRef(1), syntheticRef(2), syntheticRef(3)]
    const grants = new SourceWindowAttachments('display', 'source', { maxEntries: 2, maxBytes: 10_000 })
    for (const ref of refs) assert.equal(grants.grant([syntheticRecord(ref)], 1), 1)
    assert.equal(grants.count, 2)
    assert.ok(grants.bytes <= grants.maxBytes)
    assert.throws(() => grants.authorize(String(refs[0]!.attachmentId), 1), (error: unknown) =>
      error instanceof SourceAttachmentError && error.reason === 'ATTACHMENT_NOT_REFERENCED')
    assert.equal(grants.authorize(String(refs[1]!.attachmentId), 1).attachmentId, refs[1]!.attachmentId)
    assert.equal(grants.authorize(String(refs[2]!.attachmentId), 1).attachmentId, refs[2]!.attachmentId)

    // One ref larger than the whole metadata budget is never admitted.
    const oversized = syntheticRef(4, { name: 'x'.repeat(900) })
    const tiny = new SourceWindowAttachments('display', 'source', { maxEntries: 8, maxBytes: 256 })
    tiny.grant([syntheticRecord(oversized)], 1)
    assert.equal(tiny.count, 0)
    assert.throws(() => tiny.authorize(String(oversized.attachmentId), 1), (error: unknown) =>
      error instanceof SourceAttachmentError && error.reason === 'ATTACHMENT_NOT_REFERENCED')

    // The owner can trim the metadata index without touching official bytes.
    grants.trimTo(1)
    assert.equal(grants.count, 0)
    assert.equal(grants.bytes, 0)
  } finally { await f.close() }
})

test('dispose during an in-flight store read cannot complete the image response', async () => {
  const stored = await app()
  try {
    const image = await stored.store.saveImage({ data: PNG, mediaType: 'image/png', name: 'slow.png' })
    const grants = new SourceWindowAttachments('display', 'source')
    grants.grant(detachedHistoryPage(image), 1)
    let releaseStarted: () => void = () => {}
    let releaseRead: () => void = () => {}
    const started = new Promise<void>(resolve => { releaseStarted = resolve })
    const gate = new Promise<void>(resolve => { releaseRead = resolve })
    const slow: AttachmentStore = {
      imageLimits: stored.store.imageLimits,
      readImage: async (ref: ImageAttachmentRef) => {
        releaseStarted()
        await gate
        return { ref, data: (await stored.store.readImage(ref)).data }
      },
    } as unknown as AttachmentStore
    const pending = grants.read(slow, String(image.attachmentId), 1)
    await started
    grants.dispose('pane-closed')
    releaseRead()
    await assert.rejects(pending, (error: unknown) =>
      error instanceof SourceAttachmentError && error.reason === 'ATTACHMENT_WINDOW_CLOSED')
  } finally { await stored.close() }
})

test('a new epoch during an in-flight read revokes the old grant', async () => {
  const stored = await app()
  try {
    const image = await stored.store.saveImage({ data: PNG, mediaType: 'image/png', name: 'epoch-flight.png' })
    const grants = new SourceWindowAttachments('display', 'source')
    grants.grant(detachedHistoryPage(image), 1)
    let releaseStarted: () => void = () => {}
    let releaseRead: () => void = () => {}
    const started = new Promise<void>(resolve => { releaseStarted = resolve })
    const gate = new Promise<void>(resolve => { releaseRead = resolve })
    const slow: AttachmentStore = {
      imageLimits: stored.store.imageLimits,
      readImage: async (ref: ImageAttachmentRef) => {
        releaseStarted()
        await gate
        return { ref, data: (await stored.store.readImage(ref)).data }
      },
    } as unknown as AttachmentStore
    const pending = grants.read(slow, String(image.attachmentId), 1)
    await started
    const current = syntheticRef(2)
    assert.equal(grants.grant([syntheticRecord(current)], 2), 1)
    releaseRead()
    await assert.rejects(pending, (error: unknown) =>
      error instanceof SourceAttachmentError && error.reason === 'ATTACHMENT_NOT_REFERENCED')
    assert.equal(grants.epoch, 2)
    assert.equal(grants.authorize(String(current.attachmentId), 2).attachmentId, current.attachmentId)
    assert.throws(() => grants.authorize(String(image.attachmentId), 1), (error: unknown) =>
      error instanceof SourceAttachmentError && error.reason === 'ATTACHMENT_NOT_REFERENCED')
  } finally { await stored.close() }
})

test('store corruption and mismatched bytes propagate as store errors, never as a broader grant', async () => {
  const f = await app()
  try {
    const image = await f.store.saveImage({ data: PNG, mediaType: 'image/png', name: 'corrupt.png' })
    const grants = new SourceWindowAttachments('display', 'source')
    grants.grant(detachedHistoryPage(image), 1)
    const id = String(image.attachmentId)
    const failing = {
      imageLimits: f.store.imageLimits,
      readImage: async () => { throw new Error('fixture store integrity failure') },
    } as unknown as AttachmentStore
    await assert.rejects(() => grants.read(failing, id, 1), /fixture store integrity failure/)

    const wrongRef = {
      imageLimits: f.store.imageLimits,
      readImage: async () => ({ ref: syntheticRef(9), data: new Uint8Array(16) }),
    } as unknown as AttachmentStore
    await assert.rejects(() => grants.read(wrongRef, id, 1), (error: unknown) =>
      error instanceof SourceAttachmentError && error.reason === 'ATTACHMENT_INVALID')

    const shortBytes = {
      imageLimits: f.store.imageLimits,
      readImage: async (ref: ImageAttachmentRef) => ({ ref, data: new Uint8Array(Math.max(0, ref.bytes - 1)) }),
    } as unknown as AttachmentStore
    await assert.rejects(() => grants.read(shortBytes, id, 1), (error: unknown) =>
      error instanceof SourceAttachmentError && error.reason === 'ATTACHMENT_INVALID')
  } finally { await f.close() }
})

test('official-first fallback uses the source adapter only for ATTACHMENT_NOT_REFERENCED and keeps every other result', async () => {
  const ok = { ok: true as const, value: { attachment: syntheticRef(1), data: new Uint8Array([1, 2, 3]) } }
  const denied = { ok: false as const, error: attachmentDenied() }
  const corrupt = {
    ok: false as const,
    error: new RemoteError('session/attachment-invalid', 'Image bytes are corrupt.', { reason: 'ATTACHMENT_CORRUPT' }),
  }
  let calls = 0
  const source = async () => { calls += 1; return ok }

  assert.equal(await readSourceAttachmentWithFallback(async () => ok, source), ok)
  assert.equal(calls, 0)

  assert.equal(await readSourceAttachmentWithFallback(async () => denied, source), ok)
  assert.equal(calls, 1)

  assert.equal(await readSourceAttachmentWithFallback(async () => corrupt, source), corrupt)
  assert.equal(calls, 1)

  const throwing = async () => { throw new Error('adapter unavailable') }
  assert.equal(await readSourceAttachmentWithFallback(async () => denied, throwing), denied)
  assert.equal(await readSourceAttachmentWithFallback(async () => denied, async () => undefined), denied)
  assert.equal(await readSourceAttachmentWithFallback(async () => denied, async () => corrupt), denied)
})

test('adapter wire decoding verifies canonical base64 and the durable byte length', () => {
  const ref = syntheticRef(1, { bytes: 3 })
  const decoded = decodeSourceAttachmentValue({ attachment: ref, data: Buffer.from([1, 2, 3]).toString('base64') })
  assert.deepEqual(decoded.data, new Uint8Array([1, 2, 3]))
  assert.equal(decoded.attachment.attachmentId, ref.attachmentId)
  assert.throws(() => decodeSourceAttachmentValue({ attachment: syntheticRef(1, { bytes: 2 }), data: Buffer.from([1]).toString('base64') }),
    SourceAttachmentWireError)
  assert.throws(() => decodeSourceAttachmentValue({ attachment: ref, data: '!!!!' }), SourceAttachmentWireError)
  assert.throws(() => decodeSourceAttachmentValue({ attachment: ref, data: 'AQID\n' }), SourceAttachmentWireError)
  assert.throws(() => decodeSourceAttachmentValue({ attachment: syntheticRef(1, { bytes: 1 }), data: 'AR==' }), SourceAttachmentWireError)
  assert.throws(() => decodeSourceAttachmentValue({ attachment: syntheticRef(1, { bytes: 1 }), data: 'AQ' }), SourceAttachmentWireError)
  assert.throws(() => decodeSourceAttachmentValue({ attachment: { ...ref, mediaType: 'text/html' }, data: 'AAAA' }),
    SourceAttachmentWireError)
})

const DISPLAY_A = 'hapi-codex-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const DISPLAY_B = 'hapi-codex-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

/** Controlled source transport with the real window, detached projector and RPC method. */
function sourceFixture(ref: ImageAttachmentRef, displayId = DISPLAY_A) {
  const row: HapiMessage = {
    id: 'history-image', localId: 'history-image', seq: 1, createdAt: 1000, invokedAt: 1000,
    content: { role: 'user', content: { type: 'text', text: 'history image' } },
  }
  const cursor = { at: 1000, seq: 1 }
  const state = { epoch: 1, sourceEpoch: 1, historyVersion: 0, reset: false, reads: 0 }
  const agent: HistoryWindowAgent = {
    id: SessionId(displayId), binding: { hapiSessionId: 'fixture-source' },
    sourceHistoryVersion: () => state.historyVersion,
    historyWindowAnchor: () => ({ epoch: state.epoch, before: { at: 2000, seq: 2 }, firstTurn: 10,
      hasOlder: true, oldest: { id: 'seed', at: 2000, seq: 2 } }),
    renderHistoryPage: async () => ({
      events: detachedHistoryPage(ref).map(record => record.event as unknown as SessionEvent),
      eventSources: new Map(detachedHistoryPage(ref).map(record => [record.event.seq,
        { messageId: row.id, at: row.createdAt, seq: row.seq!, itemKey: row.id, turnKey: 'turn-1' }])),
      lastTurn: 1, sources: new Map(), rewinds: new Map(), forks: new Map(),
    }),
  }
  const transport = {
    readMessages: async (): Promise<HapiMessagesPage> => {
      state.reads++
      return { messages: [row], page: { direction: 'before', epoch: state.sourceEpoch, reset: state.reset,
        limit: 200, hasMore: false, nextBeforeAt: cursor.at, nextBeforeSeq: cursor.seq,
        nextAfterAt: cursor.at, nextAfterSeq: cursor.seq, snapshotHeadAt: 2000, snapshotHeadSeq: 2 } }
    },
  } as unknown as HapiTransport
  const outline: SourceOutlineReader = async () => ({ entries: [], page: {
    epoch: state.sourceEpoch, reset: state.reset, hasMore: false, beforeCursor: null,
  } })
  const context = async () => { state.reads++; return { messages: [row], page: { beforeCursor: cursor, afterCursor: cursor,
    hasMoreBefore: false, hasMoreAfter: false, epoch: state.sourceEpoch, reset: state.reset } } }
  const contiguous = async () => ({ messages: [row], hasMore: false, next: cursor,
    epoch: state.sourceEpoch, reset: state.reset })
  const request = { address: { kind: 'session' as const, sessionId: agent.id }, throughSeq: DISPLAY_SEQ_OFFSET,
    beforeSeq: DISPLAY_SEQ_OFFSET, maxMessages: 20 }
  const ordinary = async (): Promise<never> => { throw new Error('ordinary page is unused') }
  return { row, cursor, state, agent, transport, outline, context, contiguous, request, ordinary }
}

test('real source windows grant only served frames, retain no page bodies and revoke on retirement', async () => {
  const f = await app()
  try {
    const image = await f.store.saveImage({ data: PNG, mediaType: 'image/png' })
    const fixture = sourceFixture(image)
    const registry = new DisplayHistoryWindows()
    const window = registry.window(DISPLAY_A, fixture.agent, fixture.transport)
    const other = sourceFixture(image, DISPLAY_B)
    const otherWindow = registry.window(DISPLAY_B, other.agent, other.transport)
    const id = String(image.attachmentId)
    assert.equal(window.attachments.count, 0)
    const page = await window.windowAt('history-image', 1, 0, fixture.context)
    assert.equal(collectRecordImageRefs(page.frames.map(frame => ({ type: 'event' as const, event: frame.event as unknown as SessionHistoryRecord['event'] }))).length, 1)
    assert.equal((await window.attachments.read(f.store, id, window.epoch)).ref.attachmentId, image.attachmentId)
    await assert.rejects(() => otherWindow.attachments.read(f.store, id, otherWindow.epoch),
      (error: unknown) => sourceAttachmentErrorOf(error)?.reason === 'ATTACHMENT_NOT_REFERENCED')

    window.attachments.trimTo(0)
    await window.windowAt('history-image', 1, 0, fixture.context)
    assert.equal(fixture.state.reads, 2, 'a source page is request-local and re-grants only the newly served references')
    assert.equal(window.attachments.count, 1)
    assert.equal(window.cacheBytes, 0)
    assert.ok(window.attachmentBytes > 0)
    assert.equal(window.retainedBytes, window.attachmentBytes)
    await window.attachments.read(f.store, id, window.epoch)
    registry.retire(DISPLAY_A)
    assert.equal(registry.peek(DISPLAY_A), undefined)
    assert.equal(window.attachmentBytes, 0)
    await assert.rejects(() => window.attachments.read(f.store, id, window.epoch),
      (error: unknown) => sourceAttachmentErrorOf(error)?.reason === 'ATTACHMENT_WINDOW_CLOSED')
    registry.clear()
  } finally { await f.close() }
})

test('source snapshot changes revoke old image grants without closing the display owner', async () => {
  const image = syntheticRef(1)
  for (const route of ['context', 'before', 'after', 'outline', 'agent'] as const) {
    const fixture = sourceFixture(image)
    const window = new SourceHistoryWindow(fixture.agent, fixture.transport,
      undefined, route === 'outline' ? fixture.outline : undefined)
    if (route === 'outline') window.attachments.grant(detachedHistoryPage(image), 1)
    else await window.windowAt('history-image', 1, 3_000_000_000, fixture.context)
    assert.equal(window.attachments.authorize(String(image.attachmentId), 1).attachmentId, image.attachmentId)
    fixture.state.sourceEpoch = 2
    if (route === 'agent') {
      fixture.state.epoch = 2
      assert.equal(window.epoch, 2, 'a source snapshot revision advances independently of the display owner')
    } else {
      const read = route === 'context' ? () => window.windowAt('history-image', 1, 3_000_000_000, fixture.context)
        : route === 'before' ? () => window.windowBefore(fixture.cursor, 3_000_000_000, fixture.contiguous)
        : route === 'after' ? () => window.windowAfter(fixture.cursor, 3_000_000_000, fixture.contiguous)
        : () => window.canonicalOutline()
      if (route === 'context' || route === 'outline') await read()
      else await assert.rejects(read, SourceHistoryWindowError)
    }
    assert.equal(window.attachments.disposed, false, route)
    assert.equal(window.attachments.grant(detachedHistoryPage(image), 1), 0, route)
    assert.throws(() => window.attachments.authorize(String(image.attachmentId), 1),
      (error: unknown) => sourceAttachmentErrorOf(error)?.reason === 'ATTACHMENT_NOT_REFERENCED', route)
    if (route === 'context') assert.equal(window.attachments.authorize(String(image.attachmentId), 2).attachmentId, image.attachmentId)
  }
})

test('a direct page read before the seed anchor exists keeps the page source epoch', async () => {
  const image = syntheticRef(1)
  const fixture = sourceFixture(image)
  const anchor = fixture.agent.historyWindowAnchor.bind(fixture.agent)
  let bound = false
  fixture.agent.historyWindowAnchor = () => bound ? anchor() : undefined
  const window = new SourceHistoryWindow(fixture.agent, fixture.transport)
  await window.windowAt('history-image', 1, 3_000_000_000, fixture.context)
  assert.equal(window.attachments.epoch, 1)
  fixture.state.epoch = 2
  bound = true
  assert.throws(() => window.attachments.authorize(String(image.attachmentId), window.epoch),
    (error: unknown) => sourceAttachmentErrorOf(error)?.reason === 'ATTACHMENT_NOT_REFERENCED')
})

test('a late reset from an older source snapshot cannot revoke the current page image grant', async () => {
  const image = syntheticRef(1)
  const fixture = sourceFixture(image)
  const window = new SourceHistoryWindow(fixture.agent, fixture.transport)
  await window.windowAt('history-image', 1, 3_000_000_000, fixture.context)
  let release!: (page: Awaited<ReturnType<typeof fixture.contiguous>>) => void
  let requested!: () => void
  const started = new Promise<void>(resolve => { requested = resolve })
  const oldPage = new Promise<Awaited<ReturnType<typeof fixture.contiguous>>>(resolve => { release = resolve })
  const reading = window.windowBefore(fixture.cursor, 3_000_000_000, async () => { requested(); return oldPage }, 1)
  const rejected = assert.rejects(reading, SourceHistoryWindowError)
  await started
  fixture.state.sourceEpoch = 3
  await window.windowAt('history-image', 1, 3_000_000_000, fixture.context)
  release({ messages: [fixture.row], hasMore: false, next: fixture.cursor, epoch: 2, reset: true })
  await rejected
  assert.equal(window.epoch, 3)
  assert.equal(window.attachments.authorize(String(image.attachmentId), 3).attachmentId, image.attachmentId)
  assert.equal(window.attachments.disposed, false)
  window.dispose()
})

/** Runs the actual registered method without starting a Host or network server. */
function controllerFixture(registry: DisplayHistoryWindows, store: AttachmentStore, fixture: ReturnType<typeof sourceFixture>) {
  const controller = Object.create(HapiController.prototype) as HapiController
  Object.defineProperties(controller, {
    ctx: { value: { attachments: store } },
    options: { value: { historyWindows: registry, client: fixture.transport } },
    requireHistoryWindow: { value: () => registry.peek(DISPLAY_A) },
    sourceAgent: { value: () => fixture.agent },
    workbenchSource: { value: () => ({ sourceSessionId: 'fixture-source', sourceHubId: 'fixture-hub', machineId: 'fixture-machine' }) },
  })
  return controller
}

test('registered attachment RPC keeps the display grant boundary through its request and response codecs', async () => {
  const f = await app()
  try {
    const image = await f.store.saveImage({ data: PNG, mediaType: 'image/png' })
    const fixture = sourceFixture(image)
    const registry = new DisplayHistoryWindows()
    const window = registry.window(DISPLAY_A, fixture.agent, fixture.transport)
    await window.windowAt('history-image', 1, 3_000_000_000, fixture.context)
    const other = sourceFixture(image, DISPLAY_B)
    registry.window(DISPLAY_B, other.agent, other.transport)
    const controller = controllerFixture(registry, f.store, fixture)
    const descriptor = HAPI_REMOTE.descriptors.find(row => row.method === 'sourceHistoryAttachment')!
    assert.ok(descriptor)
    const inputCodec = descriptor.parameters[0]!.codec!
    const outputCodec = descriptor.result!
    assert.equal(inputCodec.mode, 'strict')
    assert.equal(outputCodec.mode, 'strict')
    assert.ok('create' in inputCodec && 'create' in outputCodec)
    const input = inputCodec.create() as { parse(value: unknown): { sessionId: string; attachmentId: string } }
    const output = outputCodec.create() as { parse(value: unknown): unknown }
    const request = input.parse({ sessionId: DISPLAY_A, attachmentId: String(image.attachmentId) })
    const response = output.parse(await controller.sourceHistoryAttachment(request))
    const decoded = decodeSourceAttachmentValue(response)
    assert.deepEqual(Buffer.from(decoded.data), Buffer.from((await f.store.readImage(image)).data))
    assert.throws(() => input.parse({ ...request, epoch: 2 }), 'callers cannot select a different source epoch')
    for (const sessionId of ['ordinary-session', DISPLAY_B, `hapi-codex-${'c'.repeat(32)}`, `${DISPLAY_A}-child-${'d'.repeat(24)}`]) {
      await assert.rejects(() => controller.sourceHistoryAttachment({ ...request, sessionId }),
        (error: unknown) => error instanceof RemoteError && error.code === 'hapi/request' && error.details.status === 404)
    }
    assert.equal(registry.size, 2, 'attachment reads cannot create windows')
    await assert.rejects(() => controller.sourceHistoryAttachment({ ...request, attachmentId: String(syntheticRef(9).attachmentId) }),
      (error: unknown) => error instanceof RemoteError && error.code === 'hapi/request'
        && error.details.sourceCode === 'attachment_not_referenced')
    registry.retire(DISPLAY_A)
    await assert.rejects(() => controller.sourceHistoryAttachment(request),
      (error: unknown) => error instanceof RemoteError && error.code === 'hapi/request' && error.details.status === 404)
    registry.clear()
  } finally { await f.close() }
})

test('real source RPC page callbacks deliver reset evidence to the window before rejecting', async () => {
  for (const route of [{ fromOldest: true }, { beforeAt: 2000, beforeSeq: 2 }, { afterAt: 1000, afterSeq: 1 }]) {
    const image = syntheticRef(1)
    const fixture = sourceFixture(image)
    const registry = new DisplayHistoryWindows()
    const window = registry.window(DISPLAY_A, fixture.agent, fixture.transport)
    await window.windowAt('history-image', 1, 3_000_000_000, fixture.context)
    const controller = controllerFixture(registry, {} as AttachmentStore, fixture)
    fixture.state.sourceEpoch = 2
    await assert.rejects(() => controller.sourceHistoryWindowPage({ sessionId: DISPLAY_A, ...route }), SourceHistoryWindowError)
    assert.equal(window.attachments.count, 0, JSON.stringify(route))
    assert.equal(window.attachments.disposed, false, 'a rejected stale page does not close the display owner')
    assert.equal(fixture.state.reads, 2, 'one context read grants the image, one stale page read revokes it')
    registry.clear()
  }
})

test('independent source head reads revoke image grants when they observe a reset or new epoch', async () => {
  for (const change of [{ sourceEpoch: 2 }, { reset: true }]) {
    const image = syntheticRef(1)
    const fixture = sourceFixture(image)
    const registry = new DisplayHistoryWindows()
    const window = registry.window(DISPLAY_A, fixture.agent, fixture.transport, fixture.outline)
    await window.windowAt('history-image', 1, 3_000_000_000, fixture.context)
    const controller = controllerFixture(registry, {} as AttachmentStore, fixture)
    Object.assign(fixture.state, change)
    await controller.sourceHistoryHead({ sessionId: DISPLAY_A })
    assert.equal(window.attachments.count, 0)
    assert.equal(window.attachments.disposed, false)
    assert.throws(() => window.attachments.authorize(String(image.attachmentId), 1),
      (error: unknown) => sourceAttachmentErrorOf(error)?.reason === 'ATTACHMENT_NOT_REFERENCED')
    registry.clear()
  }
})


test('same-epoch history rewrite revokes old attachments and permits only newly served frames', async () => {
  const image = syntheticRef(1), fixture = sourceFixture(image)
  const window = new SourceHistoryWindow(fixture.agent, fixture.transport)
  const page = await window.windowAt('history-image', 1, 0, fixture.context)
  const oldGrants = window.attachments
  assert.equal(oldGrants.authorize(String(image.attachmentId), 1).attachmentId, image.attachmentId)
  fixture.state.historyVersion++
  window.grantSourceFrames([], fixture.state.historyVersion)
  assert.equal(oldGrants.disposed, true)
  assert.throws(() => window.attachments.authorize(String(image.attachmentId), 1), SourceAttachmentError)
  window.grantSourceFrames(page.frames, 0)
  assert.equal(window.attachments.count, 0, 'a delayed pre-rewrite feed cannot re-grant')
  await window.windowAt('history-image', 1, 0, fixture.context)
  assert.equal(window.attachments.authorize(String(image.attachmentId), 1).attachmentId, image.attachmentId)
  window.dispose()
})

test('same-epoch rewrite rejects each in-flight page before old content can be granted', async () => {
  for (const route of ['context', 'before', 'after'] as const) {
    const image = syntheticRef(1), fixture = sourceFixture(image)
    const window = new SourceHistoryWindow(fixture.agent, fixture.transport)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const read = route === 'context'
      ? window.windowAt('history-image', 1, 0, async () => { await gate; return fixture.context() })
      : route === 'before'
        ? window.windowBefore(fixture.cursor, 0, async () => { await gate; return fixture.contiguous() })
        : window.windowAfter(fixture.cursor, 0, async () => { await gate; return fixture.contiguous() })
    const rejected = assert.rejects(read, /source history changed while reading/)
    fixture.state.historyVersion++
    release()
    await rejected
    assert.equal(window.attachments.count, 0, route)
    window.dispose()
  }
})

test('same-epoch rewrite during pure projection rejects its old rendered result', async () => {
  const image = syntheticRef(1), fixture = sourceFixture(image)
  const render = fixture.agent.renderHistoryPage.bind(fixture.agent)
  let release!: () => void, started!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const entered = new Promise<void>(resolve => { started = resolve })
  fixture.agent.renderHistoryPage = async rows => { started(); await gate; return render(rows) }
  const window = new SourceHistoryWindow(fixture.agent, fixture.transport)
  const read = window.windowAt('history-image', 1, 0, fixture.context)
  const rejected = assert.rejects(read, /source history changed while reading/)
  await entered
  fixture.state.historyVersion++
  release()
  await rejected
  assert.equal(window.attachments.count, 0)
  window.dispose()
})


test('a pre-rewrite outline cannot republish old same-epoch labels after a new scan', async () => {
  const fixture = sourceFixture(syntheticRef(1))
  let release!: (page: Awaited<ReturnType<typeof fixture.outline>>) => void
  const oldPage = new Promise<Awaited<ReturnType<typeof fixture.outline>>>(resolve => { release = resolve })
  let reads = 0
  const outline: SourceOutlineReader = async () => ++reads === 1 ? oldPage : { entries: [{ messageId: 'new-label', label: 'current', at: 2000, seq: 2, createdAt: 2000 }],
    page: { epoch: 1, hasMore: false, beforeCursor: null, complete: true } }
  const window = new SourceHistoryWindow(fixture.agent, fixture.transport, undefined, outline)
  const stale = window.canonicalOutline()
  const rejected = assert.rejects(stale, /source history changed while reading/)
  fixture.state.historyVersion++
  const fresh = await window.canonicalOutline()
  assert.deepEqual(fresh?.entries.map(row => row.messageId), ['new-label'])
  release({ entries: [{ messageId: 'deleted-label', label: 'old', at: 1000, seq: 1, createdAt: 1000 }],
    page: { epoch: 1, hasMore: false, beforeCursor: null, complete: true } })
  await rejected
  assert.deepEqual((await window.canonicalOutline())?.entries.map(row => row.messageId), ['new-label'])
  window.dispose()
})


test('parent image RPC rejects a same-epoch rewrite during byte reading without any live subscriber', async () => {
  const f = await app()
  try {
    const image = await f.store.saveImage({ data: PNG, mediaType: 'image/png' })
    const fixture = sourceFixture(image), registry = new DisplayHistoryWindows()
    const window = registry.window(DISPLAY_A, fixture.agent, fixture.transport)
    await window.windowAt('history-image', 1, 0, fixture.context)
    let release!: () => void, started!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const entered = new Promise<void>(resolve => { started = resolve })
    const slow = { imageLimits: f.store.imageLimits, readImage: async (ref: ImageAttachmentRef) => {
      started(); await gate; return f.store.readImage(ref)
    } } as unknown as AttachmentStore
    const controller = controllerFixture(registry, slow, fixture)
    const read = controller.sourceHistoryAttachment({ sessionId: DISPLAY_A, attachmentId: String(image.attachmentId) })
    const rejected = assert.rejects(read, (error: unknown) => error instanceof RemoteError
      && error.details?.sourceCode === 'attachment_not_referenced')
    await entered
    fixture.state.historyVersion++
    release()
    await rejected
    registry.clear()
  } finally { await f.close() }
})
