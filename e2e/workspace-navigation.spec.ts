/** Pinned official Chat plus synthetic source history; no real conversation writes. */
import { test, expect, type Locator } from '@playwright/test'
import { startOfficialEnvironment, type OfficialEnvironment } from './official-runtime.ts'
import { acknowledgePreviewNotice } from './preview-notice.ts'
import { nativeIndexedHistory, useBoundedSourceHistory } from './source-conversation-fixture.ts'
import { initialWorkspace } from '../src/client/model.ts'

const reasoningNeedle = 'Exact reasoning destination inside the completed process.'
const toolNeedle = 'Exact tool result destination inside the completed process.'
const processTargets = { reasoning: 36, invocation: 37, result: 38 } as const
function processHistory(threadId: string) {
    const rows = nativeIndexedHistory(threadId, 8, 20)
    const reasoning = rows[processTargets.reasoning]!
    const envelope = reasoning.content as { content: { data: Record<string, unknown> } }
    envelope.content.data.message = `Synthetic reasoning destination summary.\n\n${reasoningNeedle}`
    for (const [type, index] of [['tool-call', processTargets.invocation], ['tool-call-result', processTargets.result]] as const) {
        const row = rows[index]!, itemId = 'navigation-tool', turnId = 'synthetic-turn-1'
        const execution = { threadId, turnId, itemId, turn: { status: 'completed', started: true, ended: true } }
        const localId = `codex:${threadId}:${turnId}:${itemId}:${type}`
        rows[index] = { ...row, id: `native:${localId}`, localId, content: { role: 'agent',
            content: { type: 'codex', data: { type, id: localId, callId: 'navigation-tool-call',
                ...(type === 'tool-call' ? { name: 'SyntheticNavigationTool', input: { command: 'Synthetic tool invocation destination' } }
                    : { output: toolNeedle }), nativeExecution: execution } }, meta: { sentFrom: 'cli', nativeExecution: execution } } }
    }
    return rows
}

const editorName = 'Message or run a task, / commands, @ files or sessions'
async function reading(pane: Locator) {
    return pane.locator('[data-conversation-scroll]').evaluate(port => {
        const top = port.getBoundingClientRect().top
        const row = [...port.querySelectorAll<HTMLElement>('[data-chat-node-key]')].find(row => row.getBoundingClientRect().bottom > top && row.getBoundingClientRect().height > 0)
        return row ? { key: row.dataset.chatNodeKey!, offset: row.getBoundingClientRect().top - top } : null
    })
}

