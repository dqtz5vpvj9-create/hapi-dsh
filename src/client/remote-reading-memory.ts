/** Official semantic scroll memory scoped to one authenticated source and persistent workspace Pane. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import { isSourceSessionId } from '../remote/protocol.ts'
import type { SourceReadingCache, SourceReadingPosition } from './remote-reading-cache.ts'

export function installRemoteReadingMemory(ctx: Context, cache: () => SourceReadingCache | undefined, ownsBinding: (binding: SessionBinding) => boolean): () => void {
  return ctx.reflect.provide('chatScrollMemory', {
    forBinding(binding: SessionBinding) {
      const owner = cache()
      if (!isSourceSessionId(binding.sessionId) || !owner) return undefined
      const viewId = (binding.session as { readingCacheId?: string }).readingCacheId ?? binding.viewId ?? binding.sessionId
      return {
        read: (): SourceReadingPosition | null => cache() === owner ? owner.readPosition(binding.sessionId, viewId) : null,
        save: (position: SourceReadingPosition | null): void => {
          if (cache() !== owner) return
          // The provider is installed in the original Session owner's realm;
          // its hosting facade owns HHPI bindings in the consumer realm.
          if (!ownsBinding(binding)) return
          const key = position?.anchorOwnerKey ?? position?.anchorKey
          const snapshot = ctx.uiConversation.binding(binding).target('chat').getSnapshot()
          const node = key === undefined ? undefined : snapshot?.nodes.get(key)
          const seq = node === undefined ? undefined : Math.floor(node.anchorSeq)
          if (position && seq === undefined) return
          if (!owner.writePosition(binding.sessionId, viewId, position, seq)) {
            ;(binding.session as { checkpointReading?(): void }).checkpointReading?.()
            owner.writePosition(binding.sessionId, viewId, position, seq)
          }
        },
      }
    },
  })
}
