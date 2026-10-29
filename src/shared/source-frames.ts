import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'

/** A source position identifies the original message, never a display coordinate. */
export interface SourceFramePosition {
  messageId: string
  at: number
  seq: number
}

/** Numeric references in a projector frame are transported by source identity. */
export interface SourceFrameReferences {
  surfaceKey?: string | undefined
  sourceEventKeys?: string[] | undefined
  surfaceOp?: { startKey?: string | undefined; endKey?: string | undefined } | undefined
}

/** One official protocol frame, before view-local numeric coordinates are assigned. */
export interface SourceFrame {
  key: string
  source?: SourceFramePosition | undefined
  /** Resource-only updates for an already committed source row. */
  contentRevision?: number | undefined
  turnKey?: string | undefined
  stepKey?: string | undefined
  event: SessionEventLikeEntry['event']
  transient?: true | undefined
  refs?: SourceFrameReferences | undefined
}

export interface SourceFrameBatch {
  kind: 'replace' | 'merge'
  frames: SourceFrame[]
  /** A complete row revision can remove frames emitted by its earlier version. */
  replaceSources?: string[]
  /** Explicitly abandoned transient items need no fabricated source revision. */
  removeKeys?: string[]
  /** A full source rewrite invalidates every resident source page. */
  reset?: true | undefined
  /** Changes only for authoritative history rewrites, never for tail clipping. */
  historyVersion?: number | undefined
  /** Identifies one source read-model lifetime, including across Host restarts. */
  historyId?: string | undefined
  /** Whether the opening bounded source baseline has an older source page. */
  hasMoreBefore?: boolean | undefined
}

/** Split one source-ordered page at message boundaries and return nearest-first
 * batches, so each visible update is an ordinary prepend into the same window. */
export function chunkSourceFramesNearestFirst(frames: readonly SourceFrame[], maxFrames: number): SourceFrame[][] {
  if (!Number.isInteger(maxFrames) || maxFrames < 1) throw new RangeError('maxFrames must be a positive integer')
  const chunks: SourceFrame[][] = []
  let current: SourceFrame[] = []
  for (let index = 0; index < frames.length;) {
    const first = frames[index]!
    const messageId = first.source?.messageId
    let end = index + 1
    while (end < frames.length && frames[end]!.source?.messageId === messageId) end++
    const group = frames.slice(index, end)
    if (current.length && current.length + group.length > maxFrames) {
      chunks.push(current)
      current = []
    }
    if (group.length > maxFrames) {
      for (let offset = 0; offset < group.length; offset += maxFrames) {
        const part = group.slice(offset, offset + maxFrames)
        if (current.length) { chunks.push(current); current = [] }
        chunks.push(part)
      }
    } else current.push(...group)
    index = end
  }
  if (current.length) chunks.push(current)
  return chunks.reverse()
}

export const SOURCE_FRAME_EVENT = 'plugin:hapi-dsh/source-window' as const

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    'plugin:hapi-dsh/source-window': SourceFrameBatch
  }
}


/** Source cursor used to distinguish real paging from folded DOM changes. */
export interface SourceWindowProgress {
  before: { at: number; seq: number } | null
  /** The last interactive prefix read failed; the committed source window is unchanged. */
  pagingError?: true | undefined
  historyId?: string | undefined
  historyVersion?: number | undefined
}
