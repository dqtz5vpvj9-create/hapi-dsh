/** Pane navigation uses its exact official Conversation and mounted Chat reader. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspacePaneNavigation } from './pane-navigation.ts'
import { resolveMountedChatForPane } from './mounted-chat-control.ts'

export function bindRemotePaneReading(ctx: Context, root: HTMLElement, reference: SessionReference, navigation: WorkspacePaneNavigation): () => void {
  let disposed = false, applied = -1
  let pending: AbortController | undefined
  let error: HTMLElement | undefined
  const clear = (): void => { error?.remove(); error = undefined }
  const update = (): void => {
    if (disposed || !navigation.state.getSnapshot().visible) return
    const control = resolveMountedChatForPane(root)
    if (!control) return
    const intent = navigation.reading.getSnapshot()
    if (!intent || intent.sessionId !== reference.sessionId) { root.dataset.hapiReading = 'reader'; return }
    if (intent.revision === applied) return
    applied = intent.revision
    pending?.abort(); pending = new AbortController()
    const signal = pending.signal
    clear(); root.dataset.hapiReading = 'waiting'
    const read = async (): Promise<void> => {
      if (intent.target.kind === 'latest') await control.toLatest(signal)
      else if (intent.target.kind === 'message') {
        const seq = Number(intent.target.messageId)
        if (!Number.isSafeInteger(seq) || seq < 0 || String(seq) !== intent.target.messageId) throw new Error('The source link does not contain an exact history sequence.')
        const conversation = ctx.uiConversation.binding(reference.binding)
        const reading = conversation.readingView
        if (!reading) throw new Error('This Pane has no official source reading window.')
        const find = () => {
          const snapshot = conversation.target('chat').getSnapshot()
          return snapshot?.order.map(key => snapshot.nodes.get(key)).find(node => node !== undefined && Math.floor(node.anchorSeq) === seq)
        }
        let node = find()
        if (!node) {
          await reading.read({ kind: 'around', target: { key: intent.target.messageId, seq: seq as never } }, signal)
          signal.throwIfAborted()
          node = find()
        }
        if (!node) throw new Error('The source history target has no readable Chat node.')
        // The source cursor locates data; the official assembler owns the rendered node key.
        await control.reveal({ key: node.key, seq }, signal)
      } else {
        const id = intent.target.kind === 'approval' ? intent.target.requestId : intent.target.localId
        const target = root.querySelector<HTMLElement>(`[data-hhpi-request="${CSS.escape(id)}"]`)
        if (!target) throw new Error('This source action is no longer pending.')
        target.focus({ preventScroll: true })
      }
    }
    void read().then(() => { if (!disposed && !signal.aborted) root.dataset.hapiReading = 'ready' }, cause => {
      if (disposed || signal.aborted) return
      root.dataset.hapiReading = 'error'
      error = root.ownerDocument.createElement('p'); error.setAttribute('role', 'alert')
      error.textContent = cause instanceof Error ? cause.message : 'The source target could not be opened.'
      root.append(error)
    })
  }
  const observer = new MutationObserver(update)
  observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-hapi-mounted-chat'] })
  const stops = [navigation.state.subscribe(update), navigation.reading.subscribe(update)]
  void reference.ready.then(update, () => {})
  return () => { disposed = true; pending?.abort(); observer.disconnect(); for (const stop of stops) stop(); clear(); delete root.dataset.hapiReading }
}
