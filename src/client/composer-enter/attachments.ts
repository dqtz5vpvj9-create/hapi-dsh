import type { ComposerAttachmentsOwnerProps, DraftAttachmentId, InputActions } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

export type ComposerAttachmentAdmission = 'ready' | 'unavailable' | 'uploading' | 'error'
export interface ComposerEnterAttachments {
  /** Observe the actual mounted attachment owner without claiming or changing its files. */
  inspectSubmission(sessionId: SessionId, actions: InputActions, ids: readonly DraftAttachmentId[]): ComposerAttachmentAdmission
}

/** Missing descriptors/receipts are never treated as a completed upload. */
export function inspectComposerAttachments(
  seat: Pick<ComposerAttachmentsOwnerProps, 'attachments' | 'uploads'> | undefined,
  ids: readonly DraftAttachmentId[],
): ComposerAttachmentAdmission {
  if (!ids.length) return 'ready'
  if (!seat) return 'unavailable'
  let pending = false
  for (const id of ids) {
    const attachment = seat.attachments.find(value => value.id === id)
    if (!attachment) return 'unavailable'
    if (attachment.kind === 'image') continue
    const upload = seat.uploads[id]
    if (upload?.status === 'error') return 'error'
    if (upload?.status !== 'ready') pending = true
  }
  return pending ? 'uploading' : 'ready'
}
