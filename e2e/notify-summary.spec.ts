/** Official DSH Conversation and Clipboard; HAPI rows and model responses are explicit fixtures. */
import { test, expect, type Page, type Locator } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { startOfficialEnvironment, type OfficialEnvironment } from './official-runtime.ts'

const summary = 'AGENT_NOTIFY_SUMMARY {"version":1,"status":"done","summary":"Source task completed","action":"Review original changes"}'
const nativeText = `Source native answer remains official Markdown.\n${summary}`
const observedText = `Source Claude answer remains official Markdown.\n${summary}`

async function openWorkspace(page: Page, environment: OfficialEnvironment) {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: environment.origin })
    await page.goto(environment.launchUrl)
    await expect(page.locator('[data-hapi-workspace]')).toBeVisible()
    const notice = page.getByRole('dialog', { name: 'Preview Notice', exact: true })
    if (await notice.isVisible()) await notice.getByRole('button', { name: 'Continue', exact: true }).click()
}
async function openSource(page: Page, name: string): Promise<Locator> {
    await page.locator('.hapi-session-open').filter({ hasText: name }).click()
    const pane = page.getByRole('region', { name: `Pane: ${name}`, exact: true })
    await expect(pane).toBeVisible()
    return pane
}
async function setSummaryPreference(page: Page, value: boolean) {
    await page.getByRole('button', { name: 'Account menu', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Settings', exact: false }).click()
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
    await settings.getByRole('button', { name: 'HAPI Hub', exact: true }).click()
    const checkbox = settings.getByLabel('Show compact summaries in chat', { exact: false })
    // This source-confirmed setting intentionally stays controlled by the
    // acknowledged Hub value while the mutation is in flight.
    if (await checkbox.isChecked() !== value) await checkbox.click()
    await expect(checkbox).toBeChecked({ checked: value })
    await page.keyboard.press('Escape')
    await expect(settings).not.toBeVisible()
}
async function copyClosing(page: Page, pane: Locator, expected: string) {
    const action = pane.locator('[data-turn-tail]').getByRole('button', { name: 'Copy', exact: true })
    await expect(action).toHaveCount(1)
    await action.click()
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(expected)
}

test.describe('source notification summaries through public official Conversation extensions', () => {
    let environment: OfficialEnvironment
    test.beforeAll(async () => {
        environment = await startOfficialEnvironment()
        const native = environment.hapi.add('summary-native', 'Laptop', 'machine-alpha')
        ;(native.rows[1]!.content as { content: { data: { message: string } } }).content.data.message = nativeText
        environment.hapi.emit({ type: 'session-added', sessionId: native.session.id })
        const observed = environment.hapi.addObserved('claude', 'summary-claude')
        ;(observed.rows[1]!.content as { content: { data: { message: { content: Array<{ type: string; text: string }> } } } }).content.data.message.content[0]!.text = observedText
        const empty = environment.hapi.add('summary-only', 'Laptop', 'machine-alpha')
        ;(empty.rows[1]!.content as { content: { data: { message: string } } }).content.data.message = summary
        environment.hapi.emit({ type: 'session-added', sessionId: empty.session.id })
        const ordinary = await environment.rpc<{ sessionId: string }>('session/create', { cwd: environment.directory })
        await environment.rpc('session/selectModel', { sessionId: ordinary.sessionId, provider: 'fixture', model: 'fixture-model' })
        await environment.rpc('session/rename', { sessionId: ordinary.sessionId, title: 'Ordinary DSH summary comparison' })
        await environment.rpc('session/prompt', { sessionId: ordinary.sessionId, requestId: 'summary-comparison-ordinary-dsh', mode: 'queue',
            content: [{ type: 'text', text: 'Ordinary official DSH comparison' }] })
    })
    test.afterAll(async () => { await environment?.close() })

    test('one confirmed preference updates both source panes and copy without changing source identity or drafts', async ({ page }, info) => {
        const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
        try {
            await openWorkspace(page, environment)
            const catalog = () => environment.rpc<{ sessions: Array<{ id: string; hapiSessionId: string }> }>('hapi/catalog')
            const identity = (row: { id: string; hapiSessionId: string }) => ({ id: row.id, hapiSessionId: row.hapiSessionId })
            const original = (await catalog()).sessions.filter(row => ['native-summary-native', 'source-summary-claude'].includes(row.hapiSessionId)).map(identity)
            expect(original).toHaveLength(2)
            const native = await openSource(page, 'Native Codex summary-native')
            await expect(native.getByText('Source native answer remains official Markdown.', { exact: true })).toBeVisible()
            await expect(native.locator('[data-hapi-summary-footer]')).toHaveCount(0)
            await expect(native).not.toContainText('AGENT_NOTIFY_SUMMARY')
            await copyClosing(page, native, 'Source native answer remains official Markdown.')
            const draft = native.getByRole('textbox', { name: 'Message or run a task, / commands, @ files or sessions', exact: true })
            await draft.fill('Keep this unsent source draft while summary presentation changes')
            await page.getByRole('button', { name: 'Split left / right', exact: true }).click()
            const observed = await openSource(page, 'Source claude summary-claude')
            await expect(observed.getByText('Source Claude answer remains official Markdown.', { exact: true })).toBeVisible()
            await expect(observed.locator('[data-hapi-summary-footer]')).toHaveCount(0)

            await setSummaryPreference(page, true)
            expect(environment.hapi.admin.settings.sessionSummaryInChat).toBe(true)
            for (const pane of [native, observed]) {
                await expect(pane.locator('[data-hapi-summary-footer]')).toContainText('Source task completed')
                await expect(pane.locator('[data-hapi-summary-footer]')).toContainText('Review original changes')
                await expect(pane.locator('[data-clock="end"] > button:first-child')).toBeHidden()
                await expect(pane.locator('[data-hapi-summary-copy="closing"]')).toBeVisible()
            }
            await copyClosing(page, native, nativeText)
            await copyClosing(page, observed, observedText)
            await expect(draft).toHaveText('Keep this unsent source draft while summary presentation changes')
            expect((await catalog()).sessions.filter(row => original.some(previous => previous.hapiSessionId === row.hapiSessionId)).map(identity)).toEqual(original)
            expect(environment.hapi.require('native-summary-native').session.metadata?.codexSessionId).toBe('codex-thread-summary-native')
            expect(environment.hapi.require('source-summary-claude').session.metadata?.claudeSessionId).toBe('claude-thread-summary-claude')

            await page.getByRole('button', { name: 'Split top / bottom', exact: true }).click()
            const ordinary = await openSource(page, 'Ordinary DSH summary comparison')
            await expect(ordinary.getByText('DSH fixture response through the official AgentLoop.', { exact: true })).toBeVisible()
            await expect(ordinary.locator('[data-hapi-summary-footer], [data-hapi-summary-copy]')).toHaveCount(0)
            await expect(ordinary.locator('[data-clock="end"] > button:first-child')).toBeVisible()
            await copyClosing(page, ordinary, 'DSH fixture response through the official AgentLoop.')

            await setSummaryPreference(page, false)
            await expect(native.locator('[data-hapi-summary-footer], [data-hapi-summary-copy]')).toHaveCount(0)
            await expect(observed.locator('[data-hapi-summary-footer], [data-hapi-summary-copy]')).toHaveCount(0)
            await expect(native.locator('[data-clock="end"] > button:first-child')).toBeVisible()
            await copyClosing(page, native, 'Source native answer remains official Markdown.')
            await expect(draft).toHaveText('Keep this unsent source draft while summary presentation changes')
            expect(environment.hapi.sent).toHaveLength(0)
            expect(environment.hapi.admin.mutations.filter(row => row.path === '/api/hub-settings')).toHaveLength(2)
            expect(errors).toEqual([])
        } finally { if (errors.length) await info.attach('notify-summary-errors', { body: errors.join('\n'), contentType: 'text/plain' }) }
    })

    test('a source footer-only answer remains accessible and its original text can be copied after reload', async ({ page }, info) => {
        const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
        try {
            await environment.rpc('hapi/sourceAdminOperation', { operationId: randomUUID(), action: { kind: 'settings', values: { sessionSummaryInChat: true } } })
            await openWorkspace(page, environment)
            let pane = await openSource(page, 'Native Codex summary-only')
            await expect(pane.locator('[data-hapi-summary-footer]')).toContainText('Source task completed')
            await expect(pane.locator('[data-hapi-summary-copy="footer"]')).toBeVisible()
            await pane.locator('[data-hapi-summary-copy="footer"]').click()
            await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(summary)
            await page.reload(); await expect(page.locator('[data-hapi-workspace]')).toBeVisible()
            pane = await openSource(page, 'Native Codex summary-only')
            await expect(pane.locator('[data-hapi-summary-footer]')).toContainText('Source task completed')
            expect(environment.hapi.require('native-summary-only').session.metadata?.codexSessionId).toBe('codex-thread-summary-only')
            expect(errors).toEqual([])
        } finally { if (errors.length) await info.attach('notify-summary-errors', { body: errors.join('\n'), contentType: 'text/plain' }) }
    })
})
