/** Browser-owned clocks: automation waits never count as product latency. */
import type { Page } from '@playwright/test'

export interface UiSample {
  frames: number[]
  tasks: number[]
  anchorOffsets: number[]
  missingAnchors: number
  nodes: number
  longTasks?: Array<{ start: number; duration: number; container: string }>
  marks?: Array<{ name: string; start: number }>
}
declare global {
  interface Window {
    __hapiUiProbe: {
      sample: UiSample; active: boolean; start: number; loadedChunks: string[]
      anchor?: { row: Element; port: Element; offset: number }
      begin(): void; end(): UiSample
    }
  }
}

export async function installUiProbe(page: Page): Promise<void> {
  const install = () => {
    const empty = () => ({ frames: [] as number[], tasks: [] as number[], anchorOffsets: [] as number[], missingAnchors: 0, nodes: 0 })
    const probe: Window['__hapiUiProbe'] = {
      sample: empty(), active: false, start: 0, loadedChunks: [],
      begin() { this.sample = empty(); this.sample.longTasks = []; this.sample.marks = []; this.active = true; this.start = performance.now(); delete this.anchor },
      end() {
        this.active = false
        this.sample.nodes = document.querySelectorAll('*').length
        this.sample.marks = performance.getEntriesByType('mark')
          .filter(entry => entry.startTime >= this.start && /hapi-dsh:/.test(entry.name))
          .map(entry => ({ name: entry.name.slice(0, 80), start: Math.round(entry.startTime - this.start) }))
        return this.sample
      },
    }
    window.__hapiUiProbe = probe
    // Keep only the two lazy assets, independent of the browser's 250-entry
    // resource timing buffer during a long interaction/streaming run.
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        const path = new URL(entry.name).pathname
        if (/client\.(voice|capture)\.js$/.test(path) && !probe.loadedChunks.includes(path)) probe.loadedChunks.push(path)
      }
    }).observe({ type: 'resource', buffered: true })
    new PerformanceObserver(list => {
      if (probe.active) for (const row of list.getEntries()) {
        if (row.startTime < probe.start) continue
        probe.sample.tasks.push(row.duration)
        const attribution = (row as PerformanceEntry & { attribution?: Array<{ containerType?: string; containerName?: string }> }).attribution
        probe.sample.longTasks?.push({
          start: Math.round(row.startTime - probe.start),
          duration: Math.round(row.duration),
          container: `${attribution?.[0]?.containerType ?? '?'}:${(attribution?.[0]?.containerName ?? '').slice(0, 40)}`,
        })
      }
    }).observe({ type: 'longtask', buffered: true })
    let previous = 0
    const frame = (at: number) => {
      if (probe.active) {
        if (previous >= probe.start) probe.sample.frames.push(at - previous)
        const a = probe.anchor
        if (a) {
          if (!a.row.isConnected) probe.sample.missingAnchors++
          else probe.sample.anchorOffsets.push(a.row.getBoundingClientRect().top - a.port.getBoundingClientRect().top - a.offset)
        }
      }
      previous = at; requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
  }
  // tsx preserves function names with this helper when serializing callbacks.
  // Keep it inside the test realm, before any probe/evaluate callback executes.
  await page.addInitScript({ content: `globalThis.__name = value => value; (${install.toString()})()` })
}

export function percentile(values: readonly number[], p: number): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]!
}

/** Two paints after the action; sampling includes the frame which performed it. */
export async function paint(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}
