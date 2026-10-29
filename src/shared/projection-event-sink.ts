/** Request-local event projection and the adapter for an existing live log. */
import {
  adoptSessionEvent, appendPluginRecord, pluginRecordOf, SessionSeq,
  type PluginRecordMap, type Session, type SessionEvent, type SessionEventMap,
  type SessionEventType, type SurfaceEventType, type SurfaceIntent,
} from '@deepseek-ai/dsh-session'
import { SurfaceManager } from '@deepseek-ai/dsh-session/surface'
import { deepFreeze, snapshotJsonValue } from '@deepseek-ai/dsh-util-values'

export interface ProjectionEventSource {
  readonly messageId: string
  readonly at: number
  readonly seq: number
  readonly turnKey?: string
  readonly itemKey: string
}

export interface ProjectionEventSink {
  readonly seq: number
  setSource(source: ProjectionEventSource): void
  append<T extends SessionEventType>(type: T, data: SessionEventMap[T], time: number,
    ...intent: T extends SurfaceEventType ? [SurfaceIntent<T>] : []): SessionEvent<T>
  appendRecord<K extends Extract<keyof PluginRecordMap, `plugin:${string}`>>(type: K, data: PluginRecordMap[K], time: number): SessionEvent
}

/** Writes through the real owner; no replacement Session or lifecycle exists. */
export class SessionProjectionSink implements ProjectionEventSink {
  constructor(readonly session: Session) {}
  get seq(): number { return this.session.seq }
  setSource(_source: ProjectionEventSource): void {}
  append<T extends SessionEventType>(type: T, data: SessionEventMap[T], _time: number,
    ...intent: T extends SurfaceEventType ? [SurfaceIntent<T>] : []): SessionEvent<T> {
    return this.session.append(type, data, ...intent)
  }
  appendRecord<K extends Extract<keyof PluginRecordMap, `plugin:${string}`>>(type: K, data: PluginRecordMap[K], _time: number): SessionEvent {
    const seq = appendPluginRecord(this.session, type, data)
    const event = this.session.eventAt(seq)
    if (!event) throw new Error('The projected source annotation was not committed')
    return event
  }
}

/**
 * Pure bounded-page output. Reuses the pinned DSH event and surface validators,
 * without constructing a Session, store, Agent, Scope or publication channel.
 */
export class HistoryProjectionSink implements ProjectionEventSink {
  private readonly log: SessionEvent[] = []
  private readonly surface = new SurfaceManager(this.log)
  private readonly origins = new Map<number, ProjectionEventSource>()
  private source: ProjectionEventSource | undefined
  get seq(): number { return this.log.length }
  get events(): readonly SessionEvent[] { return this.log }
  get eventSources(): ReadonlyMap<number, ProjectionEventSource> { return this.origins }
  setSource(source: ProjectionEventSource): void { this.source = Object.freeze({ ...source }) }

  append<T extends SessionEventType>(type: T, data: SessionEventMap[T], time: number,
    ...intent: T extends SurfaceEventType ? [SurfaceIntent<T>] : []): SessionEvent<T> {
    // The mapped event union cannot distribute generic T through an object
    // literal; the exact type/data/surface pairing is enforced at this API.
    const event = { type, data, seq: SessionSeq(this.seq), time, ...intent[0] } as SessionEvent<T>
    return this.commit(event)
  }

  appendRecord<K extends Extract<keyof PluginRecordMap, `plugin:${string}`>>(type: K, data: PluginRecordMap[K], time: number): SessionEvent {
    // DSH stores ignorable plugin records in its event log although their
    // extension map intentionally remains outside the released event union.
    const event = { type, data, seq: SessionSeq(this.seq), time, ignorable: true } as unknown as SessionEvent
    if (!pluginRecordOf(event)) throw new Error(`Invalid projected plugin record type: ${type}`)
    return this.commit(event)
  }

  private commit<T extends SessionEvent>(event: T): T {
    const snapshot = snapshotJsonValue(event)
    if (snapshot === undefined) throw new Error('Projected event must be losslessly JSON-serializable')
    const accepted = deepFreeze(adoptSessionEvent(snapshot))
    this.surface.validateNext(accepted)
    this.log.push(accepted)
    if (this.source) this.origins.set(accepted.seq, this.source)
    return accepted
  }
}