test.describe('explicit destinations and reload reading', () => {
    let environment: OfficialEnvironment
    test.beforeAll(async () => {
        environment = await startOfficialEnvironment()
        const source = environment.hapi.add('navigation', 'Synthetic navigation runner', 'machine-alpha')
        source.rows = nativeIndexedHistory(source.session.metadata!.codexSessionId!, 40, 1)
        useBoundedSourceHistory(source)
        environment.hapi.emit({ type: 'session-added', sessionId: source.session.id })
        const process = environment.hapi.add('navigation-process', 'Synthetic process navigation runner', 'machine-alpha')
        process.rows = processHistory(process.session.metadata!.codexSessionId!)
        useBoundedSourceHistory(process)
        environment.hapi.emit({ type: 'session-added', sessionId: process.session.id })
    })
    test.afterAll(async () => { await environment?.close() })
    test.beforeEach(async () => {
        const document = await environment.rpc<{ revision: number }>('hapi/workspaceGet')
        let sequence = 0
        const result = await environment.rpc<{ status: string }>('hapi/workspacePut', {
            expectedRevision: document.revision, operationId: 'navigation-reset-' + crypto.randomUUID(),
            state: initialWorkspace(() => 'navigation-node-' + ++sequence),
        })
        expect(result.status).toBe('applied')
    })

    test('deep link holds its exact message across live updates; ordinary selection returns latest; reload keeps its anchor', async ({ page }, info) => {
        const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
        const source = environment.hapi.require('native-navigation'), hit = source.rows[10]!
        const admission = await page.request.get(environment.launchUrl, { maxRedirects: 0 }); expect(admission.status()).toBe(303)
        const catalog = await environment.rpc<{ hubId: string }>('hapi/catalog')
        const destination = new URL(environment.origin)
        destination.searchParams.set('hapiHub', catalog.hubId); destination.searchParams.set('hapiSession', source.session.id)
        destination.searchParams.set('hapiMessage', hit.id)
        await page.goto(destination.href); await acknowledgePreviewNotice(page, environment, { initialView: 'existing-session' })
        const pane = page.getByRole('region', { name: 'Pane: Native Codex navigation', exact: true })
        const view = pane.locator('[data-hapi-graph="shared"]')
        await expect(view).toHaveAttribute('data-hapi-reading', 'ready')
        const target = pane.getByText('Synthetic original input 6.', { exact: true })
        await expect(target).toBeInViewport({ ratio: .8 })
        await expect(pane.locator('[data-chat-following-tail]')).toHaveCount(0)
        const before = (await target.boundingBox())!
        for (const row of nativeIndexedHistory(source.session.metadata!.codexSessionId!, 41, 1).slice(-2)) {
            source.rows.push(row); environment.hapi.emit({ type: 'message-received', sessionId: source.session.id, message: row })
        }
        await expect(pane.getByText('Synthetic final answer 41.', { exact: true })).toHaveCount(1)
        await expect(target).toBeInViewport({ ratio: .8 })
        expect(Math.abs((await target.boundingBox())!.y - before.y)).toBeLessThan(8)
        const composer = pane.getByRole('textbox', { name: editorName, exact: true })
        await composer.fill('Draft retained through navigation and refresh')
        await page.locator('.hapi-session-open').filter({ hasText: 'Native Codex navigation' }).click()
        await expect(pane.getByText('Synthetic final answer 41.', { exact: true })).toBeInViewport()
        await expect(pane.locator('[data-chat-following-tail]')).toHaveCount(1)
        await page.evaluate(() => history.replaceState(null, '', location.pathname))
        const port = pane.locator('[data-conversation-scroll]'), box = (await port.boundingBox())!
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.wheel(0, -650)
        await expect(pane.locator('[data-chat-following-tail]')).toHaveCount(0)
        const anchor = await reading(pane); expect(anchor).not.toBeNull()
        await page.reload(); await expect(composer).toHaveText('Draft retained through navigation and refresh')
        await expect(view).toHaveAttribute('data-hapi-reading', 'ready')
        await expect.poll(async () => {
            const current = await reading(pane)
            return current?.key === anchor!.key ? Math.abs(current.offset - anchor!.offset) : 999
        }).toBeLessThan(8)
        expect(environment.hapi.sent).toHaveLength(0); expect(errors).toEqual([])
        await info.attach('navigation-held-anchor', { body: await page.screenshot(), contentType: 'image/png' })
    })

    test('exact reasoning, Tool invocation and Tool result deep links reveal their official collapsed bodies', async ({ page }, info) => {
        const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
        const source = environment.hapi.require('native-navigation-process')
        const admission = await page.request.get(environment.launchUrl, { maxRedirects: 0 }); expect(admission.status()).toBe(303)
        const catalog = await environment.rpc<{ hubId: string }>('hapi/catalog')
        const destination = new URL(environment.origin)
        destination.searchParams.set('hapiHub', catalog.hubId); destination.searchParams.set('hapiSession', source.session.id)
        for (const [kind, index] of Object.entries(processTargets)) {
            destination.searchParams.set('hapiMessage', source.rows[index]!.id)
            await page.goto(destination.href); await acknowledgePreviewNotice(page, environment, { initialView: 'existing-session' })
            const pane = page.getByRole('region', { name: 'Pane: Native Codex navigation-process', exact: true })
            await expect(pane.locator('[data-hapi-graph="shared"]')).toHaveAttribute('data-hapi-reading', 'ready')
            // The second reasoning paragraph and full Tool result are absent
            // from collapsed summaries: visibility proves the owner disclosed
            // the body, rather than merely scrolling to its parent Turn.
            const target = pane.getByText(kind === 'reasoning' ? reasoningNeedle : toolNeedle, { exact: true })
            await expect(target).toBeInViewport({ ratio: .8 })
            await expect(pane.locator('[data-chat-following-tail]')).toHaveCount(0)
            const focused = page.locator(':focus')
            await expect(focused).toHaveAttribute(kind === 'reasoning' ? 'data-variant' : 'data-chat-call-id',
                kind === 'reasoning' ? 'think' : /navigation-tool-call/)
            await expect(pane.locator('[data-step-process-body][hidden="until-found"]').first()).toBeAttached()
            await expect(pane.locator('.hapi-reading-error')).toHaveCount(0)
            await info.attach(`exact-${kind}-target`, { body: await page.screenshot(), contentType: 'image/png' })
        }
        expect(environment.hapi.sent).toHaveLength(0); expect(errors).toEqual([])
    })
})
