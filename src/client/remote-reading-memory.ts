/** Official semantic scroll memory scoped to one authenticated source and persistent workspace Pane. */
import type { Context } from '@deepseek-ai/cordis'
import type { ChatScrollPosition } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import { isSourceSessionId } from '../remote/protocol.ts'
import type { SourceReadingCache } from './remote-reading-cache.ts'
import type { AppReadPosition } from '../workspace/app-service-types.ts'
import type { WorkspaceUpdatePreparations } from './update-preparation.ts'
import type { MountedChatControlV1 } from './mounted-chat-control.ts'
import { registerReadingMemoryProvider } from './reading-memory-provider.ts'

export interface SourceReadCommit { position: AppReadPosition & { kind: 'hhpi' }; at: number }
export function installRemoteReadingMemory(ctx: Context, cache: () => SourceReadingCache | undefined, ownsBinding: (binding: SessionBinding) => boolean,
  onReadCommit?: (binding: SessionBinding, commit: SourceReadCommit) => void,
  onPositionSaved?: (binding: SessionBinding) => void): () => void {
  const positions = new WeakMap<SessionBinding, ChatScrollPosition | null>()
  let active = true, sampling: { binding: SessionBinding; saved?: { position: ChatScrollPosition | null } } | undefined
  const stop = registerReadingMemoryProvider(ctx, 'hhpi', (binding: SessionBinding) => {
      const owner = cache()
      if (!isSourceSessionId(binding.sessionId)) return undefined
      if (!owner) return undefined
      const viewId = (binding.session as { readingCacheId?: string }).readingCacheId ?? binding.viewId ?? binding.sessionId
      return {
        // Reopening starts at its explicit target (latest by default). Durable
        // anchors remain available through Continue reading, not auto-restore.
        read: (): ChatScrollPosition | null => cache() === owner ? positions.get(binding) ?? null : null,
        save: (position: ChatScrollPosition | null): void => {
          if (cache() !== owner) return
          // The provider is installed in the original Session owner's realm;
          // its hosting facade owns HHPI bindings in the consumer realm.
          if (!ownsBinding(binding)) return
          positions.set(binding, position)
          const key = position?.anchorOwnerKey ?? position?.anchorKey
          // The Session owner is injected before the optional conversation UI activates.
          const snapshot = ctx.get('uiConversation')?.binding(binding).target('chat').getSnapshot()
          const node = key === undefined ? undefined : snapshot?.nodes.get(key)
          const seq = node === undefined ? undefined : Math.floor(node.anchorSeq)
          if (position && seq === undefined) return
          if (!owner.writePosition(binding.sessionId, viewId, position, seq)) {
            ;(binding.session as { checkpointReading?(): void }).checkpointReading?.()
            if (!owner.writePosition(binding.sessionId, viewId, position, seq)) return
          }
          if (cache() !== owner || !ownsBinding(binding)) return
          if (sampling?.binding === binding) sampling.saved = { position }
          onPositionSaved?.(binding)
          if (!onReadCommit) return
          const checkpoint = owner.read(binding.sessionId)
          const page = checkpoint?.windows.find(window => window.viewId === viewId)?.page
          if (!checkpoint || !page) return
          const committedSeq = position ? seq : page.after
          const entry = page.entries.find(entry => entry.event.seq === committedSeq)
          if (!entry || committedSeq === undefined || committedSeq === null) return
          // The consumer checks the active visible Pane. A saved offscreen anchor
          // alone does not imply that the user read this source event.
          onReadCommit(binding, { position: { kind: 'hhpi', epoch: checkpoint.epoch, seq: committedSeq },
            at: Math.max(0, Math.floor(!page.hasAfter && committedSeq === page.after ? page.session.updatedAt : entry.event.time)) })
        },
      }
  }, { current: () => active && !!cache(), capture(binding, reader) {
      if (!active || !cache() || !ownsBinding(binding)) throw new Error('The original source reading memory owner changed.')
      if (!reader.checkpointReading || reader.read().busy) throw new Error('The original reader cannot capture its current position. The page remains open.')
      const owner = cache(), before = sampling, capture = { binding } as NonNullable<typeof sampling>
      sampling = capture
      try {
        reader.checkpointReading()
        if (cache() !== owner || !ownsBinding(binding) || !capture.saved) throw new Error('The actual source reader did not save its current position. The page remains open.')
        return capture.saved.position
      } finally { sampling = before }
  } })
  return () => { active = false; stop() }
}

/** One real mounted reader, with sampling acknowledged by its original memory provider. */
export function registerSourceReadingCheckpoint(updates: WorkspaceUpdatePreparations, binding: SessionBinding,
  reader: () => MountedChatControlV1 | undefined, owner: {
    cache: SourceReadingCache
    current(): boolean
    samples(): number
  }): () => void {
  let captured: MountedChatControlV1 | undefined
  const identities = new WeakMap<MountedChatControlV1, number>(); let identity = 0
  return updates.registerCheckpoint({ kind: 'reading', label: 'Conversation reading position',
    current: () => owner.current() && !!reader(),
    revision: () => {
      const control = reader(), snapshot = control?.read()
      if (control && !identities.has(control)) identities.set(control, ++identity)
      return JSON.stringify([owner.cache.revision, control ? identities.get(control) : 0, snapshot?.revision, snapshot?.renderRevision])
    },
    capture(signal) {
      captured = undefined; signal.throwIfAborted()
      const control = reader(), before = owner.samples()
      if (!control?.checkpointReading || control.read().busy) throw new Error('The original reader cannot capture its current position. The page remains open.')
      control.checkpointReading()
      signal.throwIfAborted()
      if (!owner.current() || reader() !== control || owner.samples() === before) throw new Error('The actual reader did not save its current source position. The page remains open.')
      captured = control
    },
    save(signal) {
      signal.throwIfAborted()
      if (reader() !== captured) throw new Error('The original reader changed while saving. The page remains open.')
      owner.cache.checkpoint(); signal.throwIfAborted()
    },
  })
}
