/** Pane navigation uses its exact official Conversation and mounted Chat reader. */
import type { Context } from '@deepseek-ai/cordis'
import { bindRemoteReadingOwner, remoteReadingOwner } from './remote-reading-owner.ts'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspacePaneNavigation } from './pane-navigation.ts'
import { resolveMountedChatForPane } from './mounted-chat-control.ts'
import { messageNodeTarget } from './reading-anchor.ts'
import { registerSourceUpdateReadingCheckpoint } from './ordinary-reading-checkpoint.ts'

export function bindRemotePaneReading(ctx: Context, root: HTMLElement, reference: SessionReference, navigation: WorkspacePaneNavigation): () => void {
  const releaseOwner = bindRemoteReadingOwner(root, reference)
  let disposed = false, applied = -1, attempting = -1
  let pending: AbortController | undefined
  let error: HTMLElement | undefined
  const window = root.ownerDocument.defaultView, initialIntent = navigation.reading.getSnapshot()
  const checkpoint = window && ctx.get('sourceReadingMemory')?.sourceCapture?.() ? registerSourceUpdateReadingCheckpoint(ctx, reference.binding, {
    updates: navigation.updates, application: navigation.application,
    target: { hostId: navigation.hostId, sessionId: reference.sessionId, paneId: navigation.paneId }, storage: window.sessionStorage,
    reload: (window.performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined)?.type === 'reload',
    reader: () => resolveMountedChatForPane(root),
    current: () => !disposed && root.isConnected && (ctx.sessions.ownsBinding?.(reference.binding) ?? ctx.sessions.binding(reference.sessionId) === reference.binding),
  }) : undefined
  let restore: 'waiting' | 'running' | 'error' | 'done' = checkpoint ? 'waiting' : 'done'
  const clear = (): void => { error?.remove(); error = undefined }
  const update = (): void => {
    if (disposed || !navigation.state.getSnapshot().visible) return
    const control = resolveMountedChatForPane(root)
    const intent = navigation.reading.getSnapshot()
    // Only the startup default may yield to an explicitly armed update ticket.
    // A later user navigation retires that restore even if its IO settles late.
    if (restore !== 'done' && (intent !== initialIntent || intent && intent.target.kind !== 'latest')) {
      restore = 'done'; pending?.abort(); pending = undefined; clear()
    }
    // An unarmed open, including a welcome view without mounted Chat, must
    // proceed directly to its normal latest window without waiting for a reader.
    if (restore === 'waiting' && checkpoint!.pending() === false) restore = 'done'
    if (restore !== 'done') {
      if (restore !== 'waiting' || !control || !navigation.application.getSnapshot()) return
      restore = 'running'; pending = new AbortController(); const operation = pending, signal = operation.signal
      root.dataset.hapiReading = 'waiting'
      void checkpoint!.restore(signal).then(restored => {
        if (disposed || signal.aborted || navigation.reading.getSnapshot() !== intent) return
        restore = 'done'
        if (restored) { applied = intent?.revision ?? -1; root.dataset.hapiReading = 'ready' }
        else update()
      }, cause => {
        if (disposed || signal.aborted) return
        restore = 'error'; root.dataset.hapiReading = 'error'
        error = root.ownerDocument.createElement('p'); error.setAttribute('role', 'alert')
        error.textContent = cause instanceof Error ? cause.message : 'The saved source reading position could not be restored.'
        const retry = root.ownerDocument.createElement('button'); retry.type = 'button'
        retry.textContent = ctx.get('locale', false)?.getSnapshot().active.startsWith('zh') ? '重试恢复阅读位置' : 'Retry reading position'
        retry.onclick = () => { restore = 'waiting'; clear(); update() }; error.append(retry); root.append(error)
      }).finally(() => { if (pending === operation) pending = undefined })
      return
    }
    if (!intent || intent.sessionId !== reference.sessionId) { root.dataset.hapiReading = 'reader'; return }
    // The official Conversation renders its welcome/composer without mounting
    // Chat when the accepted window has no nodes. Latest still reads the source,
    // but there is no Chat position to reveal in that empty window.
    const emptyWindow = (): boolean => {
      const snapshot = ctx.uiConversation.binding(reference.binding).target('chat').getSnapshot()
      return snapshot ? snapshot.order.length === 0 : reference.binding.eventSource.getSnapshot().entries.length === 0
        && !reference.binding.session.getSnapshot().hasMore
    }
    const emptyLatest = !control && intent.target.kind === 'latest' && emptyWindow()
    if (!control && !emptyLatest) return
    if (intent.revision === applied || intent.revision === attempting) return
    attempting = intent.revision
    pending?.abort(); pending = new AbortController()
    const signal = pending.signal
    clear(); root.dataset.hapiReading = 'waiting'
    const read = async (): Promise<boolean> => {
      if (intent.target.kind === 'latest') {
        if (control) await control.toLatest(signal)
        else {
          await reference.ready; signal.throwIfAborted()
          const conversation = ctx.uiConversation.binding(reference.binding)
          if (!conversation.readingView) throw new Error('This Pane has no official source reading window.')
          await conversation.readingView.read({ kind: 'latest' }, signal)
          signal.throwIfAborted()
          // If content arrived, its real mounted Chat owns the landing. The
          // next mount notification retries this same destination.
          if (!emptyWindow()) return false
        }
      }
      else if (intent.target.kind === 'message') {
        const seq = Number(intent.target.messageId)
        if (!Number.isSafeInteger(seq) || seq < 0 || String(seq) !== intent.target.messageId) throw new Error('The source link does not contain an exact history sequence.')
        const expectedEpoch = intent.target.epoch
        const checkEpoch = (): void => {
          if (expectedEpoch && remoteReadingOwner(root)?.sourceEpoch !== expectedEpoch) throw new Error('The original history changed. This saved position is no longer valid.')
        }
        checkEpoch()
        const conversation = ctx.uiConversation.binding(reference.binding)
        const reading = conversation.readingView
        if (!reading) throw new Error('This Pane has no official source reading window.')
        const find = () => {
          const snapshot = conversation.target('chat').getSnapshot()
          // The Pane assembler consumes this committed occurrence, not the
          // canonical Session's legacy event source. Tool results locate their
          // call node through the exact source callId in that same window.
          return messageNodeTarget(snapshot, seq, reading.snapshot.getSnapshot().entries)
        }
        let node = find()
        if (!node) {
          await reading.read({ kind: 'around', target: { key: intent.target.messageId, seq: seq as never } }, signal)
          signal.throwIfAborted()
          node = find()
        }
        checkEpoch()
        if (!node) throw new Error('The source history target has no readable Chat node.')
        // The source cursor locates data; the official assembler owns the rendered node key.
        await control!.reveal({ key: node.key, seq }, signal)
      } else {
        const id = intent.target.kind === 'approval' ? intent.target.requestId : intent.target.localId
        const target = root.querySelector<HTMLElement>(`[data-hhpi-request="${CSS.escape(id)}"]`)
        if (!target) throw new Error('This source action is no longer pending.')
        target.focus({ preventScroll: true })
      }
      return true
    }
    void read().then(admitted => { if (admitted && !disposed && !signal.aborted) { applied = intent.revision; root.dataset.hapiReading = 'ready' } }, cause => {
      if (disposed || signal.aborted) return
      root.dataset.hapiReading = 'error'
      error = root.ownerDocument.createElement('p'); error.setAttribute('role', 'alert')
      error.textContent = cause instanceof Error ? cause.message : 'The source target could not be opened.'
      root.append(error)
    }).finally(() => { if (attempting === intent.revision) attempting = -1; if (!disposed && !signal.aborted && applied !== intent.revision && root.dataset.hapiReading !== 'error') update() })
  }
  const observer = new MutationObserver(update)
  observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-hapi-mounted-chat'] })
  const stops = [navigation.state.subscribe(update), navigation.reading.subscribe(update), navigation.application.subscribe(update)]
  const visible = (): void => { if (root.ownerDocument.visibilityState === 'visible') update() }
  window?.addEventListener('online', update); window?.addEventListener('pageshow', update)
  root.ownerDocument.addEventListener('visibilitychange', visible)
  void reference.ready.then(update, () => {})
  return () => { releaseOwner(); disposed = true; pending?.abort(); checkpoint?.dispose(); observer.disconnect(); for (const stop of stops) stop(); clear(); delete root.dataset.hapiReading
    window?.removeEventListener('online', update); window?.removeEventListener('pageshow', update); root.ownerDocument.removeEventListener('visibilitychange', visible) }
}
