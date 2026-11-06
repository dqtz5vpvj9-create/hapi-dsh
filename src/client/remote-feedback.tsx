/** Codex has no DSH message-rating endpoint. Do not mount that unrelated RPC owner. */
import { createElement, type ComponentType } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { isSourceSessionId } from '../remote/protocol.ts'

export function installRemoteFeedbackPolicy(ctx: Context): () => void {
  const name = 'conversation.chat.assistant-actions' as const
  let prior: StoredEntry | undefined, remove: (() => void) | undefined, changing = false
  let component: ComponentType<{ sessionId: SessionId }> | undefined
  const reconcile = () => {
    if (changing) return
    const entry = ctx.slots.entries(name).find(entry => entry.options.id === 'feedback' && entry.component !== component)
    if (entry === prior) return
    changing = true
    try {
      remove?.(); remove = undefined; prior = entry
      if (!entry || entry.children || entry.store) return
      const Official = entry.component as ComponentType<{ sessionId: SessionId }>
      component = props => isSourceSessionId(props.sessionId) ? null : createElement(Official, props)
      // The official injection is preserved for DSH, but never called with a foreign source ID.
      const inject = entry.inject
      const register = ctx.slots.register.bind(ctx.slots) as (options: object, component: unknown) => () => void
      remove = register({ name, id: 'feedback', priority: (entry.options.priority ?? 0) - 1, order: entry.options.order,
        locale: entry.locale, inject: (...args: never[]) => isSourceSessionId(String(args[0])) ? {} : inject?.(...args) ?? {} }, component)
    } finally { changing = false }
  }
  const stop = ctx.slots.subscribe(name, reconcile); reconcile()
  return () => { stop(); remove?.() }
}
