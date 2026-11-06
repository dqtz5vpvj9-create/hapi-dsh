import type { ImageAttachmentLimits } from '@deepseek-ai/dsh-attachment'

/** Existing HHPI image frame budget, including base64 expansion. */
export const SOURCE_IMAGE_BASE64_LIMIT = 8 * 1024 * 1024
export const SOURCE_IMAGE_COUNT_LIMIT = 10
export const SOURCE_INPUT_IMAGE_LIMITS: Readonly<ImageAttachmentLimits> = Object.freeze({
  maxImageBytes: SOURCE_IMAGE_BASE64_LIMIT / 4 * 3,
  maxMessageImageBytes: SOURCE_IMAGE_BASE64_LIMIT / 4 * 3,
  maxImagesPerMessage: SOURCE_IMAGE_COUNT_LIMIT,
  maxImagePixels: 64_000_000,
  maxImageDimension: 8192,
  mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const,
})
