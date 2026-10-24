/** Trusted desktop wheel input against the real official Conversation, with
 * bounded synthetic source history. The delayed page is a browser-route gate,
 * never a mutation or a probe against a production conversation. */
import { test, expect, type Page } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { WarmOfficialSession } from './warm-session.ts'
import { visualReview, conversationReady } from './visual-review.ts'

type Reading = { at: number; retained: boolean; offset: number; documentTop: number;
  scrollTop: number; height: number; controlDisabled: boolean | undefined }
type Probe = { row: HTMLElement; port: HTMLElement; key: string; active: boolean; samples: Reading[];
  wheels: Array<{ at: number; deltaY: number; trusted: boolean; top: number }>;
  history: Array<{ at: number; type: string; detail: string | null; sessionPages: number }>; stop(): void }

let warm: WarmOfficialSession
test.beforeAll(async () => {
  warm = new WarmOfficialSession(); await warm.start()
  // A wide desktop wraps the same message into fewer lines than mobile. Keep
  // each incoming page tall enough to distinguish an entire-page jump from a
  // small reading offset, without enlarging the bounded source row count.
  for (const row of warm.environment.hapi.require('native-accept-history').rows) {
    const envelope = row.content as { content?: { data?: { type?: string; message?: string } } }
    if (envelope.content?.data?.type === 'message') envelope.content.data.message += '\n\n'
      + Array(8).fill('Synthetic desktop reading paragraph: older pages must arrive above this retained message without changing the reader position.').join('\n\n')
  }
})
test.afterAll(async () => { await warm?.close() })
test.use({ screenshot: 'off', trace: { mode: 'retain-on-failure', snapshots: false } })

async function read(page: Page): Promise<Reading> {
  return page.evaluate(() => {
    const { row, port, key } = Reflect.get(window, '__desktopHistory') as Probe
    const offset = row.getBoundingClientRect().top - port.getBoundingClientRect().top
    return { at: performance.now(), retained: row.isConnected && port.contains(row) && row.dataset.chatAnchorKey === key,
      offset, documentTop: offset + port.scrollTop, scrollTop: port.scrollTop, height: port.scrollHeight,
      controlDisabled: port.querySelector<HTMLButtonElement>('[data-chat-flow]:not([data-step-process-content]) > div > button')?.disabled }
  })
}

