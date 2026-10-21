import { acknowledgePreviewNotice } from './preview-notice.ts'
/** Original HAPI HTTP wire fixtures, decoded and rendered by the unchanged
 * official DSH AttachmentStore, Conversation image gallery and lightbox. */
import { test, expect, type Locator, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { startOfficialEnvironment, type OfficialEnvironment } from './official-runtime.ts'
import type { NativeFixture } from './hapi-fixture.ts'

const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC', 'base64')
const imageId = 'opaque/generated/image?original=1#binary'
// Explicit media transport bytes, not a claim that a codec or model generated
// a playable movie. The document has no installed video body and is downloaded.
const videoBytes = Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 1, 128, 255, 0, 99])
function generated(fixture: NativeFixture, opaqueId: string, fileName: string, mimeType = 'image/png') {
    const at = fixture.rows[0]!.createdAt
    fixture.rows.splice(1, fixture.rows.length - 1,
        { id: `generated-${fixture.session.id}`, seq: 2, localId: null, createdAt: at + 1,
            content: { role: 'agent', content: { type: 'codex', data: { type: 'generated-image', imageId: opaqueId, fileName,
                mimeType, source: { ingress: 'mcp', toolName: mimeType.startsWith('video/') ? 'display_video' : 'display_image' } } } } },
        { id: `ready-${fixture.session.id}`, seq: 3, localId: null, createdAt: at + 2,
            content: { role: 'agent', content: { type: 'event', data: { type: 'ready' } } } })
}
async function openWorkspace(page: Page, environment: OfficialEnvironment) {
    await page.goto(environment.launchUrl)
    await expect(page.locator('[data-hapi-workspace]')).toBeVisible()
    await acknowledgePreviewNotice(page, environment)
}
async function openSource(page: Page, name: string): Promise<Locator> {
    await page.locator('.hapi-session-open').filter({ hasText: name }).click()
    const pane = page.getByRole('region', { name: `Pane: ${name}`, exact: true }); await expect(pane).toBeVisible(); return pane
}
async function loaded(pane: Locator, name: string) {
    const image = pane.getByRole('img', { name, exact: true })
    await expect(image).toBeVisible()
    await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(1)
    await expect(image).toHaveAttribute('src', /^blob:/)
    return image
}

