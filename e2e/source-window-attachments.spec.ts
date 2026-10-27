/** Real pinned Host, official attachment reader, gallery and TurnNavigator.
 * Only original HAPI source rows and media bytes are synthetic fixtures. */
import { test, expect, type Locator, type Page } from '@playwright/test'
import { WarmOfficialSession } from './warm-session.ts'
import { visualReview, conversationReady } from './visual-review.ts'
import { useBoundedSourceHistory } from './source-conversation-fixture.ts'
import { attachmentWindowImages, sourceWindowAttachmentHistory } from './source-window-attachment-fixture.ts'
import type { SourceHistoryOutlineValue } from '../src/source-window-types.ts'

test.setTimeout(180_000)
test.use({ screenshot: 'off' })

interface AttachmentRead { method: string; sessionId: string; attachmentId: string }
interface RpcResult {
  ok: boolean
  value?: { attachment?: { attachmentId: string }; data?: string }
  error?: { code?: string; details?: { reason?: string; sourceCode?: string } }
}

async function readAttachment(page: Page, method: 'session/attachment' | 'hapi/sourceHistoryAttachment',
  request: { sessionId: string; attachmentId: string }): Promise<RpcResult> {
  const response = await page.request.post(new URL(`/api/${method}`, page.url()).href, { data: {
    type: 'client-request', rpcId: `image-acceptance-${crypto.randomUUID()}`, method,
    payload: { args: { request: { sessionId: request.sessionId, attachmentId: request.attachmentId } } },
  } })
  expect(response.ok()).toBe(true)
  return (await response.json() as { result: RpcResult }).result
}

async function decodedImage(pane: Locator, name: string): Promise<{ width: number; height: number }> {
  const image = pane.getByRole('img', { name, exact: true })
  await expect(image).toHaveCount(1)
  await expect(image).toBeVisible()
  await expect.poll(() => image.evaluate(node => {
    const value = node as HTMLImageElement
    return value.complete && value.naturalWidth > 0 && value.naturalHeight > 0
  }), { timeout: 20_000 }).toBe(true)
  const dimensions = await image.evaluate(node => {
    const value = node as HTMLImageElement
    return { width: value.naturalWidth, height: value.naturalHeight, src: value.currentSrc }
  })
  expect(dimensions.src).toMatch(/^blob:/)
  return { width: dimensions.width, height: dimensions.height }
}

/** Generated media is an intermediate official process step before the answer. */
async function revealProcess(pane: Locator, anchorText: string): Promise<void> {
  // The minimap can show the same prompt in its hover preview. Select the
  // transcript turn, which owns the process disclosure we are opening.
  const anchor = pane.locator('[data-chat-turn]').getByText(anchorText, { exact: true })
  await expect(anchor).toHaveCount(1)
  const turn = await anchor.evaluate(node => node.closest('[data-chat-turn]')?.getAttribute('data-chat-turn'))
  expect(turn).toMatch(/^\d+$/)
  const disclosure = pane.locator(`[data-turn-process="${turn}"][aria-expanded="false"]`)
  if (await disclosure.count()) await disclosure.click()
}

/** Scroll only the official virtual rail, then use its ordinary turn button. */
async function navigateOlder(page: Page, pane: Locator, turn: number): Promise<void> {
  const rail = pane.getByRole('navigation', { name: 'Turn navigation', exact: true })
  await expect(rail).toHaveCount(1)
  const target = rail.getByRole('button', { name: new RegExp(`^(?:Load and jump to|Jump to) turn ${turn}$`) })
  for (let attempt = 0; attempt < 40 && await target.count() === 0; attempt += 1) {
    const box = await rail.boundingBox()
    expect(box).not.toBeNull()
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
    await page.mouse.wheel(0, -Math.max(250, box!.height * .75))
    await page.waitForTimeout(80)
  }
  await expect(target).toHaveCount(1)
  await target.click()
}

