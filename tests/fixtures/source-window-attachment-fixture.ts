/** Synthetic original media and source rows for the official attachment test. */
import type { HapiMessage } from '../../src/codex/contracts.ts'

export const attachmentWindowImages = {
  old: {
    imageId: 'window/image?position=old#original', fileName: 'window-old-original.png', mimeType: 'image/png' as const,
    bytes: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC', 'base64'),
  },
  latest: {
    imageId: 'window/image?position=latest#original', fileName: 'window-latest-original.gif', mimeType: 'image/gif' as const,
    bytes: Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'),
  },
}

export function sourceWindowAttachmentHistory(): {
  rows: HapiMessage[]; oldMessageId: string; oldPrompt: string; latestAnswer: string
} {
  const rows: HapiMessage[] = []
  const oldTurn = 20, turns = 400, start = 1_760_000_000_000
  for (let turn = 0; turn < turns; turn += 1) {
    const append = (kind: string, role: 'user' | 'agent', content: unknown): void => {
      const seq = rows.length + 1, at = start + seq
      rows.push({ id: `attachment-window-${turn}-${kind}`, localId: null, seq, createdAt: at,
        ...(role === 'user' ? { invokedAt: at } : {}), content: { role, content } })
    }
    append('user', 'user', { type: 'text', text: `Attachment window question ${turn}` })
    const image = turn === oldTurn ? attachmentWindowImages.old : turn === turns - 1 ? attachmentWindowImages.latest : undefined
    if (image) append('image', 'agent', { type: 'codex', data: { type: 'generated-image',
      imageId: image.imageId, fileName: image.fileName, mimeType: image.mimeType,
      source: { ingress: 'mcp', toolName: 'display_image' } } })
    append('answer', 'agent', { type: 'output', data: { type: 'assistant', uuid: `attachment-answer-${turn}`,
      message: { model: 'synthetic', content: [{ type: 'text', text: `Attachment window answer ${turn}` }] } } })
    append('end', 'agent', { type: 'output', data: { type: 'result', is_error: false } })
  }
  return { rows, oldMessageId: `attachment-window-${oldTurn}-user`,
    oldPrompt: `Attachment window question ${oldTurn}`, latestAnswer: `Attachment window answer ${turns - 1}` }
}
