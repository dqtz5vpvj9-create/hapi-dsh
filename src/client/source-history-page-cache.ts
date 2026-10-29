import type { SourceFrame, SourceFrameBatch } from '../shared/source-frames.ts'
import type { SourceHistoryWindowRequest, SourceHistoryWindowValue } from '../source-window-types.ts'
import { sameSourceFrame } from './source-window-store.ts'

export interface SourceHistoryPageCacheLimits {
  readonly totalBytes: number
  readonly sessionBytes: number
  readonly sessions: number
}

type Page = {
  readonly key: string
  readonly sessionId: string
  readonly historyId: string | undefined
  readonly historyVersion: number | undefined
  readonly request: SourceHistoryWindowRequest
  readonly value: SourceHistoryWindowValue
  readonly framesByKey: ReadonlyMap<string, SourceFrame>
  readonly messageIds: ReadonlySet<string>
  readonly bytes: number
}

function comparePosition(left: { at: number; seq: number }, right: { at: number; seq: number }): number {
  return left.at - right.at || left.seq - right.seq
}

/** Reuse a larger source page for the nearest requested rows at this cursor. */
export function sliceSourceHistoryPage(value: SourceHistoryWindowValue, request: SourceHistoryWindowRequest,
  limit: number): SourceHistoryWindowValue | undefined {
  if (!Number.isInteger(limit) || limit < 1 || request.beforeAt === undefined || request.beforeSeq === undefined) return undefined
  const frames = value.frames
  if (!frames?.length || frames.some(frame => frame.source === undefined)) return undefined
  const cursor = { at: request.beforeAt, seq: request.beforeSeq }
  const groups: SourceFrame[][] = []
  for (const frame of frames) {
    const previous = groups.at(-1)
    if (previous?.[0]?.source?.messageId === frame.source!.messageId) previous.push(frame)
    else groups.push([frame])
  }
  groups.sort((left, right) => comparePosition(left[0]!.source!, right[0]!.source!))
  const eligible = groups.filter(group => comparePosition(group[0]!.source!, cursor) < 0)
  if (!eligible.length) return undefined
  const first = Math.max(0, eligible.length - limit)
  const selected = eligible.slice(first)
  const source = selected[0]![0]!.source!
  return {
    ...value,
    records: [],
    frames: selected.flat(),
    before: { at: source.at, seq: source.seq },
    beforeMessageId: source.messageId,
    hasMoreBefore: first > 0 || value.hasMoreBefore,
    after: null,
    afterMessageId: undefined,
    hasMoreAfter: false,
  }
}

const DEFAULT_LIMITS: SourceHistoryPageCacheLimits = Object.freeze({
  totalBytes: 32 * 1024 * 1024,
  sessionBytes: 8 * 1024 * 1024,
  sessions: 8,
})

/**
 * Reusable source pages are shared by Pane cursors but never by source
 * identity. The cached rows are immutable wire projections; the active
 * SourceWindowStore remains the only owner of display coordinates.
 */
export class SourceHistoryPageCache {
  private readonly pages = new Map<string, Page>()
  private readonly sessionBytes = new Map<string, number>()
  private totalBytes = 0

  constructor(private readonly limits: SourceHistoryPageCacheLimits = DEFAULT_LIMITS) {}

  get(key: string): SourceHistoryWindowValue | undefined {
    const page = this.pages.get(key)
    if (!page) return undefined
    this.pages.delete(key)
    this.pages.set(key, page)
    return page.value
  }

  remember(input: {
    key: string
    sessionId: string
    historyId: string | undefined
    historyVersion: number | undefined
    request: SourceHistoryWindowRequest
    value: SourceHistoryWindowValue
    frames: readonly SourceFrame[]
  }): void {
    const { key, sessionId, historyId, historyVersion, value, frames } = input
    const cachedValue: SourceHistoryWindowValue = { ...value, records: [], frames: [...frames] }
    const encodedBytes = new TextEncoder().encode(JSON.stringify(cachedValue)).byteLength
    this.remove(key)
    if (encodedBytes > this.limits.sessionBytes || encodedBytes > this.limits.totalBytes) return
    const page: Page = {
      key,
      sessionId,
      historyId,
      historyVersion,
      request: { ...input.request },
      value: cachedValue,
      framesByKey: new Map(frames.map(frame => [frame.key, frame])),
      messageIds: new Set(frames.flatMap(frame => frame.source ? [frame.source.messageId] : [])),
      bytes: encodedBytes,
    }
    this.pages.set(key, page)
    this.account(sessionId, encodedBytes)
    this.trim(sessionId)
  }