test('source-window old and latest images decode through authorized official attachment fallback', async ({}, info) => {
  const warm = new WarmOfficialSession()
  const reads: AttachmentRead[] = [], browserPaths: string[] = [], errors: string[] = []
  const decoded: Array<{ phase: string; width: number; height: number }> = []
  const permissions: Record<string, RpcResult> = {}
  let page: Page | undefined
  try {
    await warm.start()
    const environment = warm.environment, history = sourceWindowAttachmentHistory()
    const source = environment.hapi.addObserved('claude', 'attachment-window', 'machine-alpha', { rows: history.rows })
    const other = environment.hapi.addObserved('claude', 'attachment-unrelated', 'machine-beta')
    useBoundedSourceHistory(source)
    for (const image of Object.values(attachmentWindowImages)) environment.hapi.artifacts.setGenerated(source.session.id, image.imageId, image)
    const catalog = await environment.rpc<{ hubId: string }>('hapi/catalog')
    page = await warm.page()
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => {
      if (/event feed subscriber failed|received an update before its start/iu.test(message.text())) errors.push(message.text())
    })
    page.on('request', request => {
      const path = new URL(request.url()).pathname
      browserPaths.push(path)
      if (path !== '/api/session/attachment' && path !== '/api/hapi/sourceHistoryAttachment') return
      const body = request.postDataJSON() as { payload: { args: { request: { sessionId: string; attachmentId: string } } } }
      reads.push({ method: path.slice('/api/'.length), ...body.payload.args.request })
    })
    await warm.admit(page)
    const title = source.session.metadata!.name!
    const trigger = page.locator('.hapi-session-open, .hapi-discovery-open').filter({ has: page.getByText(title, { exact: true }) })
    await expect(trigger).toHaveCount(1)
    await trigger.click()
    const pane = page.getByRole('region', { name: `Pane: ${title}`, exact: true })
    await expect(pane).toHaveCount(1)
    await expect(pane.getByText(history.latestAnswer, { exact: true })).toBeVisible()
    await revealProcess(pane, history.latestAnswer)
    decoded.push({ phase: 'opening-latest', ...await decodedImage(pane, attachmentWindowImages.latest.fileName) })
    await expect(pane.getByRole('img', { name: attachmentWindowImages.old.fileName, exact: true })).toHaveCount(0)
    const sessionId = await pane.getAttribute('data-session-id'), paneId = await pane.getAttribute('data-pane-id')
    expect(sessionId).toBeTruthy(); expect(paneId).toBeTruthy()
    const latestRead = reads.find(read => read.sessionId === sessionId && read.method === 'session/attachment')
    expect(latestRead).toBeDefined()
    expect(reads.some(read => read.sessionId === sessionId && read.method === 'hapi/sourceHistoryAttachment')).toBe(false)
    const composer = pane.locator('[data-composer-input][contenteditable="true"]')
    await expect(composer).toHaveCount(1)
    const editor = await composer.elementHandle()
    expect(editor).not.toBeNull()
    const draft = 'Unsent attachment navigation draft'
    await composer.fill(draft)
    const outline = await environment.rpc<SourceHistoryOutlineValue>('hapi/sourceHistoryOutline', { sessionId })
    const old = outline.entries.find(entry => entry.messageId === history.oldMessageId)
    expect(old, 'the original old image turn must be addressable in the authoritative source outline').toBeDefined()
    await navigateOlder(page, pane, old!.turn)
    await expect(pane.getByText(history.oldPrompt, { exact: true })).toBeInViewport()
    await revealProcess(pane, history.oldPrompt)
    decoded.push({ phase: 'old-source-window', ...await decodedImage(pane, attachmentWindowImages.old.fileName) })
    const fallbackIndex = reads.findIndex(read => read.sessionId === sessionId && read.method === 'hapi/sourceHistoryAttachment')
    expect(fallbackIndex).toBeGreaterThan(0)
    const oldRead = reads[fallbackIndex]!
    expect(oldRead.attachmentId).not.toBe(latestRead!.attachmentId)
    expect(reads.slice(0, fallbackIndex)).toContainEqual({ ...oldRead, method: 'session/attachment' })
    permissions.officialOld = await readAttachment(page, 'session/attachment', oldRead)
    expect(permissions.officialOld).toMatchObject({ ok: false, error: {
      code: 'session/attachment-invalid', details: { reason: 'ATTACHMENT_NOT_REFERENCED' },
    } })
    permissions.grantedOld = await readAttachment(page, 'hapi/sourceHistoryAttachment', oldRead)
    expect(permissions.grantedOld.ok).toBe(true)
    expect(permissions.grantedOld.value?.attachment?.attachmentId).toBe(oldRead.attachmentId)
    // Read the same already-imported bytes through a different live display.
    // The global store contains them, but this window never served their ref.
    const otherDisplay = await environment.rpc<{ sessionId: string }>('hapi/sourceSessionResolve', {
      hubId: catalog.hubId, sourceSessionId: other.session.id,
    })
    await environment.rpc('hapi/sourceHistoryOutline', { sessionId: otherDisplay.sessionId })
    permissions.otherDisplay = await readAttachment(page, 'hapi/sourceHistoryAttachment', {
      sessionId: otherDisplay.sessionId, attachmentId: oldRead.attachmentId,
    })
    expect(permissions.otherDisplay).toMatchObject({ ok: false, error: { details: { sourceCode: 'attachment_not_referenced' } } })
    permissions.originalSourceId = await readAttachment(page, 'hapi/sourceHistoryAttachment', {
      sessionId: source.session.id, attachmentId: oldRead.attachmentId,
    })
    expect(permissions.originalSourceId).toMatchObject({ ok: false, error: { details: { sourceCode: 'source_window_unavailable' } } })
    await pane.getByRole('button', { name: 'Back to bottom', exact: true }).click()
    await expect(pane.getByText(history.latestAnswer, { exact: true })).toBeInViewport()
    await revealProcess(pane, history.latestAnswer)
    decoded.push({ phase: 'return-latest', ...await decodedImage(pane, attachmentWindowImages.latest.fileName) })
    await expect(pane).toHaveAttribute('data-pane-id', paneId!)
    await expect(pane).toHaveAttribute('data-session-id', sessionId!)
    await expect(composer).toHaveText(draft)
    expect(await editor!.evaluate(element => element.isConnected
      && element === element.closest('[data-pane-id]')?.querySelector('[data-composer-input][contenteditable="true"]'))).toBe(true)
    expect(browserPaths.some(path => path.includes('/generated-images/'))).toBe(false)
    expect(environment.hapi.artifacts.requests.filter(request => request.imageId).every(request =>
      request.sessionId === source.session.id && request.machineId === 'machine-alpha' && request.method === 'GET')).toBe(true)
    expect(environment.hapi.artifacts.requests.filter(request => request.imageId).map(request => request.imageId))
      .toEqual(expect.arrayContaining(Object.values(attachmentWindowImages).map(image => image.imageId)))
    expect(environment.hapi.sent).toHaveLength(0)
    expect(errors).toEqual([])
    await editor!.dispose()
    if (process.env.HAPI_DSH_ATTACHMENT_VISUAL === '1') {
      // A fresh official browser is a visual companion to the action evidence.
      // It uses the real fixture and public process disclosure, not a DOM copy.
      const action = `
        const image = [...pane.querySelectorAll('img')].find(node => node.alt === ${JSON.stringify(attachmentWindowImages.latest.fileName)});
        if (!image?.getBoundingClientRect().height) {
          [...pane.querySelectorAll('[data-turn-process][aria-expanded="false"]')].at(-1)?.click();
          return false;
        }
        image.scrollIntoView({block:'center'});
        if (!image.complete || !image.naturalWidth) return false;
      `
      for (const viewport of ['1440x900', '390x844']) {
        const path = await visualReview(warm.environment.launchUrl, 'source-window-latest-image', viewport, conversationReady(title, action))
        if (path) await info.attach(`latest-image-${viewport}`, { path, contentType: 'image/png' })
      }
    }
  } finally {
    // Keep decoded dimensions and permission outcomes; image bytes and launch
    // credentials are unnecessary in the acceptance report.
    await info.attach('source-window-image-evidence', { body: JSON.stringify({ decoded, reads, errors,
      permissions: Object.fromEntries(Object.entries(permissions).map(([key, value]) => [key, {
        ok: value.ok, attachmentId: value.value?.attachment?.attachmentId, error: value.error,
      }])) }, null, 2), contentType: 'application/json' })
    await warm.close()
  }
})
