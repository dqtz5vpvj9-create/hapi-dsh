/** Real official DSH graphs, ServiceWorker, IndexedDB and composer. HAPI sessions
 * and the DSH model are explicit protocol fixtures, not real model execution. */
import { test, expect, type Locator, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { startOfficialEnvironment, type OfficialEnvironment } from './official-runtime.ts'

const composerName = 'Message or run a task, / commands, @ files or sessions'
const day = (value: number): Date => { const now = new Date(); now.setDate(value); now.setHours(12, 0, 0, 0); return now }
const dateKey = (value: number): string => { const valueDate = day(value); return `${valueDate.getFullYear()}-${String(valueDate.getMonth() + 1).padStart(2, '0')}-${String(value).padStart(2, '0')}` }
async function admit(page: Page, environment: OfficialEnvironment): Promise<void> {
    await page.goto(environment.launchUrl)
    await expect(page.locator('[data-hapi-workspace]')).toBeVisible()
    const notice = page.getByRole('dialog', { name: 'Preview Notice', exact: true })
    if (await notice.isVisible()) await notice.getByRole('button', { name: 'Continue', exact: true }).click()
}
async function search(dialog: Locator, value: string): Promise<void> {
    if (!await dialog.getByRole('searchbox').isVisible()) await dialog.getByRole('button', { name: /^Search conversations/ }).click()
    await dialog.getByRole('searchbox').fill(value)
}
async function savedShare(page: Page) {
    return page.evaluate(async () => {
        const id = new URL(location.href).searchParams.get('hapiShare')!
        const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('hapi-share-transfers', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
        const row = await new Promise<{ text: string; files: Array<{ name: string; blob: Blob }>; hapiDshDelivery?: { status: string; target: { kind: string; hubId?: string; hostId?: string; sessionId: string } } }>(resolve => {
            const request = db.transaction('transfers').objectStore('transfers').get(id); request.onsuccess = () => resolve(request.result)
        })
        db.close()
        return { text: row.text, files: await Promise.all(row.files.map(async file => ({ name: file.name, bytes: Array.from(new Uint8Array(await file.blob.arrayBuffer())) }))), delivery: row.hapiDshDelivery }
    })
}

test.describe('HAPI share target snapshot and original payload', () => {
    let environment: OfficialEnvironment
    test.afterEach(async () => { await environment?.close() })

    test('first discovery, original cap, fixed recency, multi-field/date search and exact source selection survive live updates', async ({ page }, info) => {
        environment = await startOfficialEnvironment()
        const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
        const machine = environment.hapi.admin.machines.find(value => value.id === 'machine-alpha')!
        machine.metadata!.displayName = 'Classroom Laptop'
        environment.hapi.emit({ type: 'machine-updated', machineId: machine.id })
        for (let index = 0; index < 10; index++) {
            const fixture = environment.hapi.add(`share-${index}`, 'Laptop', 'machine-alpha')
            fixture.session.metadata!.name = `Share candidate ${index}`
            fixture.session.metadata!.agentSessionId = fixture.session.metadata!.codexSessionId!
            fixture.session.metadata!.codexUpdatedAt = day(index + 1).getTime()
            fixture.session.updatedAt = Date.now() + index
            if (index === 2) Object.assign(fixture.session.metadata!, { summary: { text: 'Settlement feature plan' }, codexAgentNickname: 'reviewer' })
            environment.hapi.emit({ type: 'session-added', sessionId: fixture.session.id })
        }
        const inactive = environment.hapi.addObserved('claude', 'share-inactive')
        inactive.session.active = false; inactive.session.updatedAt = day(20).getTime()
        inactive.session.metadata!.name = 'Old offline review'; inactive.session.metadata!.agentSessionId = inactive.session.metadata!.claudeSessionId!
        inactive.session.metadataVersion++; environment.hapi.emit({ type: 'session-updated', sessionId: inactive.session.id })
        await expect.poll(async () => (await environment.rpc<{ sessions: unknown[] }>('hapi/catalog')).sessions.length).toBe(13)
        await admit(page, environment)

        let release!: () => void, blocked = false
        const gate = new Promise<void>(resolve => { release = resolve })
        await page.route('**/api/hapi/catalog', async route => { if (!blocked) { blocked = true; await gate }; await route.continue() })
        const text = `${'Snapshot payload '.repeat(20)}ORIGINAL END`
        try {
            await page.goto(`${environment.origin}/share#text=${encodeURIComponent(text)}`)
            const dialog = page.getByRole('dialog', { name: 'Incoming share', exact: true })
            await expect(dialog).toBeVisible()
            await expect(dialog.getByText('Loading the first conversation snapshot…')).toBeVisible()
            await expect(dialog.locator('[data-share-candidate]')).toHaveCount(0)
            release()
            await expect(dialog.getByRole('heading', { name: 'Recent active sessions', exact: true })).toBeVisible()
            const candidates = dialog.locator('[data-share-candidate]')
            await expect(candidates).toHaveCount(8)
            await expect(candidates.locator('strong')).toHaveText([9, 8, 7, 6, 5, 4, 3, 2].map(index => `Share candidate ${index}`))
            await expect(dialog.locator('.hapi-share-hidden-count')).toContainText('4 more active sessions')
            await expect(dialog.locator('[data-share-text-preview]')).toHaveText(`${text.slice(0, 200).trimEnd()}…`)
            expect((await savedShare(page)).text).toBe(text)

            const changed = environment.hapi.require('native-share-2').session
            changed.metadata!.name = 'Updated after snapshot'; changed.metadata!.codexUpdatedAt = Date.now(); changed.metadataVersion++
            environment.hapi.emit({ type: 'session-updated', sessionId: changed.id })
            const late = environment.hapi.add('share-late', 'Laptop', 'machine-alpha')
            late.session.metadata!.name = 'New live arrival'; late.session.metadata!.codexUpdatedAt = Date.now() + 1
            environment.hapi.emit({ type: 'session-added', sessionId: late.session.id })
            await expect(page.locator('.hapi-session-sidebar')).toContainText('Updated after snapshot')
            await expect(page.locator('.hapi-session-sidebar')).toContainText('New live arrival')
            await expect(candidates.locator('strong')).toHaveText([9, 8, 7, 6, 5, 4, 3, 2].map(index => `Share candidate ${index}`))

            await dialog.getByRole('button', { name: 'Close incoming share', exact: true }).click()
            const sidebar = page.locator('.hapi-session-sidebar')
            await sidebar.locator('.hapi-sidebar-options > summary').click()
            await sidebar.getByRole('spinbutton', { name: 'Sessions per folder preview', exact: true }).fill('3')
            await sidebar.locator('.hapi-sidebar-options > summary').click()
            await page.locator('.hapi-incoming-share-open').click()
            await expect(candidates).toHaveCount(3)
            await expect(dialog.locator('.hapi-share-hidden-count')).toContainText('9 more active sessions')
            expect(await page.evaluate(() => localStorage.getItem('hapi-session-preview-limit'))).toBe('3')
            await search(dialog, 'settlement reviewer classroom')
            await expect(candidates).toHaveCount(1); await expect(candidates).toContainText('Share candidate 2')
            await search(dialog, 'old offline classroom')
            await expect(candidates).toHaveCount(1); await expect(candidates).toContainText('Old offline review')
            await search(dialog, '*')
            await expect(candidates).toHaveCount(13)
            await expect(dialog.locator('.hapi-share-hidden-count')).toHaveCount(0)
            await expect(candidates.filter({ hasText: 'New live arrival' })).toHaveCount(0)

            await search(dialog, '')
            await dialog.getByRole('button', { name: 'Date range', exact: true }).click()
            const calendar = dialog.getByRole('dialog', { name: 'Date range', exact: true })
            await expect(calendar.locator(`[data-date="${dateKey(3)}"]`)).toHaveAttribute('data-activity', 'true')
            await expect(calendar.locator(`[data-date="${dateKey(20)}"]`)).toHaveAttribute('data-activity', 'true')
            await page.screenshot({ path: `${info.outputDir}/share-picker-calendar.png`, fullPage: true })
            expect(await calendar.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)')
            expect(await calendar.evaluate(element => getComputedStyle(element).getPropertyValue('--hapi-accent').trim())).not.toBe('')
            await calendar.locator(`[data-date="${dateKey(5)}"]`).click()
            await expect(candidates).toHaveCount(3)
            const activityColor = await calendar.locator(`[data-date="${dateKey(3)}"]`).evaluate(element => getComputedStyle(element).color)
            expect(await calendar.locator(`[data-date="${dateKey(18)}"]`).evaluate(element => getComputedStyle(element).color)).not.toBe(activityColor)
            expect(await calendar.locator(`[data-date="${dateKey(5)}"]`).evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)')
            await calendar.locator(`[data-date="${dateKey(3)}"]`).click()
            await expect(calendar).toHaveCount(0)
            await expect(candidates.locator('strong')).toHaveText([4, 3, 2].map(index => `Share candidate ${index}`))
            await expect(dialog.getByRole('heading', { name: 'Matching sessions', exact: true })).toBeVisible()
            await page.screenshot({ path: `${info.outputDir}/share-picker-fixed-snapshot.png`, fullPage: true })
            await candidates.filter({ hasText: 'Share candidate 2' }).click()
            const selected = page.getByRole('region', { name: 'Pane: Updated after snapshot', exact: true })
            await expect(selected.getByRole('textbox', { name: composerName })).toHaveText(text)
            await expect(selected.locator('[data-share-delivery]')).toHaveAttribute('data-share-delivery', 'inserted')
            expect((await savedShare(page)).delivery?.target).toEqual({ kind: 'hapi', hubId: 'e2e-native-hub', sessionId: 'native-share-2' })
            expect(environment.hapi.sent).toHaveLength(0); expect(errors).toEqual([])
        } finally { release() }
    })

    test('real worker image and multiple-file previews preserve original downloads and explicitly append to one official composer', async ({ page }, info) => {
        environment = await startOfficialEnvironment()
        const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
        await page.setViewportSize({ width: 420, height: 900 })
        await admit(page, environment); await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller))
        const picture = await page.evaluate(async () => {
            const canvas = document.createElement('canvas'); canvas.width = 2; canvas.height = 2
            const context = canvas.getContext('2d')!; context.fillStyle = '#4770d1'; context.fillRect(0, 0, 2, 2)
            const blob = await new Promise<Blob>(resolve => canvas.toBlob(value => resolve(value!), 'image/png'))
            const form = new FormData(); form.set('text', 'Image original text'); form.append('files', new File([blob], 'source-picture.png', { type: 'image/png' }))
            const response = await fetch('/hapi-dsh/share', { method: 'POST', body: form }); if (!response.ok) throw new Error(`Share failed ${response.status}`)
            return { url: response.url, bytes: Array.from(new Uint8Array(await blob.arrayBuffer())) }
        })
        await page.goto(picture.url)
        const dialog = page.getByRole('dialog', { name: 'Incoming share', exact: true })
        const image = dialog.getByRole('img', { name: 'source-picture.png', exact: true })
        await expect(image).toBeVisible(); await expect.poll(() => image.evaluate(value => (value as HTMLImageElement).naturalWidth)).toBe(2)
        await expect(image).toHaveCSS('width', '64px'); await expect(image).toHaveCSS('height', '64px')
        await expect(dialog.locator('.hapi-share-file-preview')).toContainText('image/png')
        await dialog.getByText('Review original content', { exact: true }).click()
        const download = page.waitForEvent('download')
        await dialog.getByRole('button', { name: 'Save original file', exact: true }).click()
        const downloaded = await download, path = await downloaded.path()
        expect(downloaded.suggestedFilename()).toBe('source-picture.png'); expect(path).toBeTruthy()
        expect(Array.from(await readFile(path!))).toEqual(picture.bytes)
        expect((await savedShare(page)).files[0]?.bytes).toEqual(picture.bytes)
        await page.screenshot({ path: `${info.outputDir}/share-picker-mobile-image.png`, fullPage: true })
        page.once('dialog', value => { void value.accept() })
        await dialog.getByRole('button', { name: 'Discard saved share', exact: true }).click()
        await expect(dialog).not.toBeVisible()

        const destination = await page.evaluate(async () => {
            const form = new FormData(); form.set('text', 'Four unmodified originals')
            for (let index = 1; index <= 4; index++) form.append('files', new File([`Original file ${index}`], `original-${index}.txt`, { type: 'text/plain' }))
            const response = await fetch('/hapi-dsh/share', { method: 'POST', body: form }); if (!response.ok) throw new Error(`Share failed ${response.status}`); return response.url
        })
        await page.goto(destination)
        await expect(dialog.locator('.hapi-share-files-preview')).toHaveText('4 filesoriginal-1.txt, original-2.txt, original-3.txt…')
        await expect(dialog.locator('.hapi-share-files-preview')).not.toContainText('original-4.txt')
        await dialog.getByText('Review original content', { exact: true }).click()
        await expect(dialog.getByRole('button', { name: 'Save original file', exact: true })).toHaveCount(4)
        await search(dialog, 'native codex beta')
        await dialog.locator('[data-share-candidate]').filter({ hasText: 'Native Codex beta' }).click()
        const beta = page.getByRole('region', { name: 'Pane: Native Codex beta', exact: true })
        await expect(beta.getByRole('textbox', { name: composerName })).toHaveText('Four unmodified originals')
        for (let index = 1; index <= 4; index++) await expect(beta.getByText(`original-${index}.txt`, { exact: true })).toBeVisible()
        await expect(beta.locator('[data-share-delivery]')).toHaveAttribute('data-share-delivery', 'inserted')
        const stored = await savedShare(page)
        expect(stored.delivery?.target).toEqual({ kind: 'hapi', hubId: 'e2e-native-hub', sessionId: 'native-beta' })
        expect(stored.files.map(file => Buffer.from(file.bytes).toString())).toEqual([1, 2, 3, 4].map(index => `Original file ${index}`))
        expect(environment.hapi.sent).toHaveLength(0); expect(errors).toEqual([])
    })

    test('ordinary remote DSH remains a real target and a failed source catalog still exposes loaded local DSH', async ({ page }, info) => {
        environment = await startOfficialEnvironment(true)
        const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
        const ordinary = await environment.rpc<{ sessionId: string }>('session/create', { cwd: environment.directory })
        await environment.rpc('session/selectModel', { sessionId: ordinary.sessionId, provider: 'fixture', model: 'fixture-model' })
        await environment.rpc('session/rename', { sessionId: ordinary.sessionId, title: 'Local ordinary DSH' })
        await environment.rpc('session/prompt', { sessionId: ordinary.sessionId, requestId: 'share-picker-local-seed', mode: 'queue', content: [{ type: 'text', text: 'Real official fixture seed' }] })
        await admit(page, environment)
        await page.goto(`${environment.origin}/share#text=Only%20the%20remote%20DSH%20draft`)
        const dialog = page.getByRole('dialog', { name: 'Incoming share', exact: true })
        await search(dialog, 'remote DSH')
        await dialog.locator('[data-share-candidate]').filter({ hasText: 'DSH remote conversation' }).click()
        const remote = page.getByRole('region', { name: 'Pane: DSH remote conversation', exact: true })
        await expect(remote.getByRole('textbox', { name: composerName })).toHaveText('Only the remote DSH draft')
        expect((await savedShare(page)).delivery?.target).toEqual({ kind: 'dsh', hostId: 'runner-one', sessionId: environment.remoteSessionId })
        await page.route('**/api/hapi/catalog', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Explicit source-catalog outage fixture' }) }))
        await page.goto(`${environment.origin}/share#text=Local%20DSH%20fallback%20draft`)
        await expect(dialog).toContainText('The original HAPI Hub is unavailable')
        await search(dialog, 'local ordinary')
        await dialog.locator('[data-share-candidate]').filter({ hasText: 'Local ordinary DSH' }).click()
        const local = page.getByRole('region', { name: 'Pane: Local ordinary DSH', exact: true })
        await expect(local.getByRole('textbox', { name: composerName })).toHaveText('Local DSH fallback draft')
        expect((await savedShare(page)).delivery?.target).toEqual({ kind: 'dsh', hostId: 'local', sessionId: ordinary.sessionId })
        await page.screenshot({ path: `${info.outputDir}/share-picker-loaded-dsh-outage.png`, fullPage: true })
        expect(environment.hapi.sent).toHaveLength(0); expect(errors).toEqual([])
    })
})
