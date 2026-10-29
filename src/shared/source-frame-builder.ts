import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionEventSource } from './projection-event-sink.ts'
import type { SourceFrame, SourceFrameReferences } from './source-frames.ts'

export interface ProjectionFrameInput {
  readonly events: readonly SessionEvent[]
  readonly eventSources: ReadonlyMap<number, ProjectionEventSource>
  readonly turnAnchors?: ReadonlyMap<number, { readonly id: string; readonly at: number; readonly seq: number; readonly key: string | null }>
  readonly stepAnchors?: ReadonlyMap<string, { readonly turn: number; readonly step: number }>
}

const identity = (...parts: string[]): string => JSON.stringify(parts)
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined

/**
 * Remove projector-local coordinate identity at the Host boundary. Keys name
 * the original source item/turn/step; a page and a live fold can assign entirely
 * different local numbers while still describing the exact same frames.
 */
export function toSourceFrames(input: ProjectionFrameInput): SourceFrame[] {
  const turns = new Map<number, string>()
  const steps = new Map<string, string>()
  const itemTurns = new Map<string, number>()
  for (const [turn, anchor] of input.turnAnchors ?? []) {
    // A clipped observed turn without its invoked input has no source-owned
    // turn identity. Leave it unassigned instead of inventing a page ordinal.
    if (anchor.key !== null) turns.set(turn, identity('source-turn', anchor.key))
  }
  for (const [key, position] of input.stepAnchors ?? []) steps.set(`${position.turn}:${position.step}`, identity('source-step', key))
  for (const event of input.events) {
    const source = input.eventSources.get(event.seq)
    if (!source) throw new Error(`Source origin is missing for projected event ${event.seq}`)
    const data = record(event.data)
    const turn = typeof data?.turn === 'number' ? data.turn : typeof data?.displayTurn === 'number' ? data.displayTurn : undefined
    if (turn === undefined) continue
    itemTurns.set(source.itemKey, turn)
    if (source.turnKey !== undefined) turns.set(turn, identity('native-turn', source.turnKey))
  }
  const frames = input.events.map((event): SourceFrame => {
    const source = input.eventSources.get(event.seq)!
    const data = record(event.data)
    const turn = typeof data?.turn === 'number' ? data.turn : typeof data?.displayTurn === 'number' ? data.displayTurn : itemTurns.get(source.itemKey)
    const step = typeof data?.step === 'number' ? data.step : typeof data?.displayStep === 'number' ? data.displayStep : undefined
    const turnKey = source.turnKey === undefined ? turn === undefined ? undefined : turns.get(turn) : identity('native-turn', source.turnKey)
    const stepKey = turn === undefined || step === undefined ? undefined : steps.get(`${turn}:${step}`)
    const message = event.type === 'user/message' ? data : record(data?.message)
    const messageId = typeof message?.id === 'string' ? message.id : undefined
    const key = event.type === 'user/message' ? identity('source-user', source.itemKey)
      : (event.type === 'turn/start' || event.type === 'turn/end') && turnKey !== undefined
      ? identity('turn', turnKey, event.type)
      : (event.type === 'step/start' || event.type === 'step/end' || event.type === 'tool/call') && stepKey !== undefined
        ? identity('step', stepKey, event.type)
        : messageId !== undefined ? identity('message', event.type, messageId)
          : identity('item', source.itemKey, event.type)
    return { key, source: { messageId: source.messageId, at: source.at, seq: source.seq },
      ...(turnKey === undefined ? {} : { turnKey }), ...(stepKey === undefined ? {} : { stepKey }),
      event: event as unknown as SourceFrame['event'] }
  })
  const keys = new Map(input.events.map((event, index) => [Number(event.seq), frames[index]!.key]))
  const keyAt = (seq: number): string => {
    const key = keys.get(seq)
    if (key === undefined) throw new Error(`A projected source reference ${seq} is outside its event input`)
    return key
  }
  for (const [index, event] of input.events.entries()) {
    const data = record(event.data), refs: SourceFrameReferences = {}
    if (typeof data?.surfaceSeq === 'number') refs.surfaceKey = keyAt(data.surfaceSeq)
    if (event.sourceEventSeqs !== undefined) refs.sourceEventKeys = event.sourceEventSeqs.map(keyAt)
    if (event.surfaceOp !== undefined && typeof event.surfaceOp === 'object') {
      refs.surfaceOp = { startKey: keyAt(event.surfaceOp.startSeq), endKey: keyAt(event.surfaceOp.endSeq) }
    }
    if (Object.keys(refs).length) frames[index]!.refs = refs
  }
  return frames
}
