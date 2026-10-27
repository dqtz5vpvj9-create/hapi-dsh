import type { SessionFollowFrame } from '@deepseek-ai/dsh-api-session-controller/types'

export const SOURCE_FOLLOW_MAX_EVENTS = 1_000
export const SOURCE_FOLLOW_MAX_BYTES = 4 * 1024 * 1024

export interface SourceFollowBudget {
  readonly maxEvents?: number
  readonly maxBytes?: number
}

const utf8 = new TextEncoder()
function bytes(value: unknown): number { return utf8.encode(JSON.stringify(value)).length }

/** Rotate only this follow generation after complete frames. rc.3 classifies
 * an accepted generation's normal end as retryable, then installs a fresh
 * snapshot in the same ClientSession. A second snapshot in one generation is
 * invalid, and mutating the Client event feed would leave its cursor and
 * Assistant settlement state stale. The official opener owns the next atomic
 * journal/projection/Assistant cut and its subscription cleanup. */
export async function* boundedSourceFollow(
  source: AsyncIterable<SessionFollowFrame>, budget: SourceFollowBudget = {},
): AsyncIterable<SessionFollowFrame> {
  const maxEvents = budget.maxEvents ?? SOURCE_FOLLOW_MAX_EVENTS
  const maxBytes = budget.maxBytes ?? SOURCE_FOLLOW_MAX_BYTES
  let events = 0
  let liveBytes = 0
  for await (const frame of source) {
    if (frame.type === 'snapshot') {
      // The official opening owns Turn/Step/process context and the complete
      // active Assistant baseline. Its message count is not a byte hard cap:
      // an oversized whole turn/output stays intact rather than clipping it.
      yield frame
      continue
    }
    events++
    liveBytes += bytes(frame)
    yield frame
    // The opening itself never causes an immediate reopen loop, including a
    // whole oversized output or an active Assistant stream above the budget.
    if (events >= maxEvents || liveBytes >= maxBytes) return
  }
}
