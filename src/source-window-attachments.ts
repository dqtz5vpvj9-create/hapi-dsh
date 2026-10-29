/**
 * Bounded, session-isolated authorization index for source-history images.
 *
 * The official `session/attachment` endpoint authorizes an image only when the
 * display Session log references it. Source-history pages and live body frames
 * use a pure projection, so their image refs are not in the operation log even
 * though the bytes were already imported into the official attachment store.
 * This index records exactly the image refs that one bounded source window
 * served to one authorized display, and nothing else.
 *
 * It never scans the attachment store, never accepts an arbitrary id, and never
 * retains image bytes. The official store remains the only byte reader; this
 * object is a small authorization index owned by one SourceHistoryWindow.
 */
import type { AttachmentStore, ImageAttachmentRef, StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionHistoryRecord } from '@deepseek-ai/dsh-api-session-controller/types'
import { SOURCE_ATTACHMENT_MAX_BYTES, sourceImageAttachmentRefSchema } from './source-attachment-types.ts'

/** Default per-window grant count. A visible 5,000-event window cannot exceed it realistically. */
export const MAX_SOURCE_ATTACHMENT_GRANTS = 1_024
/** Default per-window metadata budget; image bytes live only in the official store. */
export const MAX_SOURCE_ATTACHMENT_INDEX_BYTES = 256 * 1024
/** A page scan cannot turn a malformed event into an unbounded grant list. */
export const MAX_SOURCE_ATTACHMENT_SCAN_REFS = 1_024
const GRANT_OVERHEAD_BYTES = 64
const utf8 = new TextEncoder()

export type SourceAttachmentFailure =
  | 'ATTACHMENT_NOT_REFERENCED'
  | 'ATTACHMENT_WINDOW_CLOSED'
  | 'ATTACHMENT_INVALID'
  | 'ATTACHMENT_TOO_LARGE'

/** Stable, non-secret failure for the Host RPC mapping and tests. */
export class SourceAttachmentError extends Error {
  override readonly name = 'SourceAttachmentError'
  /** Structural marker survives a bundled copy of this class. */
  readonly isSourceAttachmentError = true
  constructor(readonly reason: SourceAttachmentFailure, message: string) { super(message) }
}

/**
 * Identify one source-window denial across bundle copies without instanceof.
 * @param value - a caught value.
 * @returns the denial when its structural marker and reason are present.
 */
export function sourceAttachmentErrorOf(value: unknown): SourceAttachmentError | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const candidate = value as { isSourceAttachmentError?: unknown; reason?: unknown }
  if (candidate.isSourceAttachmentError !== true) return undefined
  if (typeof candidate.reason !== 'string') return undefined
  return candidate as SourceAttachmentError
}

export interface SourceWindowAttachmentOptions {
  maxEntries?: number
  maxBytes?: number
  maxReadBytes?: number
}