for (const phase of ['automatic continued wheel', 'manual continued wheel', 'manual reverse'] as const) {
  test(`desktop history ${phase}: delayed prepend retains the reader instead of skipping to the new page top`, async ({}, info) => {
    test.setTimeout(120_000)
    const manual = phase.startsWith('manual'), reverse = phase === 'manual reverse'
    const page = await warm.page({ width: 1440, height: 900 })
    await warm.admit(page)
    await page.locator('.hapi-session-open').filter({ hasText: 'Native Codex accept-history' }).click()
    const pane = page.getByRole('region', { name: 'Pane: Native Codex accept-history', exact: true })
    await expect(pane.getByText('Synthetic final answer 180.', { exact: false })).toBeVisible()
    const port = pane.locator('[data-conversation-scroll]')
    const older = pane.locator('[data-chat-flow]:not([data-step-process-content]) > div > button').first()
    const box = (await port.boundingBox())!
    await page.mouse.move(box.x + box.width * .55, box.y + box.height * .4)
    // Establish reading mode with one ordinary trusted input, then position the
    // fixture near its retained boundary. Only the following small wheel events
    // trigger/interfere with paging; no giant wheel delta simulates that race.
    await page.mouse.wheel(0, -120)
    await page.waitForTimeout(300)
    await expect(older).toBeEnabled()
    await port.evaluate((element, top) => { element.scrollTop = top }, manual ? 0 : 320)
    await expect.poll(() => port.evaluate(element => element.scrollTop)).toBe(manual ? 0 : 320)
    // Programmatic fixture placement is deliberately not a paging gesture.
    // Wait out the controller's restore/jump quiet period before real input.
    await page.waitForTimeout(450)
    let requested = false, released = false, release!: () => void, requestDelayMs = 0
    const gate = new Promise<void>(resolve => { release = () => { released = true; resolve() } })
    await page.route('**/api/session/page', async route => {
      if (!route.request().postData()?.includes('"beforeSeq"') || requested) return route.continue()
      requested = true
      const started = Date.now()
      await Promise.all([delay(600), gate])
      requestDelayMs = Date.now() - started
      await route.continue()
    })
    await port.evaluate(element => {
      const port = element as HTMLElement
      const row = [...port.querySelectorAll<HTMLElement>('[data-chat-flow]:not([data-step-process-content]) [data-chat-anchor-key]')]
        .find(row => !row.closest('[hidden]') && row.dataset.chatAnchorKey)
      if (!row) throw new Error('The retained history needs an identifiable first row')
      const wheel = (event: WheelEvent) => probe.wheels.push({ at: performance.now(), deltaY: event.deltaY, trusted: event.isTrusted, top: port.scrollTop })
      const history = (event: Event) => {
        const detail = (event as CustomEvent).detail
        probe.history.push({ at: performance.now(), type: detail.type, detail: detail.detail, sessionPages: detail.sessionPages })
      }
      const probe: Probe = { row, port, key: row.dataset.chatAnchorKey!, active: true, samples: [], wheels: [], history: [],
        stop() { probe.active = false; port.removeEventListener('wheel', wheel); window.removeEventListener('hapi-dsh:seamless-history', history) } }
      Reflect.set(window, '__desktopHistory', probe)
      port.addEventListener('wheel', wheel, { passive: true })
      window.addEventListener('hapi-dsh:seamless-history', history)
      const sample = () => {
        if (!probe.active) return
        const offset = row.getBoundingClientRect().top - port.getBoundingClientRect().top
        probe.samples.push({ at: performance.now(), retained: row.isConnected && port.contains(row) && row.dataset.chatAnchorKey === probe.key,
          offset, documentTop: offset + port.scrollTop, scrollTop: port.scrollTop, height: port.scrollHeight,
          controlDisabled: port.querySelector<HTMLButtonElement>('[data-chat-flow]:not([data-step-process-content]) > div > button')?.disabled })
        requestAnimationFrame(sample)
      }
      requestAnimationFrame(sample)
    })
    let edge: Reading | undefined, before: Reading | undefined, after: Reading | undefined, primaryFailure: unknown
    try {
      if (manual) await older.click()
      else await page.mouse.wheel(0, -80)
      await expect.poll(() => requested).toBe(true)
      await expect(older).toBeDisabled()
      // Reach the old top with bounded wheel input while its next page remains
      // blocked, then keep scrolling over the visible loading control.
      for (let step = 0; step < 10 && await port.evaluate(element => element.scrollTop) > 0; step++) {
        await page.mouse.wheel(0, -60)
        await page.waitForTimeout(30)
      }
      await expect.poll(() => port.evaluate(element => element.scrollTop)).toBe(0)
      const loading = (await older.boundingBox())!
      await page.mouse.move(loading.x + loading.width / 2, loading.y + loading.height / 2)
      for (let step = 0; step < 6; step++) { await page.mouse.wheel(0, -45); await page.waitForTimeout(35) }
      edge = await read(page)
      expect(edge.scrollTop).toBe(0)
      if (reverse) {
        await page.mouse.move(box.x + box.width * .55, box.y + box.height * .4)
        for (let step = 0; step < 4; step++) { await page.mouse.wheel(0, 50); await page.waitForTimeout(35) }
        await expect.poll(() => port.evaluate(element => element.scrollTop)).toBeGreaterThan(100)
      }
      // Let the final wheel's native movement settle before recording its exact
      // position, while the same older request is still held at the route gate.
      await page.waitForTimeout(100)
      before = await read(page)
      expect(before.controlDisabled).toBe(true)
      if (reverse) {
        expect(before.scrollTop).toBeGreaterThan(100)
        expect(Math.abs(before.documentTop - edge.documentTop)).toBeLessThanOrEqual(2)
      } else expect(before.scrollTop).toBe(0)
      release()
      await expect.poll(() => port.evaluate(element => element.scrollHeight)).toBeGreaterThan(before!.height + 1000)
      await page.waitForTimeout(80)
      after = await read(page)
      const probe = await page.evaluate(() => {
        const p = Reflect.get(window, '__desktopHistory') as Probe
        return { wheels: p.wheels, history: p.history, samples: p.samples }
      })
      expect(probe.wheels.filter(wheel => wheel.deltaY < 0).length).toBeGreaterThanOrEqual(6)
      expect(probe.wheels.every(wheel => wheel.trusted), 'all scroll interference must be real browser wheel input').toBe(true)
      expect(after.retained, 'compare the same old first DOM row, not a newly visible replacement').toBe(true)
      expect(after.documentTop - before.documentTop, 'older rows must actually be prepended').toBeGreaterThan(1000)
      expect(Math.abs(after.offset - before.offset), 'the arriving page must preserve the reading position instead of jumping to its new top').toBeLessThanOrEqual(2)
      expect(Math.abs((after.scrollTop - before.scrollTop) - (after.documentTop - before.documentTop))).toBeLessThanOrEqual(2)
      const commitFrames = probe.samples.filter(sample => sample.at >= before!.at && sample.at <= after!.at)
      expect(commitFrames.length, 'sample the loading-to-prepend transition, not only its final position').toBeGreaterThan(0)
      expect(commitFrames.every(sample => sample.retained)).toBe(true)
      expect(Math.max(...commitFrames.map(sample => Math.abs(sample.offset - before!.offset))), 'no intermediate rendered frame may jump away and then recover').toBeLessThanOrEqual(2)
      if (manual) expect(probe.history.filter(event => event.type === 'requested'), 'observing manual loading must not issue another request').toHaveLength(0)
    } catch (error) {
      primaryFailure = error
      throw error
    } finally {
      if (!released) release()
      after ??= await read(page)
      const diagnostics = await page.evaluate(() => {
        const p = Reflect.get(window, '__desktopHistory') as Probe; p.stop()
        return { key: p.key, samples: p.samples, wheels: p.wheels, history: p.history }
      })
      const directory = process.env.HAPI_DSH_VISUAL_DIR ?? '/mnt/cache/data-cache/hapi-dsh-visual-review'
      await mkdir(directory, { recursive: true })
      const label = phase.replaceAll(' ', '-'), path = `${directory}/desktop-history-${label}-${Date.now()}.json`
      await writeFile(path, JSON.stringify({ phase, requestDelayMs, edge, before, after, ...diagnostics }))
      await info.attach('desktop-history-motion', { path, contentType: 'application/json' })
      try {
        await page.unrouteAll({ behavior: 'wait' }); await page.close()
        const shot = await visualReview(warm.environment.launchUrl, `desktop-history-${label}`, '1440x900', conversationReady('Native Codex accept-history',
          `if (port.querySelector('[data-chat-flow]:not([data-step-process-content]) > div > button')?.disabled) return false;`))
        if (shot) await info.attach('desktop-history-visual', { path: shot, contentType: 'image/png' })
      } catch (error) {
        if (!primaryFailure) throw error
        await info.attach('desktop-history-cleanup-error', { body: String(error), contentType: 'text/plain' })
      }
    }
  })
}
