/**
 * Wire contract for reading an image that a bounded source-history page served.
 *
 * This module is deliberately browser-safe: the Host uses the schemas for its
 * plugin RPC, while the client facade uses the same schemas and the fallback
 * helper. It never imports the Host attachment backend or file-system code.
 */
import { z } from 'zod'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'

/** Mirrors the existing HAPI-to-DSH image import ceiling. */
export const SOURCE_ATTACHMENT_MAX_BYTES = 32 * 1024 * 1024
/** Canonical base64 expansion of {@link SOURCE_ATTACHMENT_MAX_BYTES}. */
export const SOURCE_ATTACHMENT_MAX_BASE64_CHARS = Math.ceil(SOURCE_ATTACHMENT_MAX_BYTES / 3) * 4
export const SOURCE_ATTACHMENT_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const

const controlCharacters = /[\u0000-\u001f\u007f]/
const attachmentIdText = z.string().min(1).max(512).refine(value => !controlCharacters.test(value),
  'Attachment ids cannot contain control characters')

/**
 * One durable image reference exactly as the official Session log stores it.
 * Unknown keys are stripped rather than forwarded; the store re-verifies the
 * bytes against this reference during the read.
 */
export const sourceImageAttachmentRefSchema = z.object({
  attachmentId: attachmentIdText,
  mediaType: z.enum(SOURCE_ATTACHMENT_MEDIA_TYPES),
  bytes: z.number().int().nonnegative().max(SOURCE_ATTACHMENT_MAX_BYTES),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  name: z.string().max(1024).refine(value => !controlCharacters.test(value), 'Attachment names cannot contain control characters').optional(),
  originalDimensions: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }).optional(),
}).transform((value): ImageAttachmentRef => ({
  attachmentId: value.attachmentId as ImageAttachmentRef['attachmentId'],
  mediaType: value.mediaType,
  bytes: value.bytes,
  width: value.width,
  height: value.height,
  ...(value.name === undefined ? {} : { name: value.name }),
  ...(value.originalDimensions === undefined ? {} : { originalDimensions: value.originalDimensions }),
}))

/** The plug-in RPC request. The Host, never the caller, chooses the source epoch. */
export const sourceHistoryAttachmentRequestSchema = z.strictObject({
  sessionId: z.string().min(1).max(512),
  attachmentId: attachmentIdText,
})
export type SourceHistoryAttachmentRequest = z.infer<typeof sourceHistoryAttachmentRequestSchema>

/** Same semantic value as the official `session/attachment` wire response. */
export const sourceHistoryAttachmentValueSchema = z.object({
  attachment: sourceImageAttachmentRefSchema,
  data: z.string().min(1).max(SOURCE_ATTACHMENT_MAX_BASE64_CHARS),
})
export type SourceHistoryAttachmentValue = z.infer<typeof sourceHistoryAttachmentValueSchema>

/** A malformed adapter response never reaches the official image cache. */
export class SourceAttachmentWireError extends Error {
  override readonly name = 'SourceAttachmentWireError'
}

/**
 * Decode the adapter response into the exact shape the official
 * `SessionFace.readAttachment` returns. Length is verified against the durable
 * reference so a truncated or expanded response fails closed.
 * @param value - validated adapter response carrying canonical base64.
 * @returns the durable reference and exact image bytes.
 */
export function decodeSourceAttachmentValue(value: unknown): {
  attachment: ImageAttachmentRef
  data: Uint8Array
} {
  const parsed = sourceHistoryAttachmentValueSchema.safeParse(value)
  if (!parsed.success) throw new SourceAttachmentWireError('The source attachment response is not a valid image value')
  let binary: string
  try { binary = atob(parsed.data.data) } catch { throw new SourceAttachmentWireError('The source attachment response is not canonical base64') }
  if (btoa(binary) !== parsed.data.data) throw new SourceAttachmentWireError('The source attachment response is not canonical base64')
  const data = Uint8Array.from(binary, character => character.charCodeAt(0))
  if (data.byteLength !== parsed.data.attachment.bytes) throw new SourceAttachmentWireError('The source attachment response does not match its durable length')
  return { attachment: parsed.data.attachment, data }
}

/**
 * Identify exactly the official authorization denial that means "this image is
 * not in the display Session log". Other attachment failures must never take
 * the source-window fallback.
 * @param error - a rejected Remote result value.
 * @returns whether the official endpoint refused because the log lacks the ref.
 */
export function isAttachmentNotReferenced(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false
  const failure = error as { code?: unknown; details?: unknown }
  if (failure.code !== 'session/attachment-invalid') return false
  const details = failure.details
  if (details === null || typeof details !== 'object') return false
  return (details as { reason?: unknown }).reason === 'ATTACHMENT_NOT_REFERENCED'
}

/**
 * Read through the official Session face first. Only the exact
 * `ATTACHMENT_NOT_REFERENCED` denial may consult the source-window adapter;
 * success, every other failure, a missing adapter, and an adapter failure all
 * keep the official result. The original error is never replaced by a broader
 * authorization error.
 * @param official - the original face read.
 * @param source - the optional source-window adapter read.
 * @returns the official result, or the adapter result only for the one denial.
 */
export async function readSourceAttachmentWithFallback<Value>(
  official: () => Promise<RemoteResult<Value>>,
  source: () => Promise<RemoteResult<Value> | undefined>,
): Promise<RemoteResult<Value>> {
  const original = await official()
  if (original.ok || !isAttachmentNotReferenced(original.error)) return original
  try {
    const adapted = await source()
    return adapted?.ok ? adapted : original
  } catch {
    return original
  }
}