  /**
   * Return the nearest older slice from any retained page that covers this
   * cursor. This lets a 50-row prefetch satisfy a viewport's 20-row request,
   * then serve later cursors from the unconsumed portion without another RPC.
   */
  getOlder(input: {
    sessionId: string
    historyId: string | undefined
    historyVersion: number | undefined
    request: SourceHistoryWindowRequest
  }): SourceHistoryWindowValue | undefined {
    const { sessionId, historyId, historyVersion, request } = input
    if (request.beforeAt === undefined || request.beforeSeq === undefined) return undefined
    const query = { at: request.beforeAt, seq: request.beforeSeq }
    const candidates = [...this.pages.entries()].reverse()
    for (const [key, page] of candidates) {
      if (page.sessionId !== sessionId || page.historyId !== historyId || page.historyVersion !== historyVersion) continue
      const upper = page.request.beforeAt === undefined || page.request.beforeSeq === undefined
        ? undefined : { at: page.request.beforeAt, seq: page.request.beforeSeq }
      if (!upper || comparePosition(query, upper) > 0) continue
      const pageEpoch = page.request.epoch ?? page.value.epoch
      const queryEpoch = request.epoch ?? page.value.epoch
      if (pageEpoch !== queryEpoch) continue
      if (request.cursorMessageId !== undefined
        && request.cursorMessageId !== page.request.cursorMessageId
        && !page.messageIds.has(request.cursorMessageId)) continue
      const sliced = sliceSourceHistoryPage(page.value, request, request.limit ?? Number.MAX_SAFE_INTEGER)
      if (!sliced) continue
      this.pages.delete(key)
      this.pages.set(key, page)
      return sliced
    }
    return undefined
  }

  /** A history rewrite invalidates its old cursors while preserving an exact same-version cache. */
  retainVersion(sessionId: string, historyId: string | undefined, historyVersion: number | undefined): void {
    for (const [key, page] of this.pages) {
      if (page.sessionId === sessionId && (page.historyId !== historyId || page.historyVersion !== historyVersion)) this.remove(key)
    }
  }

  invalidateSession(sessionId: string): void {
    for (const [key, page] of this.pages) if (page.sessionId === sessionId) this.remove(key)
  }

  /** Revisions and removals invalidate only pages that contain affected source rows. */
  invalidateChanges(sessionId: string, batch: SourceFrameBatch): void {
    if (batch.reset) {
      this.invalidateSession(sessionId)
      return
    }
    const replaced = new Set(batch.replaceSources ?? [])
    const removed = new Set(batch.removeKeys ?? [])
    for (const frame of batch.frames) {
      const prior = this.framesFor(sessionId, frame.key)
      if (prior && !sameSourceFrame(prior, frame)) removed.add(frame.key)
    }
    for (const [key, page] of this.pages) {
      if (page.sessionId !== sessionId) continue
      if ([...page.messageIds].some(id => replaced.has(id)) || [...page.framesByKey.keys()].some(id => removed.has(id))) this.remove(key)
    }
  }

  clear(): void {
    this.pages.clear()
    this.sessionBytes.clear()
    this.totalBytes = 0
  }

  stats(): { totalBytes: number; sessions: number; pages: number; sessionBytes: ReadonlyMap<string, number> } {
    return { totalBytes: this.totalBytes, sessions: this.sessionBytes.size, pages: this.pages.size,
      sessionBytes: new Map(this.sessionBytes) }
  }

  private framesFor(sessionId: string, frameKey: string): SourceFrame | undefined {
    for (const page of this.pages.values()) {
      if (page.sessionId === sessionId) {
        const frame = page.framesByKey.get(frameKey)
        if (frame) return frame
      }
    }
    return undefined
  }

  private account(sessionId: string, amount: number): void {
    this.totalBytes += amount
    const next = (this.sessionBytes.get(sessionId) ?? 0) + amount
    if (next > 0) this.sessionBytes.set(sessionId, next)
    else this.sessionBytes.delete(sessionId)
  }

  private remove(key: string): void {
    const page = this.pages.get(key)
    if (!page) return
    this.pages.delete(key)
    this.account(page.sessionId, -page.bytes)
  }

  private trim(newSessionId: string): void {
    while (this.totalBytes > this.limits.totalBytes
      || (this.sessionBytes.get(newSessionId) ?? 0) > this.limits.sessionBytes
      || this.sessionBytes.size > this.limits.sessions) {
      const overSession = (this.sessionBytes.get(newSessionId) ?? 0) > this.limits.sessionBytes
      const oldest = [...this.pages].find(([, page]) => !overSession || page.sessionId === newSessionId)
      if (!oldest) return
      this.remove(oldest[0])
    }
  }
}
