import type { NativeUsage } from '../codex/observation-types.ts'
import type { ObservedUsage } from '../hapi-agent/projection-types.ts'

export interface SourceUsageModel {
    scope: 'session' | 'reported'
    input: number
    output: number
    cached: number | null
    cacheWrite: number | null
    total: number | null
    cacheHit: number | null
    contextTokens: number
    contextWindow: number | null
    contextPercent: number | null
}

/** Use source counters only. Adapted chat steps and event arrival times are not
 * native turns, LLM steps, or decode timings. */
export function sourceUsageModel(native: NativeUsage | null | undefined, observed: ObservedUsage | null | undefined): SourceUsageModel | null {
    const usage = native ?? observed
    if (!usage) return null
    const counts = native?.total ?? usage
    const includesCache = native ? true : observed?.inputIncludesCache
    const cacheWrite = native ? null : observed?.cacheCreationTokens ?? null
    // Older observed snapshots do not say whether cache is already included.
    // Show their raw input/output, but do not invent a total or a hit ratio.
    const input = includesCache === undefined ? null
        : counts.inputTokens + (includesCache ? 0 : (counts.cachedInputTokens ?? 0) + (cacheWrite ?? 0))
    return {
        scope: native?.total ? 'session' : 'reported',
        input: counts.inputTokens, output: counts.outputTokens, cached: counts.cachedInputTokens, cacheWrite,
        total: input === null ? null : input + counts.outputTokens,
        cacheHit: input !== null && input > 0 && counts.cachedInputTokens !== null
            ? Math.round(counts.cachedInputTokens / input * 100) : null,
        contextTokens: usage.contextTokens, contextWindow: usage.contextWindow,
        contextPercent: usage.contextWindow === null ? null : Math.round(usage.contextTokens / usage.contextWindow * 100),
    }
}

export function formatSourceTokens(value: number): string {
    const [scale, suffix] = value >= 1e9 ? [1e9, 'B'] : value >= 1e6 ? [1e6, 'M'] : value >= 1e3 ? [1e3, 'K'] : [1, '']
    return `${Number((value / scale).toFixed(1))}${suffix}`
}
