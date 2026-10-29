import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SourceFrameBatch } from '../src/shared/source-frames.ts'

/** Read the actual canonical body, separate from the operation Session log. */
export function projectedSourceEvents(agent: { sourceFrameBaseline(): SourceFrameBatch }): readonly SessionEvent[] {
  return agent.sourceFrameBaseline().frames.map(frame => frame.event) as readonly SessionEvent[]
}
