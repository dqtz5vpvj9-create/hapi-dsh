/** Optional CPU evidence for the synthetic shared-graph acceptance harness. */
import type { Page, TestInfo } from '@playwright/test'

interface ProfileNode {
    id: number
    callFrame: { functionName: string; scriptId: string; url: string; lineNumber: number; columnNumber: number }
    children?: number[]
}
interface CpuProfile { nodes: ProfileNode[]; samples?: number[]; timeDeltas?: number[]; startTime: number; endTime: number }
interface Metrics { metrics: Array<{ name: string; value: number }> }

const round = (value: number) => Math.round(value * 1000) / 1000
const safeUrl = (value: string): string => {
    if (!value) return ''
    try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.pathname : url.protocol }
    catch { return value.replace(/[?#].*$/u, '') }
}

function summarize(profile: CpuProfile) {
    const nodes = new Map(profile.nodes.map(node => [node.id, node]))
    const parents = new Map<number, number>()
    for (const node of profile.nodes) for (const child of node.children ?? []) parents.set(child, node.id)
    const self = new Map<number, number>(), inclusive = new Map<number, number>()
    for (const [index, id] of (profile.samples ?? []).entries()) {
        const time = (profile.timeDeltas?.[index] ?? 0) / 1000
        self.set(id, (self.get(id) ?? 0) + time)
        let cursor: number | undefined = id
        while (cursor !== undefined) { inclusive.set(cursor, (inclusive.get(cursor) ?? 0) + time); cursor = parents.get(cursor) }
    }
    const top = (values: Map<number, number>) => [...values].sort((left, right) => right[1] - left[1]).slice(0, 35).map(([id, ms]) => {
        const frame = nodes.get(id)!.callFrame
        return { function: frame.functionName || '(anonymous)', url: safeUrl(frame.url), line: frame.lineNumber + 1, ms: round(ms) }
    })
    return { durationMs: round((profile.endTime - profile.startTime) / 1000), samples: profile.samples?.length ?? 0,
        gcMs: round([...self].reduce((sum, [id, ms]) => sum + (nodes.get(id)?.callFrame.functionName === '(garbage collector)' ? ms : 0), 0)),
        self: top(self), inclusive: top(inclusive) }
}

/** Profiling changes timing; use its results for attribution, not acceptance. */
export async function startOneGraphProfile(page: Page): Promise<(info: TestInfo) => Promise<void>> {
    if (process.env.HAPI_DSH_E2E_PROFILE !== '1') return async () => {}
    const cdp = await page.context().newCDPSession(page)
    let sent = 0, received = 0, requests = 0
    cdp.on('Network.webSocketFrameSent', () => { sent++ })
    cdp.on('Network.webSocketFrameReceived', () => { received++ })
    cdp.on('Network.requestWillBeSent', () => { requests++ })
    await cdp.send('Network.enable')
    await cdp.send('Performance.enable')
    const before = await cdp.send('Performance.getMetrics') as Metrics
    const browser = await cdp.send('Browser.getVersion') as { product: string; revision: string; jsVersion: string }
    await cdp.send('Profiler.enable')
    await cdp.send('Profiler.setSamplingInterval', { interval: 1000 })
    await cdp.send('Profiler.start')
    let stopped = false
    return async info => {
        if (stopped) return
        stopped = true
        try {
            const { profile } = await cdp.send('Profiler.stop') as { profile: CpuProfile }
            const after = await cdp.send('Performance.getMetrics') as Metrics
            const previous = new Map(before.metrics.map(metric => [metric.name, metric.value]))
            const metricDeltas = Object.fromEntries(after.metrics.filter(metric => ['ScriptDuration', 'TaskDuration', 'LayoutDuration', 'RecalcStyleDuration', 'LayoutCount', 'RecalcStyleCount'].includes(metric.name))
                .map(metric => [metric.name, round(metric.value - (previous.get(metric.name) ?? 0))]))
            const summary = { browser, ...summarize(profile), metricDeltas, transport: { requests, framesSent: sent, framesReceived: received } }
            await info.attach('one-graph-cpu-summary', { body: JSON.stringify(summary, null, 2), contentType: 'application/json' })
            // Keep script paths useful for source lookup, excluding query tokens.
            const sanitized = { ...profile, nodes: profile.nodes.map(node => ({ ...node, callFrame: { ...node.callFrame, url: safeUrl(node.callFrame.url) } })) }
            await info.attach('one-graph-cpu-profile', { body: JSON.stringify(sanitized), contentType: 'application/json' })
        } finally { await cdp.detach() }
    }
}