test.describe('original generated media in official attachment views', () => {
    let environment: OfficialEnvironment
    test.beforeAll(async () => {
        environment = await startOfficialEnvironment()
        const alpha = environment.hapi.addObserved('claude', 'generated-alpha', 'machine-alpha')
        const beta = environment.hapi.addObserved('pi', 'generated-beta', 'machine-beta')
        environment.hapi.artifacts.setGenerated(alpha.session.id, imageId, { bytes: pixel, mimeType: 'image/png', fileName: 'alpha-original.png' })
        environment.hapi.artifacts.setGenerated(beta.session.id, imageId, { bytes: pixel, mimeType: 'application/octet-stream', fileName: 'beta-original.png' })
        generated(alpha, imageId, 'alpha-transcript-hint.png'); generated(beta, imageId, 'beta-transcript-hint.png')
        const missing = environment.hapi.addObserved('claude', 'generated-missing', 'machine-alpha')
        generated(missing, 'expired-original-registry-id', 'missing-original.png')
        const video = environment.hapi.addObserved('claude', 'generated-video', 'machine-beta')
        environment.hapi.artifacts.setGenerated(video.session.id, 'video/opaque-original', { bytes: videoBytes, mimeType: 'video/mp4', fileName: 'original-video.mp4' })
        generated(video, 'video/opaque-original', 'transcript-video.mp4', 'video/mp4')
    })
    test.afterAll(async () => { await environment?.close() })

    test('same opaque media ID on two machines loads through each original source and survives browser reload', async ({ page }, info) => {
        const errors: string[] = [], requests: string[] = []
        page.on('pageerror', error => errors.push(error.message)); page.on('request', request => requests.push(request.url()))
        try {
            await openWorkspace(page, environment)
            const alpha = await openSource(page, 'Source claude generated-alpha')
            const alphaImage = await loaded(alpha, 'alpha-original.png')
            await expect(alpha).not.toContainText('Source resource unavailable')
            await alphaImage.click()
            const lightbox = page.getByRole('dialog').filter({ has: page.getByRole('img', { name: 'alpha-original.png', exact: true }) })
            await expect(lightbox).toBeVisible(); await page.keyboard.press('Escape'); await expect(lightbox).toHaveCount(0)
            await page.getByRole('button', { name: 'Split left / right', exact: true }).click()
            const beta = await openSource(page, 'Source pi generated-beta')
            await loaded(beta, 'beta-original.png')
            expect(environment.hapi.artifacts.requests.filter(value => value.imageId === imageId)).toEqual(expect.arrayContaining([
                expect.objectContaining({ sessionId: 'source-generated-alpha', machineId: 'machine-alpha', imageId, method: 'GET' }),
                expect.objectContaining({ sessionId: 'source-generated-beta', machineId: 'machine-beta', imageId, method: 'GET' }),
            ]))
            // Browser reads only the official session-authorized attachment
            // service, never a Runner address or a bearer source API URL.
            expect(requests.some(value => new URL(value).pathname.includes('/generated-images/'))).toBe(false)
            const reads = environment.hapi.artifacts.requests.filter(value => value.imageId === imageId).length
            await expect(page.locator('.hapi-persistence-saved')).toBeVisible()
            await page.reload(); await expect(page.locator('[data-hapi-workspace]')).toBeVisible()
            await loaded(alpha, 'alpha-original.png'); await loaded(beta, 'beta-original.png')
            expect(environment.hapi.artifacts.requests.filter(value => value.imageId === imageId)).toHaveLength(reads)
            await expect(page.locator('.hapi-session-sidebar')).toHaveCount(1)
            await expect(page.locator('iframe')).toHaveCount(0)
            expect(errors).toEqual([])
        } finally {
            await info.attach('generated-media-source-reads', { body: JSON.stringify({ reads: environment.hapi.artifacts.requests, errors }, null, 2), contentType: 'application/json' })
        }
    })

    test('a resource missing on its original Runner remains visible as unavailable without inventing an empty answer', async ({ page }) => {
        await openWorkspace(page, environment)
        const pane = await openSource(page, 'Source claude generated-missing')
        await expect(pane.getByText(/Source resource unavailable: missing-original\.png;.*404/)).toBeVisible()
        await expect(pane.getByRole('img')).toHaveCount(0)
        expect(environment.hapi.artifacts.requests.filter(value => value.imageId === 'expired-original-registry-id').every(value =>
            value.sessionId === 'source-generated-missing' && value.machineId === 'machine-alpha')).toBe(true)
    })

    test('generated video opens the existing document plugin pane and downloads the exact original bytes', async ({ page }, info) => {
        const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
        try {
            await openWorkspace(page, environment)
            const pane = await openSource(page, 'Source claude generated-video')
            await expect(pane).not.toContainText('Unknown block')
            await pane.getByRole('button', { name: 'Open original media original-video.mp4', exact: true }).click()
            const document = page.locator('.hapi-artifact[data-hapi-artifact-source="source-generated-video"]')
            await expect(document).toBeVisible()
            await expect(document).toContainText('No document preview is available for this file. Download the original file.')
            const waitDownload = page.waitForEvent('download')
            await document.getByRole('button', { name: 'Download original', exact: true }).click()
            const download = await waitDownload
            expect(download.suggestedFilename()).toBe('original-video.mp4')
            expect(await readFile((await download.path())!)).toEqual(videoBytes)
            const reads = environment.hapi.artifacts.requests.filter(value => value.imageId === 'video/opaque-original')
            expect(reads.length).toBeGreaterThanOrEqual(3)
            expect(reads.every(value => value.sessionId === 'source-generated-video' && value.machineId === 'machine-beta' && value.method === 'GET')).toBe(true)
            expect(environment.hapi.artifacts.requests.some(value => value.artifactId === 'video/opaque-original')).toBe(false)
            await expect(page.locator('.hapi-persistence-saved')).toBeVisible()
            const saved = await environment.rpc('hapi/workspaceGet')
            expect(JSON.stringify(saved)).toContain('hapi-generated-media')
            await page.reload(); await expect(document).toBeVisible()
            await expect(document.getByRole('button', { name: 'Download original', exact: true })).toBeEnabled()
            expect(errors).toEqual([])
        } finally {
            await info.attach('original-generated-media-downloads', { body: JSON.stringify({ requests: environment.hapi.artifacts.requests, errors }, null, 2), contentType: 'application/json' })
        }
    })
})