interface Grant {
  readonly ref: ImageAttachmentRef
  readonly bytes: number
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function cloneRef(ref: ImageAttachmentRef): ImageAttachmentRef {
  return {
    attachmentId: ref.attachmentId,
    mediaType: ref.mediaType,
    bytes: ref.bytes,
    width: ref.width,
    height: ref.height,
    ...(ref.name === undefined ? {} : { name: ref.name }),
    ...(ref.originalDimensions === undefined ? {} : { originalDimensions: { ...ref.originalDimensions } }),
  }
}

function grantBytes(ref: ImageAttachmentRef): number {
  return GRANT_OVERHEAD_BYTES + utf8.encode(JSON.stringify(ref)).byteLength
}

function addContentImages(content: unknown, output: ImageAttachmentRef[], budget: { left: number }): void {
  if (!Array.isArray(content) || budget.left <= 0) return
  for (const value of content) {
    if (budget.left <= 0) return
    const block = asRecord(value)
    if (!block || block.type !== 'image') continue
    const parsed = sourceImageAttachmentRefSchema.safeParse(block.attachment)
    if (!parsed.success) continue
    output.push(parsed.data)
    budget.left -= 1
  }
}

/**
 * Read the same first-party content fields the official authorizer recognizes.
 * Unknown event payloads stay opaque, so a malformed or future event cannot
 * grant an image it does not actually present to the official renderer.
 * @param event - one rendered page event.
 * @param output - collected refs.
 * @param budget - shared scan ceiling.
 */
export function collectSourceHistoryImageRefs(event: SessionEvent, output: ImageAttachmentRef[] = [],
  budget: { left: number } = { left: MAX_SOURCE_ATTACHMENT_SCAN_REFS }): ImageAttachmentRef[] {
  const data = asRecord(event.data)
  if (!data) return output
  switch (String(event.type)) {
    case 'user/message':
    case 'tool/ptc-dispatch':
      addContentImages(data.content, output, budget)
      return output
    case 'system/message':
    case 'developer/message':
    case 'tool/result':
    case 'team/message/queued': {
      const message = asRecord(data.message)
      addContentImages(message?.content, output, budget)
      return output
    }
    case 'agent/inbox/spliced': {
      const messages = Array.isArray(data.inserted) ? data.inserted : []
      for (const value of messages) {
        if (budget.left <= 0) return output
        addContentImages(asRecord(value)?.content, output, budget)
      }
      return output
    }
    case 'compaction/summary':
      addContentImages(data.summary, output, budget)
      addContentImages(data.rawOutput, output, budget)
      return output
    case 'assistant/message': {
      const message = asRecord(data.message)
      addContentImages(message?.content, output, budget)
      return output
    }
    default:
      return output
  }
}

/**
 * Collect refs from the records a window is about to serve. Only rendered
 * events participate; page cursors and projections are not attachment grants.
 * @param records - exact records returned to the client.
 * @returns validated image refs in page order.
 */
export function collectRecordImageRefs(records: readonly SessionHistoryRecord[]): ImageAttachmentRef[] {
  const output: ImageAttachmentRef[] = []
  const budget = { left: MAX_SOURCE_ATTACHMENT_SCAN_REFS }
  for (const record of records) {
    if (budget.left <= 0) break
    const entry = asRecord(record)
    if (!entry || entry.type !== 'event') continue
    const event = asRecord(entry.event) as SessionEvent | undefined
    if (!event || typeof event.type !== 'string') continue
    collectSourceHistoryImageRefs(event, output, budget)
  }
  return output
}

/**
 * One source display's bounded grant index. Page-body eviction does not revoke
 * grants, because the client's clipped event window may still display those
 * rows; the index has its own hard count/byte cap, and window dispose or a
 * source epoch change revokes every grant.
 */
export class SourceWindowAttachments {
  readonly maxEntries: number
  readonly maxBytes: number
  readonly maxReadBytes: number
  private readonly grants = new Map<string, Grant>()
  private totalBytes = 0
  private epochValue: number | undefined
  private readonly revokedEpochs = new Set<number>()
  private closed = false
  private lastRevocation: string | undefined

  /**
   * @param displaySessionId - the one display this index serves.
   * @param sourceSessionId - the original source identity, for diagnostics.
   * @param options - hard caps; defaults are bounded even when omitted.
   */
  constructor(readonly displaySessionId: string, readonly sourceSessionId: string,
    options: SourceWindowAttachmentOptions = {}) {
    this.maxEntries = positiveInteger(options.maxEntries, MAX_SOURCE_ATTACHMENT_GRANTS)
    this.maxBytes = positiveInteger(options.maxBytes, MAX_SOURCE_ATTACHMENT_INDEX_BYTES)
    this.maxReadBytes = Math.min(positiveInteger(options.maxReadBytes, SOURCE_ATTACHMENT_MAX_BYTES), SOURCE_ATTACHMENT_MAX_BYTES)
  }

  get count(): number { return this.grants.size }
  get bytes(): number { return this.totalBytes }
  get epoch(): number | undefined { return this.epochValue }
  get disposed(): boolean { return this.closed }
  get revocationReason(): string | undefined { return this.lastRevocation }

