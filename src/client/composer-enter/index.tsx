import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type {} from '../workspace-ui.ts'
import { ComposerEnterBehavior, captureComposerEnter, type ComposerEnterIssue } from './behavior.ts'
import { readComposerEnterPreference, writeComposerEnterPreference } from './preferences.ts'
import type { ComposerEnterAttachments } from './attachments.ts'
import { arbitrateComposerEnter } from './triggers.ts'
import { useWorkspacePane } from '../surface/pane-context.tsx'

const issues: Record<ComposerEnterIssue, readonly [string, string]> = {
  unavailable: ['The original attachment owner is not ready. Your draft and files are retained.', '原附件组件尚未就绪。草稿和附件均已保留。'],
  uploading: ['Wait for the attachments to finish uploading before sending.', '请等待附件上传完成后再发送。'],
  error: ['An attachment upload failed. Retry or remove it in the original attachment controls before sending.', '附件上传失败。请在原附件控件中重试或移除后再发送。'],
  failed: ['The composer could not apply this key. Your draft remains under the original input owner.', '输入框暂时无法处理这个按键，草稿仍由原输入组件保留。'],
}

/** Public settings and one additive input seat; never replaces the editor or input bar. */
export function installComposerEnter(ctx: Context, composer: ComposerEnterAttachments): () => void {
  const scope = ctx.inject(['hapiWorkspaceUi', 'slots', 'sessions', 'conversation', 'inputTriggers', 'locale'], owner => {
    const preferences = owner.hapiWorkspaceUi.preferences
    const preference = () => readComposerEnterPreference(preferences)
    const language = () => owner.locale.getSnapshot().active
    const Seat = (props: PropsRuntime<'conversation.input.right'>) => {
      const pane = useWorkspacePane(owner)
      const seat = useRef<HTMLSpanElement | null>(null), current = useRef({ props, pane })
      useLayoutEffect(() => { current.current = { props, pane } })
      useLayoutEffect(() => {
        const card = seat.current?.closest<HTMLElement>('[data-composer-card]')
        if (!card) return
        const behavior = new ComposerEnterBehavior({ preference, current() {
          const latest = current.current.props, binding = owner.sessions.binding(latest.sessionId)
          if (!binding) return undefined
          const input = owner.conversation.input.for(binding.ctx)
          return {
            identity: binding, actions: latest.inputActions, state: input.state.getSnapshot(),
            blocked: owner.conversation.blocks.storeFor(latest.sessionId).getSnapshot() !== undefined
              || current.current.pane?.state.getSnapshot().visible === false,
            arbitrate: () => arbitrateComposerEnter(owner.inputTriggers.sessionOf(binding.ctx)),
            attachments: () => composer.inspectSubmission(latest.sessionId, latest.inputActions, input.state.getSnapshot().attachmentIds),
            notify: issue => input.notify('error', issues[issue][language().startsWith('zh') ? 1 : 0]),
          }
        } })
        return captureComposerEnter(card, behavior)
      }, [])
      return <span ref={seat} hidden aria-hidden="true" data-hapi-composer-enter=""/>
    }
    const Section = () => {
      const value = useSyncExternalStore(preferences.subscribe, preference)
      const locale = useSyncExternalStore(listener => owner.locale.subscribe(listener), language)
      const [saveFailed, setSaveFailed] = useState(false)
      const tr = (en: string, zh: string): string => locale.startsWith('zh') ? zh : en
      return <section className="hapi-enter-settings" aria-label={tr('Message input', '消息输入')}>
        <h2>{tr('Message input', '消息输入')}</h2>
        <label>{tr('Enter key behavior', '回车键行为')}<select value={value} onChange={event => {
          setSaveFailed(!writeComposerEnterPreference(preferences, event.currentTarget.value === 'newline' ? 'newline' : 'send'))
        }}><option value="send">{tr('Send message', '发送消息')}</option><option value="newline">{tr('New line', '换行')}</option></select></label>
        <p>{value === 'newline'
          ? tr('Enter inserts a line break. Ctrl+Enter or Cmd+Enter sends through the ordinary queue. Shift+Enter also inserts a line break. Completion choices and IME confirmation keep priority.', '回车插入换行，Ctrl+回车或 Cmd+回车通过普通队列发送；Shift+回车同样换行。候选选取与输入法确认优先。')
          : tr('Enter sends with the original DSH behavior, including its busy-session queue and steer settings. Shift+Enter inserts a line break.', '回车沿用 DSH 的发送行为，包括忙碌会话的排队和转向设置；Shift+回车换行。')}</p>
        <p>{tr('This preference follows the original HAPI setting and is shared across local and remote panes.', '此选项兼容原 HAPI 偏好，并在本地与远程窗格之间共享。')}</p>
        {saveFailed && <p role="alert">{tr('The change works in this page, but browser storage could not save it for reload.', '修改在本页已生效，但浏览器存储未能保存以供刷新恢复。')}</p>}
      </section>
    }
    const style = document.createElement('style'); style.textContent = styles; document.head.append(style)
    const seat = owner.slots.inject('conversation.input.right', () => owner.slots.register({ name: 'conversation.input.right', id: 'hapi.composer-enter', order: 100 }, Seat))
    const settings = owner.slots.inject('settings.section', () => owner.slots.register({ name: 'settings.section', id: 'hapi-input', order: 33,
      label: () => language().startsWith('zh') ? '消息输入' : 'Message input' }, Section))
    return () => { settings(); seat(); style.remove() }
  })
  return () => { void scope.dispose() }
}
const styles = `.hapi-enter-settings{max-width:760px;color:var(--dsw-alias-label-primary);font:var(--dsw-font-s-14)}.hapi-enter-settings h2{font:var(--dsw-font-l-20);margin:0 0 16px}.hapi-enter-settings label{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}.hapi-enter-settings select{font:inherit;color:inherit;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:6px 10px}.hapi-enter-settings p{line-height:1.5;color:var(--dsw-alias-label-secondary)}.hapi-enter-settings [role=alert]{color:var(--dsw-alias-error)}.hapi-enter-settings select:focus-visible{outline:2px solid var(--dsw-alias-link);outline-offset:2px}`
