/** Persistent development fixture: real pinned DSH Host, explicit synthetic HAPI sources. */
import { chromium, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { initialWorkspace } from '../src/client/model.ts'
import { startOfficialEnvironment, type OfficialEnvironment } from './official-runtime.ts'
import { acknowledgePreviewNotice } from './preview-notice.ts'
import { nativeIndexedHistory, useBoundedSourceHistory } from './source-conversation-fixture.ts'

export interface WarmStatus {
  pid: number
  origin: string
  startedAt: string
  hostStarts: number
  browserStarts: number
  checks: number
  coldHostMs: number
}

/** One owner for Host/browser lifetime. Each check gets clean browser storage and layout. */
export class WarmOfficialSession {
  private browser: Browser | undefined
  private context: BrowserContext | undefined
  private environmentValue: OfficialEnvironment | undefined
  private hostStarts = 0
  private browserStarts = 0
  private checks = 0
  private coldHostMs = 0
  private startedAt = new Date().toISOString()
  constructor(private readonly headed = false) {}

  get environment(): OfficialEnvironment {
    if (!this.environmentValue) throw new Error('The warm official fixture is not ready')
    return this.environmentValue
  }

  async start(): Promise<void> {
    if (this.environmentValue) return
    const started = performance.now()
    const environment = await startOfficialEnvironment()
    this.environmentValue = environment
    this.hostStarts++
    const history = environment.hapi.add('warm-history', 'Synthetic warm fixture', 'machine-alpha')
    // Below the 200-row source tail: this checks the official retained turn
    // window without a background full-history generation replacement.
    history.rows = nativeIndexedHistory(history.session.metadata!.codexSessionId!, 70, 1)
    useBoundedSourceHistory(history)
    environment.hapi.emit({ type: 'session-added', sessionId: history.session.id })
    await expect.poll(async () => {
      const catalog = await environment.rpc<{ sessions: Array<{ hapiSessionId: string }> }>('hapi/catalog')
      return ['native-alpha', 'native-beta', 'native-warm-history'].every(id => catalog.sessions.some(row => row.hapiSessionId === id))
    }, { timeout: 30_000 }).toBe(true)
    this.coldHostMs = Math.round(performance.now() - started)
  }

  status(): WarmStatus {
    return { pid: process.pid, origin: this.environment.origin, startedAt: this.startedAt, hostStarts: this.hostStarts,
      browserStarts: this.browserStarts, checks: this.checks, coldHostMs: this.coldHostMs }
  }

  /** Developer tooling may obtain admission only through the private local socket. Never log it. */
  connection(): { launchUrl: string; origin: string } {
    return { launchUrl: this.environment.launchUrl, origin: this.environment.origin }
  }

  async page(): Promise<Page> {
    if (!this.browser) {
      this.browser = await chromium.launch({ headless: !this.headed,
        ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) })
      this.browserStarts++
    }
    await this.context?.close()
    this.context = undefined
    // All previous browser views are closed before the revision-checked reset;
    // no running client can race a synthetic workspace write.
    const document = await this.environment.rpc<{ revision: number }>('hapi/workspaceGet')
    let serial = 0
    const state = initialWorkspace(() => `warm-layout-${++serial}`)
    const result = await this.environment.rpc<{ status: string }>('hapi/workspacePut', {
      expectedRevision: document.revision, operationId: `warm-reset-${crypto.randomUUID()}`, state,
    })
    if (result.status !== 'applied') throw new Error('Warm fixture layout reset conflicted')
    this.context = await this.browser.newContext({ viewport: { width: 1536, height: 1000 }, locale: 'en-US' })
    const page = await this.context.newPage()
    page.setDefaultTimeout(20_000)
    return page
  }

  async admit(page: Page): Promise<void> {
    const admission = await page.request.get(this.environment.launchUrl, { maxRedirects: 0 })
    if (admission.status() !== 303) throw new Error(`Warm browser admission failed: ${admission.status()}`)
    await page.goto(`${this.environment.origin}/?hapiGraph=shared`)
    await expect(page.locator('[data-hapi-workspace]')).toBeVisible({ timeout: 45_000 })
    await acknowledgePreviewNotice(page, this.environment)
  }

  async currentPage(): Promise<Page | undefined> { return this.context?.pages()[0] }
  checked(): void { this.checks++ }

  async restart(): Promise<void> {
    await this.context?.close(); this.context = undefined
    await this.environmentValue?.close(); this.environmentValue = undefined
    await this.start()
  }

  async close(): Promise<void> {
    await this.context?.close(); this.context = undefined
    await this.browser?.close(); this.browser = undefined
    await this.environmentValue?.close(); this.environmentValue = undefined
  }
}
