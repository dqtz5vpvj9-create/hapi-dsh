/** Contract tests for the bounded source-history HTTP fixture.
 * It starts the fixture on loopback; no real Host, production Hub, browser,
 * model, or upstream HAPI process is contacted. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { HapiWireFixture } from './fixtures/hapi-fixture.ts'
import { useBoundedSourceHistory } from './fixtures/source-conversation-fixture.ts'
import { sourceMessageContextSchema, sourceOutlineSchema } from '../src/session-extras-types.ts'
import type { HapiMessage, HapiMessagesPage } from '../src/codex/contracts.ts'

const LONG_TEXT = `Long prompt ${'x'.repeat(300)}`
const BASE = 1_760_000_000_000

function row(id: string, seq: number, at: number, role: 'user' | 'agent', text: string): HapiMessage {
    return { id, localId: `local-${id}`, seq, createdAt: at, invokedAt: at,
        content: { role, content: { type: 'text', text } } }
}
function rows(): HapiMessage[] {
    return [
        row('u1', 1, BASE + 100, 'user', 'User one'),
        row('a1', 2, BASE + 200, 'agent', 'Answer one'),
        row('u2', 3, BASE + 300, 'user', 'User two'),
        row('a2', 4, BASE + 400, 'agent', 'Answer two'),
        row('u3', 5, BASE + 500, 'user', 'User three'),
        row('a3', 6, BASE + 600, 'agent', 'Answer three'),
        row('u4', 7, BASE + 700, 'user', 'User four'),
        row('a4', 8, BASE + 800, 'agent', 'Answer four'),
        row('u5', 9, BASE + 900, 'user', 'User five'),
        row('a5', 10, BASE + 1000, 'agent', 'Answer five'),
        row('long', 11, BASE + 1100, 'user', LONG_TEXT),
        row('a6', 12, BASE + 1200, 'agent', 'Answer six'),
    ]
}
function ids(page: HapiMessagesPage): Array<string | null> { return page.messages.map(value => value.id) }

async function auth(hapi: HapiWireFixture): Promise<string> {
    const response = await fetch(`${hapi.url}/api/auth`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accessToken: hapi.accessToken }) })
    assert.equal(response.status, 200)
    return (await response.json() as { token: string }).token
}
async function get<T>(hapi: HapiWireFixture, token: string, path: string): Promise<{ status: number; body: T }> {
    const response = await fetch(`${hapi.url}${path}`, { headers: { authorization: `Bearer ${token}` } })
    return { status: response.status, body: await response.json() as T }
}

test('source outline is sparse eligible user anchors with bounded cursor and epoch reset', async () => {
    const hapi = new HapiWireFixture()
    const source = hapi.add('window', 'Window fixture', 'machine-alpha')
    source.rows = rows()
    const history = useBoundedSourceHistory(source)
    try {
        await hapi.start()
        const token = await auth(hapi)
        const path = `/api/sessions/${source.session.id}/messages/outline`
        const first = await get<unknown>(hapi, token, `${path}?limit=2`)
        assert.equal(first.status, 200)
        const outline = sourceOutlineSchema.parse(first.body)
        assert.deepEqual(outline.entries.map(entry => entry.messageId), ['long', 'u5'])
        assert.equal(outline.entries[0]!.label.length, 96)
        assert.ok(outline.entries[0]!.label.endsWith('...'))
        assert.ok(LONG_TEXT.length > outline.entries[0]!.label.length)
        assert.equal(outline.page.hasMore, true)
        assert.equal(outline.page.beforeCursor?.seq, 9)
        assert.equal(outline.page.complete, true)
        assert.equal(outline.page.indexing, false)
        assert.equal(outline.page.epoch, 1)

        const second = await get<unknown>(hapi, token,
            `${path}?limit=2&beforeAt=${outline.page.beforeCursor!.at}&beforeSeq=${outline.page.beforeCursor!.seq}&epoch=1`)
        assert.equal(second.status, 200)
        const older = sourceOutlineSchema.parse(second.body)
        assert.deepEqual(older.entries.map(entry => entry.messageId), ['u4', 'u3'])
        assert.equal(older.page.hasMore, true)
        const third = await get<unknown>(hapi, token,
            `${path}?limit=2&beforeAt=${older.page.beforeCursor!.at}&beforeSeq=${older.page.beforeCursor!.seq}&epoch=1`)
        const exhausted = sourceOutlineSchema.parse(third.body)
        assert.deepEqual(exhausted.entries.map(entry => entry.messageId), ['u2', 'u1'])
        assert.equal(exhausted.page.hasMore, false)
        assert.equal(exhausted.page.beforeCursor, null)

        const stale = await get<unknown>(hapi, token, `${path}?limit=2&epoch=0`)
        const reset = sourceOutlineSchema.parse(stale.body)
        assert.deepEqual(reset.entries, [])
        assert.equal(reset.page.reset, true)
        assert.equal(reset.page.hasMore, false)
        assert.equal(reset.page.beforeCursor, null)

        assert.equal((await get<unknown>(hapi, token, `${path}?limit=101`)).status, 400)
        assert.equal((await get<unknown>(hapi, token,
            `${path}?limit=2&beforeAt=${outline.page.beforeCursor!.at}&beforeSeq=${outline.page.beforeCursor!.seq}`)).status, 400)

        history.epoch = 2
        const current = sourceOutlineSchema.parse((await get<unknown>(hapi, token, `${path}?limit=2`)).body)
        assert.equal(current.page.epoch, 2)
        const staleOne = sourceOutlineSchema.parse((await get<unknown>(hapi, token, `${path}?limit=2&epoch=1`)).body)
        assert.equal(staleOne.page.reset, true)
        assert.deepEqual(staleOne.entries, [])
    } finally {
        await hapi.close()
    }
})

test('source message context is radius-bounded with exact cursors, head and epoch reset', async () => {
    const hapi = new HapiWireFixture()
    const source = hapi.add('window', 'Window fixture', 'machine-alpha')
    source.rows = rows()
    useBoundedSourceHistory(source)
    try {
        await hapi.start()
        const token = await auth(hapi)
        const path = `/api/sessions/${source.session.id}/messages/u3/context`
        const first = await get<unknown>(hapi, token, `${path}?radius=2&epoch=1`)
        assert.equal(first.status, 200)
        const context = sourceMessageContextSchema.parse(first.body)
        assert.equal(context.anchor.messageId, 'u3')
        assert.deepEqual(context.messages.map(message => message.id), ['u2', 'a2', 'u3', 'a3', 'u4'])
        assert.equal(context.page.hasMoreBefore, true)
        assert.equal(context.page.hasMoreAfter, true)
        assert.deepEqual(context.page.beforeCursor, { at: BASE + 300, seq: 3 })
        assert.deepEqual(context.page.afterCursor, { at: BASE + 700, seq: 7 })
        assert.deepEqual(context.page.snapshotHead, { at: BASE + 1200, seq: 12 })
        assert.equal(context.page.epoch, 1)
        assert.equal(context.page.reset, false)

        const invalid = await get<unknown>(hapi, token, `${path}?radius=100`)
        assert.equal(invalid.status, 400)

        const stale = await get<unknown>(hapi, token, `${path}?radius=2&epoch=0`)
        assert.equal(stale.status, 200)
        const reset = sourceMessageContextSchema.parse(stale.body)
        assert.equal(reset.page.reset, true)
        assert.deepEqual(reset.messages.map(message => message.id), ['u2', 'a2', 'u3', 'a3', 'u4'])
    } finally {
        await hapi.close()
    }
})

test('bounded messages honor strict before/after/until positions, limit 200 and epoch reset', async () => {
    const hapi = new HapiWireFixture()
    const source = hapi.add('window', 'Window fixture', 'machine-alpha')
    source.rows = rows()
    const history = useBoundedSourceHistory(source)
    try {
        await hapi.start()
        const token = await auth(hapi)
        const path = `/api/sessions/${source.session.id}/messages`
        const after = await get<HapiMessagesPage>(hapi, token,
            `${path}?limit=2&afterAt=${BASE + 300}&afterSeq=3&untilAt=${BASE + 700}&untilSeq=7&epoch=1`)
        assert.equal(after.status, 200)
        assert.equal(after.body.page.direction, 'after')
        assert.deepEqual(ids(after.body), ['a2', 'u3'])
        assert.deepEqual({ at: after.body.page.nextAfterAt, seq: after.body.page.nextAfterSeq }, { at: BASE + 500, seq: 5 })
        assert.deepEqual({ at: after.body.page.snapshotHeadAt, seq: after.body.page.snapshotHeadSeq }, { at: BASE + 700, seq: 7 })
        assert.equal(after.body.page.hasMore, true)

        const next = await get<HapiMessagesPage>(hapi, token,
            `${path}?limit=2&afterAt=${BASE + 500}&afterSeq=5&untilAt=${BASE + 700}&untilSeq=7&epoch=1`)
        assert.deepEqual(ids(next.body), ['a3', 'u4'])
        assert.equal(next.body.page.hasMore, false)
        assert.ok(next.body.messages.every(message => (message.seq ?? 0) > 5 && (message.seq ?? 0) <= 7))

        const before = await get<HapiMessagesPage>(hapi, token,
            `${path}?limit=2&beforeAt=${BASE + 700}&beforeSeq=7&epoch=1`)
        assert.equal(before.body.page.direction, 'before')
        assert.deepEqual(ids(before.body), ['u3', 'a3'])
        assert.deepEqual({ at: before.body.page.nextBeforeAt, seq: before.body.page.nextBeforeSeq },
            { at: BASE + 500, seq: 5 })
        assert.equal(before.body.page.hasMore, true)

        const capped = await get<HapiMessagesPage>(hapi, token, `${path}?limit=999`)
        assert.equal(capped.body.page.limit, 200)
        assert.equal(capped.body.page.direction, 'latest')
        assert.ok(capped.body.messages.length <= 200)
        assert.ok(history.requests.some(request => request.includes('afterAt=')))
        assert.ok(history.requests.some(request => request.includes('untilAt=')))

        history.epoch = 2
        const stale = await get<HapiMessagesPage>(hapi, token,
            `${path}?limit=2&afterAt=${BASE + 300}&afterSeq=3&untilAt=${BASE + 700}&untilSeq=7&epoch=1`)
        assert.equal(stale.body.page.reset, true)
        assert.equal(stale.body.page.direction, 'latest')
        assert.equal(stale.body.page.epoch, 2)
        assert.deepEqual(ids(stale.body), ['long', 'a6'])

        const saved = source.readHistory!
        source.readHistory = () => ({ messages: [], page: { direction: 'latest', limit: 1, epoch: 99, reset: false,
            nextBeforeSeq: null, nextBeforeAt: null, nextAfterSeq: null, nextAfterAt: null,
            snapshotHeadSeq: null, snapshotHeadAt: null, hasMore: false } })
        const override = await get<HapiMessagesPage>(hapi, token, `${path}?limit=1`)
        assert.equal(override.body.page.epoch, 99)
        source.readHistory = saved
    } finally {
        await hapi.close()
    }
})

test('HistoryPaging keeps onPage and also supports after/until and stale epoch reset', async () => {
    const hapi = new HapiWireFixture()
    const source = hapi.add('window', 'Window fixture', 'machine-alpha')
    source.rows = rows().slice(0, 8)
    let pages = 0
    hapi.historyPaging.set(source.session.id, { epoch: 1, pageSize: 3, onPage: () => { pages += 1 } })
    try {
        await hapi.start()
        const token = await auth(hapi)
        const path = `/api/sessions/${source.session.id}/messages`
        const after = await get<HapiMessagesPage>(hapi, token,
            `${path}?limit=2&afterAt=${BASE + 300}&afterSeq=3&untilAt=${BASE + 700}&untilSeq=7&epoch=1`)
        assert.equal(after.status, 200)
        assert.equal(after.body.page.direction, 'after')
        assert.deepEqual(ids(after.body), ['a2', 'u3'])
        assert.equal(after.body.page.hasMore, true)
        assert.equal(pages, 1)

        const stale = await get<HapiMessagesPage>(hapi, token,
            `${path}?limit=2&afterAt=${BASE + 300}&afterSeq=3&epoch=0`)
        assert.equal(stale.body.page.reset, true)
        assert.equal(stale.body.page.direction, 'latest')
        assert.equal(stale.body.page.epoch, 1)
        assert.equal(pages, 2)
    } finally {
        await hapi.close()
    }
})