  /**
   * Record the refs actually presented by one served page. A page from an
   * older epoch is stale and is ignored without touching the current grant. A
   * newer epoch starts a new generation and drops the old one. Re-granting an
   * id in the current epoch moves it to the MRU edge. Invalid refs are skipped,
   * never repaired from the global store.
   * @param records - records returned to the client for this display.
   * @param epoch - source epoch, when known.
   * @returns the number of validated refs seen in the page.
   */
  grant(records: readonly SessionHistoryRecord[], epoch?: number): number {
    if (this.closed) return 0
    if (epoch === undefined) {
      // Without an epoch we cannot prove that this page belongs to the current
      // generation after a revoke. Fail closed instead of reviving old grants.
      if (this.epochValue !== undefined && this.revokedEpochs.has(this.epochValue)) return 0
    } else if (this.epochValue === undefined) {
      if (this.revokedEpochs.has(epoch)) return 0
      this.epochValue = epoch
    } else if (epoch < this.epochValue) {
      // A late cached page from an older epoch must never clear or rewind the
      // valid current generation.
      return 0
    } else if (epoch > this.epochValue) {
      if (this.revokedEpochs.has(epoch)) return 0
      this.revokeEpoch(this.epochValue)
      this.epochValue = epoch
      this.dropGrants()
    } else if (this.revokedEpochs.has(epoch)) {
      return 0
    }
    let seen = 0
    for (const ref of collectRecordImageRefs(records)) {
      seen += 1
      const key = String(ref.attachmentId)
      const bytes = grantBytes(ref)
      if (bytes > this.maxBytes) continue
      const previous = this.grants.get(key)
      if (previous) {
        this.totalBytes -= previous.bytes
        this.grants.delete(key)
      }
      this.grants.set(key, { ref: cloneRef(ref), bytes })
      this.totalBytes += bytes
    }
    this.trim()
    return seen
  }

  /**
   * Return the durable ref only for an id granted to this display in the
   * current, non-revoked epoch. Stale and not-yet-granted newer epochs deny
   * without mutating the current grant. The match is exact and case-sensitive;
   * no prefix, store lookup, or source-wide fallback.
   * @param attachmentId - id requested by the official image cache.
   * @param epoch - current source epoch, when known.
   * @returns a copy of the granted durable reference.
   */
  authorize(attachmentId: string, epoch?: number): ImageAttachmentRef {
    if (this.closed) throw new SourceAttachmentError('ATTACHMENT_WINDOW_CLOSED', 'The source history window is closed')
    if (epoch !== undefined) {
      if (this.epochValue === undefined) {
        if (this.revokedEpochs.has(epoch)) throw new SourceAttachmentError('ATTACHMENT_NOT_REFERENCED', 'The image belongs to a revoked source epoch')
        this.epochValue = epoch
      } else if (epoch !== this.epochValue) {
        throw new SourceAttachmentError('ATTACHMENT_NOT_REFERENCED', 'The image belongs to a different source epoch')
      } else if (this.revokedEpochs.has(epoch)) {
        throw new SourceAttachmentError('ATTACHMENT_NOT_REFERENCED', 'The image belongs to a revoked source epoch')
      }
    } else if (this.epochValue !== undefined && this.revokedEpochs.has(this.epochValue)) {
      throw new SourceAttachmentError('ATTACHMENT_NOT_REFERENCED', 'The image belongs to a revoked source epoch')
    }
    const found = this.grants.get(attachmentId)
    if (!found) throw new SourceAttachmentError('ATTACHMENT_NOT_REFERENCED', 'The image was not served by this source history window')
    return cloneRef(found.ref)
  }

