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
  historyRequests: readonly string[] = []
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
    const long = environment.hapi.add('accept-history', 'Synthetic acceptance fixture', 'machine-alpha')
    long.rows = nativeIndexedHistory(long.session.metadata!.codexSessionId!, 180, 25)
    for (const row of long.rows) {
      const content = row.content as { content?: { data?: { type?: string; message?: string } } }
      if (content.content?.data?.type === 'message') content.content.data.message += '\n\n' + Array(6).fill('Synthetic reading paragraph: continuous history must preserve reader position while new pages arrive. Cached regions remain readable in both directions.').join('\n\n')
    }
    this.historyRequests = useBoundedSourceHistory(long).requests
    environment.hapi.emit({ type: 'session-added', sessionId: long.session.id })
    await expect.poll(async () => {
      const catalog = await environment.rpc<{ sourceDiscovery: { sessions: Array<{ sourceSessionId: string }> } }>('hapi/catalog')
      // Catalog readiness must not preload the test conversations. A first
      // click now measures real on-demand source admission and history work.
      return ['native-alpha', 'native-beta', 'native-warm-history', 'native-accept-history']
        .every(id => catalog.sourceDiscovery.sessions.some(row => row.sourceSessionId === id))
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

  async page(viewport = { width: 1440, height: 900 }, mobile = false): Promise<Page> {
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
    this.context = await this.browser.newContext({ viewport, locale: 'en-US', isMobile: mobile, hasTouch: mobile })
    const followMode = process.env.HAPI_DSH_FOLLOW_EDGE ?? 'marker'
    if (followMode === '0' || followMode === 'off' || followMode === 'setter') {
        // Artifact parity runs keep the stock official behavior; the on/off
        // matrix additionally exercises the setter-equivalent global opt-in.
        await this.context.addInitScript(mode => {
            Reflect.set(globalThis, '__hapiDshFollowEdgeDisabled', true)
            if (mode === 'setter') Reflect.set(globalThis, '__dshFollowProgrammaticEdge', true)
        }, followMode)
    }
    const page = await this.context.newPage()
    page.setDefaultTimeout(20_000)
    return page
  }

  async admit(page: Page): Promise<void> {
    const admission = await page.request.get(this.environment.launchUrl, { maxRedirects: 0 })
    if (admission.status() !== 303) throw new Error(`Warm browser admission failed: ${admission.status()}`)
    await page.goto(`${this.environment.origin}/`)
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
