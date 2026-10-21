import type { ArbitrateOutcome, InputActions, InputState } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ComposerAttachmentAdmission } from './attachments.ts'
import type { ComposerEnterPreference } from './preferences.ts'

export interface ComposerEnterEvent {
  readonly key: string
  readonly defaultPrevented: boolean
  readonly shiftKey: boolean
  readonly altKey: boolean
  readonly ctrlKey: boolean
  readonly metaKey: boolean
  readonly isComposing: boolean
  readonly keyCode: number
  readonly repeat: boolean
  getModifierState(key: string): boolean
  preventDefault(): void
  stopPropagation(): void
}
export type ComposerEnterIssue = Exclude<ComposerAttachmentAdmission, 'ready'> | 'failed'
export interface ComposerEnterInput {
  /** Exact public SessionBinding generation, never an ID guessed from the DOM. */
  readonly identity: object
  readonly actions: Pick<InputActions, 'submit'>
  readonly state: Pick<InputState, 'phase' | 'draft' | 'attachmentIds'>
  readonly blocked: boolean
  arbitrate(): ArbitrateOutcome
  attachments(): ComposerAttachmentAdmission
  notify(issue: ComposerEnterIssue): void
}
export interface ComposerEnterOwner {
  preference(): ComposerEnterPreference
  current(): ComposerEnterInput | undefined
}

/** One mounted editor occurrence; no global key handler and no retained private editor. */
export class ComposerEnterBehavior {
  private composing = false
  private compositionUntil = 0
  private disposed = false
  constructor(private readonly owner: ComposerEnterOwner, private readonly now: () => number = Date.now) {}
  compositionStart(): void { this.composing = true }
  compositionEnd(): void { this.composing = false; this.compositionUntil = this.now() + 10 }
  blur(): void { this.composing = false; this.compositionUntil = 0 }
  dispose(): void { this.disposed = true; this.blur() }

  /** True only when this occurrence intercepted Enter before the official target keymap. */
  handle(event: ComposerEnterEvent, editable: boolean): boolean {
    if (this.disposed || event.defaultPrevented || event.key !== 'Enter' || this.owner.preference() !== 'newline') return false
    // The browser owns IME confirmation; the official keymap retains its own
    // matching guard. Shift+Enter and platform/application chords stay intact.
    if (event.isComposing || event.keyCode === 229 || this.composing || this.now() < this.compositionUntil
      || event.shiftKey || event.altKey || event.getModifierState('AltGraph') || (event.ctrlKey && event.metaKey)) return false
    // Bypass only the official Enter-to-submit keydown handler. An admitted
    // plain Enter must retain its native default: beforeinput then reaches
    // the original editor, which owns selection, LineBreakNode, undo and
    // persistence. Inserting a raw '\n' through the asynchronous text API
    // leaves Chromium's caret before a trailing LF instead of on a new line.
    event.stopPropagation()
    // A held key cannot pick a second candidate or submit the newly cleared draft.
    if (event.repeat || !editable) { event.preventDefault(); return true }
    let original: ComposerEnterInput | undefined
    try {
      original = this.owner.current()
      if (!original || frozen(original)) { event.preventDefault(); return true }
      if (original.arbitrate() !== 'pass') { event.preventDefault(); return true }
      const current = this.owner.current()
      if (!current || current.identity !== original.identity || current.actions !== original.actions || frozen(current)) { event.preventDefault(); return true }
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault()
        if (!current.state.draft.trim() && !current.state.attachmentIds.length) return true
        const admission = current.attachments()
        if (admission !== 'ready') { current.notify(admission); return true }
        // Public ordinary submission keeps command adjudication, claims,
        // attachments and the default sink under their existing owner.
        current.actions.submit()
      }
    } catch { event.preventDefault(); original?.notify('failed') }
    return true
  }
}
function frozen(input: ComposerEnterInput): boolean {
  return input.blocked || input.state.phase === 'adjudicating' || input.state.phase === 'submitting'
}

/** Attach only to the actual composer card that contains our public slot seat. */
export function captureComposerEnter(card: HTMLElement, behavior: ComposerEnterBehavior): () => void {
  const editorOf = (event: Event): HTMLElement | undefined => {
    const target = event.target as Element | null
    if (!target || typeof target.closest !== 'function') return undefined
    const editor = target.closest<HTMLElement>('[data-composer-input]')
    return editor && card.contains(editor) && editor.closest('[data-composer-card]') === card ? editor : undefined
  }
  const keydown = (event: KeyboardEvent): void => {
    const editor = editorOf(event)
    if (!editor) return
    const active = card.ownerDocument.activeElement
    behavior.handle(event, editor.isConnected && editor.isContentEditable && active !== null && editor.contains(active))
  }
  const start = (event: Event): void => { if (editorOf(event)) behavior.compositionStart() }
  const end = (event: Event): void => { if (editorOf(event)) behavior.compositionEnd() }
  const blur = (event: Event): void => { if (editorOf(event)) behavior.blur() }
  card.addEventListener('keydown', keydown, true)
  card.addEventListener('compositionstart', start, true)
  card.addEventListener('compositionend', end, true)
  card.addEventListener('blur', blur, true)
  return () => {
    behavior.dispose()
    card.removeEventListener('keydown', keydown, true)
    card.removeEventListener('compositionstart', start, true)
    card.removeEventListener('compositionend', end, true)
    card.removeEventListener('blur', blur, true)
  }
}
