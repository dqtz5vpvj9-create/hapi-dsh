import type { Page } from '@playwright/test'
import { installColdOpeningObserver, type ColdOpeningOptions, type ColdOpeningResult } from '../scripts/cold-opening-observer.mjs'
export { coldOpeningIssues } from '../scripts/cold-opening-observer.mjs'

/** Register before navigation; application startup is part of the measurement. */
export async function installColdOpeningProbe(page: Page, options: ColdOpeningOptions): Promise<void> {
    await page.addInitScript({ content: `(${installColdOpeningObserver.toString()})(${JSON.stringify(options)})` })
}

export async function readColdOpeningProbe(page: Page, stop = false): Promise<ColdOpeningResult> {
    return page.evaluate(stop => {
        const probe = window.__hapiColdOpening
        if (stop) probe.stop()
        return { first: probe.first, states: probe.states, titles: probe.titles, tasks: probe.tasks,
            current: probe.current, startedAt: probe.startedAt, stoppedAt: probe.stoppedAt,
            verifiedFreshness: probe.verifiedFreshness, verifiedTitle: probe.verifiedTitle, stableMs: probe.stableMs }
    }, stop)
}
