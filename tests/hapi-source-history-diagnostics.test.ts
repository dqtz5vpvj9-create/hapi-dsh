/** Synthetic source exports only; no actual user transcript or credentials. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { diagnoseSourceHistory, DiagnosticInputError } from '../scripts/source-history-diagnostics.ts'
import { diagnoseNativePages } from '../scripts/native-page-diagnostics.ts'
import { nativeIndexedHistory } from '../e2e/source-conversation-fixture.ts'
import type { HapiMessage, HapiMessagesPage } from '../src/codex/contracts.ts'

const canary = 'PRIVATE_CANARY_diagnostic_97df9e6a', unknownKey = 'PRIVATE_FIELD_527891'
function exported() {
    return { schemaVersion: 2, exportedAt: 123,
        session: { id: `${canary}-session`, namespace: `${canary}-namespace`, seq: 1, createdAt: 1, updatedAt: 2,
            active: true, activeAt: 2, thinking: false, thinkingAt: 2, metadataVersion: 1, agentStateVersion: 1,
            metadata: { path: `/${canary}`, host: canary, name: canary, flavor: 'codex', codexNativeSession: true,
                codexSessionId: `${canary}-thread`, machineId: `${canary}-machine`, [unknownKey]: canary }, agentState: null },
        messages: nativeIndexedHistory(`${canary}-thread`, 2, 2),
        scratchlist: [{ entryId: canary, text: canary, createdAt: 1, updatedAt: 1,
            attachments: [{ id: canary, filename: canary, mimeType: canary, size: 1, path: `/${canary}` }] }],
        [unknownKey]: canary,
    }
}

function nativeCapture() {
    const input = exported(), head = input.messages.at(-1)!
    const response = (messages: HapiMessage[], direction: 'latest' | 'before', hasMore: boolean): HapiMessagesPage => ({ messages,
        page: { direction, limit: 3, epoch: 77, reset: false,
            nextBeforeAt: messages[0]!.invokedAt!, nextBeforeSeq: messages[0]!.seq!,
            nextAfterAt: messages.at(-1)!.invokedAt!, nextAfterSeq: messages.at(-1)!.seq!,
            snapshotHeadAt: head.invokedAt!, snapshotHeadSeq: head.seq! + 9998, hasMore } })
    const pages = [response(input.messages.slice(3), 'latest', true), response(input.messages.slice(0, 3), 'before', false)]
    // Real Hub overlay: appended after the native window and excluded from
    // its cursors/limit. Deliberately older createdAt to expose bad sorting.
    pages[0]!.messages.push({ ...input.messages[0]!, id: `${canary}-pending`, seq: null, localId: `${canary}-pending`,
        invokedAt: null, createdAt: 1, content: { role: 'user', content: { type: 'text', text: canary } } })
    return { session: input.session, pages, requests: queriesFor(pages) }
}
function queriesFor(pages: HapiMessagesPage[]) {
    return pages.map((response, index) => index === 0 ? { limit: String(response.page.limit), bounded: 'true' }
        : { limit: String(response.page.limit), bounded: 'true', beforeAt: pages[index - 1]!.page.nextBeforeAt!,
            beforeSeq: pages[index - 1]!.page.nextBeforeSeq!, epoch: pages[index - 1]!.page.epoch })
}

test('offline diagnostics use real v2 envelope and reveal only finite categories and counts', () => {
    const input = exported(), copy = structuredClone(input), json = JSON.stringify(input, null, 2)
    const report = diagnoseSourceHistory(json), output = JSON.stringify(report)
    assert.equal(output.includes(canary), false); assert.equal(output.includes(unknownKey), false)
    assert.deepEqual(input, copy)
    assert.equal(report.inputSchema, 'hapi-session-export-v2')
    assert.equal(report.rows.valid, 6); assert.equal(report.rows.invalid, 0)
    assert.equal(report.roles.user, 2); assert.equal(report.roles.agent, 4)
    assert.equal(report.native.candidates.userDisplayable, 2); assert.equal(report.native.candidates.assistantDurable, 4)
    assert.equal(report.observed.root.userDisplayable, 2); assert.equal(report.observed.root.assistantDurable, 4)
    assert.equal(report.identities.localIdEqualsBodyId, 4)
    assert.equal(report.execution.outer, 6); assert.equal(report.execution.withTurnLifecycle, 6)
    assert.equal(report.bytes.json, Buffer.byteLength(json))
    assert.equal(report.bytes.largestPhysicalLine, Math.max(...json.split('\n').map(line => Buffer.byteLength(line))))
    assert.equal(report.bytes.largestMessage, Math.max(...input.messages.map(row => Buffer.byteLength(JSON.stringify(row)))))
    assert.equal(report.coverage, 'hub-export-store-snapshot')
    assert.ok(report.limitations.includes('native-rpc-history-completeness-unproven'))
})

test('native parser outcomes separate missing turn, uncommitted snapshot, foreign thread and malformed rows', () => {
    const input = exported(), first = input.messages[1]!
    input.messages = [structuredClone(first), structuredClone(first), structuredClone(first)]
    input.messages[0]!.localId = null
    const noTurn = input.messages[1]!
    noTurn.content = { role: 'agent', content: { type: 'codex', data: { type: 'message', id: noTurn.localId, message: canary } } }
    const foreign = input.messages[2]!
    foreign.content = { role: 'agent', meta: { nativeExecution: { threadId: `${canary}-foreign`, turnId: canary } },
        content: { type: 'codex', data: { type: 'message', id: foreign.localId, message: canary } } }
    const live = { ...first, id: `${canary}-live`, content: { role: 'agent',
        meta: { nativeExecution: { threadId: `${canary}-thread`, turnId: canary } },
        content: { type: 'codex', data: { type: 'message', id: first.localId, message: canary, live: true } } } }
    const pending = { ...first, id: `${canary}-pending`, invokedAt: null,
        content: { role: 'user', content: { type: 'text', text: canary } } }
    const json = JSON.stringify({ ...input, messages: [...input.messages, live, pending, { [unknownKey]: canary },
        { ...first, content: { role: canary, content: { type: canary, data: { type: canary, [unknownKey]: canary } } } }] })
    const report = diagnoseSourceHistory(json), output = JSON.stringify(report)
    assert.equal(report.reasons.nativeAssistantWithoutDurableIdentity, 1)
    assert.equal(report.reasons.nativeAssistantExplicitlyLive, 1)
    assert.equal(report.reasons.nativeUninvokedUser, 1)
    assert.equal(report.native.candidates.userPending, 1)
    assert.equal(report.reasons.nativeContentWithoutTurn, 1)
    assert.equal(report.reasons.nativeThreadMismatch, 1)
    assert.equal(report.reasons.invalidMessageSchema, 1)
    assert.equal(report.roles.other, 1); assert.equal(report.contentTypes.other, 1); assert.equal(report.payloadTypes.other, 1)
    assert.equal(output.includes(canary), false); assert.equal(output.includes(unknownKey), false)
})

test('legacy SQLite session activeAt null or missing follows the original export schema', () => {
    for (const activeAt of [null, undefined]) {
        const input = exported(), json = JSON.stringify({ ...input, session: { ...input.session, activeAt } })
        const report = diagnoseSourceHistory(json)
        assert.equal(report.rows.valid, 6)
        assert.equal(report.native.candidates.userDisplayable, 2)
        assert.equal(JSON.stringify(report).includes(canary), false)
    }
})

test('unknown wrappers or source error details never become diagnostic raw JSON', () => {
    const input = exported(), first = input.messages[0]!, wrapped = [
        first.content, { message: first.content }, { data: { message: first.content } }, { payload: { message: first.content } },
        { [unknownKey]: first.content },
    ]
    input.messages = wrapped.map((content, index) => ({ ...first, id: `${canary}-${index}`, content }))
    input.messages.push({ ...first, id: `${canary}-error`, content: { role: 'agent', content: { type: 'event',
        data: { type: 'error', message: canary, details: canary, [unknownKey]: canary } } } })
    const report = diagnoseSourceHistory(JSON.stringify(input))
    assert.deepEqual(report.wrappers, { direct: 2, message: 1, dataMessage: 1, payloadMessage: 1, unrecognized: 1 })
    assert.equal(report.reasons.unrecognizedEnvelope, 1)
    assert.equal(report.native.candidates.notice, 1)
    assert.equal(JSON.stringify(report).includes(canary), false)
})

test('strict top-level parsing rejects API pages, transport envelopes, old versions and malformed JSON with fixed codes', () => {
    for (const [input, expected] of [
        [JSON.stringify({ payload: exported() }), 'unsupported-export-envelope'],
        [JSON.stringify({ messages: exported().messages, page: { secret: canary } }), 'unsupported-export-envelope'],
        [JSON.stringify({ ...exported(), schemaVersion: canary }), 'unsupported-export-version'],
        [JSON.stringify({ ...exported(), schemaVersion: 1 }), 'unsupported-export-version'],
        [JSON.stringify({ ...exported(), session: { id: canary } }), 'invalid-session-schema'],
        [`{"${canary}":`, 'input-invalid-json'],
    ] as const) assert.throws(() => diagnoseSourceHistory(input), error => {
        assert.ok(error instanceof DiagnosticInputError)
        assert.equal(error.code, expected); assert.equal(error.message.includes(canary), false); return true
    })
    const input = exported(); input.messages = []
    const empty = diagnoseSourceHistory(JSON.stringify(input))
    assert.equal(empty.rows.valid, 0)
    assert.ok(empty.limitations.includes('native-rpc-history-completeness-unproven'), 'an empty Hub export cannot prove native history is empty')
})

test('native page capture validates the original wire and excludes the pending overlay from native cursor checks', () => {
    const input = nativeCapture(), copy = structuredClone(input), json = JSON.stringify(input, null, 2)
    const report = diagnoseNativePages(json), output = JSON.stringify(report)
    assert.deepEqual(input, copy)
    assert.equal(output.includes(canary), false); assert.equal(output.includes(unknownKey), false)
    assert.equal(report.inputSchema, 'hapi-native-message-pages-v1')
    assert.equal(report.rows.valid, 7)
    assert.equal(report.native.candidates.userDisplayable, 2); assert.equal(report.native.candidates.assistantDurable, 4)
    assert.equal(report.native.candidates.userPending, 1)
    assert.equal(report.pagination.queueOverlayRows, 1)
    assert.equal(report.pagination.nativeRowsBeyondLimit, 0); assert.equal(report.pagination.rowOrderViolations, 0)
    assert.equal(report.pagination.rowBoundaryViolations, 0)
    assert.equal(report.pagination.chainCompatible, true); assert.equal(report.pagination.requestLinksVerified, true)
    assert.equal(report.pagination.reachedReportedBeginning, true)
    assert.equal(report.pagination.capturedHistoryCompletenessProven, false)
    assert.equal(report.bytes.json, Buffer.byteLength(json))
    assert.equal(report.bytes.largestPage, Math.max(...input.pages.map(page => Buffer.byteLength(JSON.stringify(page)))))
    assert.ok(report.limitations.includes('capture-completeness-unproven'))
    const { requests: _requests, ...responsesOnly } = input
    const withoutQueries = diagnoseNativePages(JSON.stringify(responsesOnly))
    assert.equal(withoutQueries.pagination.chainCompatible, true)
    assert.equal(withoutQueries.pagination.requestLinksVerified, false)
    assert.ok(withoutQueries.limitations.includes('request-cursors-not-recorded'))
})

test('empty native pages, sparse cursors, changing limits and an advancing head are valid source evidence', () => {
    const input = nativeCapture(), first = input.pages[0]!, older = input.pages[1]!
    const empty: HapiMessagesPage = { messages: [], page: { ...first.page, direction: 'before', limit: 1,
        nextBeforeAt: first.page.nextBeforeAt! - 1, nextBeforeSeq: first.page.nextBeforeSeq! - 1,
        nextAfterAt: first.page.nextBeforeAt! - 1, nextAfterSeq: first.page.nextBeforeSeq! - 1,
        snapshotHeadAt: first.page.snapshotHeadAt! + 1000, snapshotHeadSeq: first.page.snapshotHeadSeq! + 10000 } }
    older.page.hasMore = true
    older.page.snapshotHeadAt = empty.page.snapshotHeadAt; older.page.snapshotHeadSeq = empty.page.snapshotHeadSeq
    const terminal: HapiMessagesPage = { messages: [], page: { ...older.page, hasMore: false } }
    input.pages = [first, empty, older, terminal]; input.requests = queriesFor(input.pages)
    const report = diagnoseNativePages(JSON.stringify(input))
    assert.equal(report.pagination.chainCompatible, true)
    assert.equal(report.pagination.emptyNativePages, 2)
    assert.equal(report.pagination.repeatedBeforeCursors, 0, 'an empty final page may repeat the final cursor')
    assert.equal(report.pagination.sameEpochHeadChanges, 1)
    assert.equal(report.pagination.snapshotHeadRegressions, 0)
    assert.equal(report.pagination.requestLinksVerified, true)
    assert.equal(report.rows.valid, 7)
})

test('native captures separate resets and epoch changes instead of merging generations into one transcript', () => {
    for (const reset of [true, false]) {
        const input = nativeCapture(), next = structuredClone(input.pages[0]!)
        next.page = { ...next.page, epoch: 88, reset, direction: reset ? 'latest' : 'before', hasMore: false }
        input.pages.push(next); input.requests = queriesFor(input.pages)
        const report = diagnoseNativePages(JSON.stringify(input))
        assert.equal(report.pagination.distinctEpochs, 2); assert.equal(report.pagination.epochChanges, 1)
        assert.equal(report.pagination.resetPages, reset ? 1 : 0)
        assert.equal(report.pagination.excludedEarlierPages, 2); assert.equal(report.pagination.analyzedPages, 1)
        assert.equal(report.rows.valid, 4, 'old generation rows cannot enter the current parser statistics')
        assert.equal(report.native.candidates.userDisplayable, 1)
        assert.equal(report.pagination.capturedHistoryCompletenessProven, false)
        assert.equal(JSON.stringify(report).includes(canary), false)
    }
})

test('native page diagnostics report stalled or skipped cursor evidence and reject malformed wire without excerpts', () => {
    const skipped = nativeCapture()
    skipped.requests[1]!.beforeSeq!--
    const skip = diagnoseNativePages(JSON.stringify(skipped))
    assert.equal(skip.pagination.requestCursorLinkMismatches, 1); assert.equal(skip.pagination.requestLinksVerified, false)
    const stalled = nativeCapture()
    stalled.pages[1] = { messages: [], page: { ...stalled.pages[0]!.page, direction: 'before' } }
    stalled.requests = queriesFor(stalled.pages)
    const stall = diagnoseNativePages(JSON.stringify(stalled))
    assert.equal(stall.pagination.repeatedBeforeCursors, 1); assert.equal(stall.pagination.nonDescendingLinks, 1)
    assert.equal(stall.pagination.chainCompatible, false)
    const halfCursor = nativeCapture(); halfCursor.pages[0]!.page.nextBeforeAt = null
    assert.equal(diagnoseNativePages(JSON.stringify(halfCursor)).pagination.cursorPairViolations, 1)
    const input = nativeCapture()
    for (const [value, code] of [
        [{ session: input.session, pages: [] }, 'unsupported-native-pages-envelope'],
        [{ session: input.session, pages: [{ error: canary }] }, 'invalid-native-page-schema'],
        [{ ...input, pages: [{ ...input.pages[0], messages: [{ id: canary, [unknownKey]: canary }] }] }, 'invalid-native-page-schema'],
        [{ ...input, requests: [{ limit: 3, beforeAt: 1 }] }, 'invalid-native-requests-schema'],
        [{ ...input, requests: [{ limit: 3, authorization: canary }, input.requests[1]] }, 'invalid-native-requests-schema'],
    ] as const) assert.throws(() => diagnoseNativePages(JSON.stringify(value)), error => {
        assert.ok(error instanceof DiagnosticInputError); assert.equal(error.code, code)
        assert.equal(error.message.includes(canary), false); assert.equal(error.message.includes(unknownKey), false); return true
    })
})

test('the documented CLI is read-only and never prints filenames or JSON parser excerpts on failure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hapi-source-diagnostic-'))
    const filename = join(directory, `${canary}.json`), command = resolve('scripts/diagnose-source-history.ts')
    const json = JSON.stringify(exported())
    const env = { ...process.env }
    // The subprocess is the documented user CLI, not another test worker.
    delete env.NODE_TEST_CONTEXT
    const run = async (flags: string[] = []) => {
        // File descriptors also work in a sandbox that disallows the socket
        // pairs Node creates for captured child-process stdio. This still
        // executes the exact documented CLI; no parsing or I/O is mocked.
        const stdout = await open(join(directory, 'stdout.json'), 'w'), stderr = await open(join(directory, 'stderr.txt'), 'w')
        try {
            const child = spawnSync(process.execPath, ['--import', 'tsx', command, ...flags, filename], {
                cwd: resolve('.'), env, stdio: ['ignore', stdout.fd, stderr.fd], timeout: 10_000,
            })
            assert.equal(child.error, undefined)
            assert.equal(child.signal, null)
            return { code: child.status, stdout: await readFile(join(directory, 'stdout.json'), 'utf8'),
                stderr: await readFile(join(directory, 'stderr.txt'), 'utf8') }
        } finally { await Promise.all([stdout.close(), stderr.close()]) }
    }
    try {
        await writeFile(filename, json)
        const result = await run()
        assert.equal(result.code, 0)
        assert.equal(result.stderr, ''); assert.equal(result.stdout.includes(canary), false)
        assert.equal(JSON.parse(result.stdout).rows.valid, 6)
        assert.equal(await readFile(filename, 'utf8'), json)
        const capture = JSON.stringify(nativeCapture()); await writeFile(filename, capture)
        const native = await run(['--native-pages'])
        assert.equal(native.code, 0); assert.equal(native.stderr, '')
        assert.equal(JSON.parse(native.stdout).pagination.requestLinksVerified, true)
        assert.equal(native.stdout.includes(canary), false); assert.equal(native.stdout.includes(unknownKey), false)
        assert.equal(await readFile(filename, 'utf8'), capture)
        await writeFile(filename, JSON.stringify({ session: exported().session, pages: [{ error: canary }] }))
        const invalidPage = await run(['--native-pages'])
        assert.equal(invalidPage.code, 2); assert.equal(invalidPage.stderr, '')
        assert.deepEqual(JSON.parse(invalidPage.stdout), { diagnosticVersion: 1, error: 'invalid-native-page-schema' })
        await writeFile(filename, `{"${canary}":`)
        const failure = await run()
        assert.equal(failure.code, 2); assert.equal(failure.stderr, '')
        assert.deepEqual(JSON.parse(failure.stdout), { diagnosticVersion: 1, error: 'input-invalid-json' })
        assert.equal(failure.stdout.includes(canary), false)
        assert.equal(await readFile(filename, 'utf8'), `{"${canary}":`)
        await rm(filename)
        const unreadable = await run()
        assert.equal(unreadable.code, 2); assert.equal(unreadable.stderr, '')
        assert.deepEqual(JSON.parse(unreadable.stdout), { diagnosticVersion: 1, error: 'input-unreadable' })
        assert.equal(unreadable.stdout.includes(canary), false, 'fs errors must not disclose the private input filename')
    } finally { await rm(directory, { recursive: true, force: true }) }
})