  /**
   * Authorize, then read and verify through the official attachment store. The
   * epoch and grant are re-checked after the asynchronous store call, so a
   * window dispose, generation change, or revoke during the read cannot
   * complete it.
   * @param store - official Host attachment store.
   * @param attachmentId - id requested by the official image cache.
   * @param epoch - current source epoch, when known.
   * @param signal - optional invocation cancellation.
   * @returns verified durable ref and exact bytes.
   */
  async read(store: AttachmentStore, attachmentId: string, epoch?: number,
    signal?: AbortSignal): Promise<StoredImageAttachment> {
    const ref = this.authorize(attachmentId, epoch)
    const readEpoch = this.epochValue
    signal?.throwIfAborted()
    const storeLimit = store.imageLimits?.maxImageBytes
    const limit = typeof storeLimit === 'number' && Number.isFinite(storeLimit) && storeLimit > 0
      ? Math.min(this.maxReadBytes, storeLimit) : this.maxReadBytes
    if (ref.bytes > limit) throw new SourceAttachmentError('ATTACHMENT_TOO_LARGE', 'The source image exceeds the bounded read limit')
    const stored = await store.readImage(ref, signal)
    signal?.throwIfAborted()
    if (this.closed) throw new SourceAttachmentError('ATTACHMENT_WINDOW_CLOSED', 'The source history window closed during the image read')
    if (this.epochValue !== readEpoch) {
      throw new SourceAttachmentError('ATTACHMENT_NOT_REFERENCED', 'The source epoch changed during the image read')
    }
    if (epoch !== undefined && this.revokedEpochs.has(epoch)) {
      throw new SourceAttachmentError('ATTACHMENT_NOT_REFERENCED', 'The image grant was revoked during the read')
    }
    if (!this.grants.has(attachmentId)) throw new SourceAttachmentError('ATTACHMENT_NOT_REFERENCED', 'The image grant was revoked during the read')
    const checked = sourceImageAttachmentRefSchema.safeParse(stored.ref)
    if (!checked.success || String(checked.data.attachmentId) !== attachmentId) {
      throw new SourceAttachmentError('ATTACHMENT_INVALID', 'The attachment store returned a different image reference')
    }
    if (!(stored.data instanceof Uint8Array) || stored.data.byteLength !== checked.data.bytes) {
      throw new SourceAttachmentError('ATTACHMENT_INVALID', 'The attachment store returned bytes that do not match the durable reference')
    }
    if (stored.data.byteLength > limit) throw new SourceAttachmentError('ATTACHMENT_TOO_LARGE', 'The source image exceeds the bounded read limit')
    return { ref: checked.data, data: stored.data }
  }

  /**
   * Trim the grant metadata index only. Page-body eviction intentionally does
   * not call this: a row that left the server page cache may still be visible.
   * @param maxBytes - smaller optional metadata ceiling.
   */
  trimTo(maxBytes = this.maxBytes): void {
    const limit = Math.max(0, Math.min(maxBytes, this.maxBytes))
    while (this.totalBytes > limit && this.grants.size > 0) {
      const key = this.grants.keys().next().value as string
      const grant = this.grants.get(key)
      if (!grant) break
      this.grants.delete(key)
      this.totalBytes -= grant.bytes
    }
  }

  /**
   * Revoke every grant and the current epoch. The same epoch cannot be
   * re-granted; only a newer epoch may start a new generation. The proven-reset
   * integration path uses dispose, which makes this final.
   * @param reason - bounded non-secret diagnostic.
   */
  clear(reason: string): void {
    if (this.epochValue !== undefined) this.revokeEpoch(this.epochValue)
    this.dropGrants()
    this.lastRevocation = reason
  }

  /**
   * Final revocation for display close/release or a proved source reset. Later
   * grants, reads, and cached old pages fail closed.
   * @param reason - bounded non-secret diagnostic.
   */
  dispose(reason = 'window-disposed'): void {
    this.closed = true
    this.clear(reason)
  }

  private trim(): void {
    while ((this.grants.size > this.maxEntries || this.totalBytes > this.maxBytes) && this.grants.size > 0) {
      const key = this.grants.keys().next().value as string
      const grant = this.grants.get(key)
      if (!grant) break
      this.grants.delete(key)
      this.totalBytes -= grant.bytes
    }
  }

  private revokeEpoch(epoch: number): void {
    this.revokedEpochs.add(epoch)
    while (this.revokedEpochs.size > 8) this.revokedEpochs.delete(this.revokedEpochs.values().next().value as number)
  }

  private dropGrants(): void {
    this.grants.clear()
    this.totalBytes = 0
  }
}
