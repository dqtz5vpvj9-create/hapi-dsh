/** Compose mobile actions around the original DSH terminal body, retaining its owner. */
import { createElement, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentType, type ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client'
import type { TerminalViewState } from '@deepseek-ai/dsh-api-terminal-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '../pane-navigation.ts'
import { TerminalInputControls, type TerminalPublicView } from './input.ts'
import { TerminalPreferences } from './preferences.ts'
import { TouchBar } from './TouchBar.tsx'
import { KeyEditor } from './KeyEditor.tsx'
import { TerminalDialog } from './dialog.tsx'
import { BUILTIN_KEYS } from './keyCatalog.ts'
import { createWorkspaceUiPreferences } from '../ui-preferences.ts'
import { copyTerminalText, terminalSelection, terminalTextInput } from './clipboard.ts'
import type { TerminalTranslate } from './locales.ts'
import { readTerminalCopySnapshot, type TerminalSnapshotApi, type TerminalTextSnapshot } from './snapshot.ts'
import { attachTerminalGestures } from './gestures.ts'

type TerminalThemeHook = <T>(selector: (snapshot: ThemeSnapshot) => T) => T
export interface TerminalViewAccessoryState {
  readonly view: TerminalPublicView
  readonly state: TerminalViewState
  readonly fontSize: number
  readonly visible: boolean
  setFontSize(size: number): void
}
/** Explicit source-specific accessories; neither path replaces the official body. */
export interface TerminalViewAccessories {
  readCopy?(local: { text: string; selected: boolean }, signal: AbortSignal): Promise<TerminalTextSnapshot>
  toolbar?(state: TerminalViewAccessoryState): ReactNode
}
export type TerminalBodyFace = PropsRuntime<'sidebar.right.pane.tab'> & {
  view: (key: string) => TerminalPublicView; useTheme: TerminalThemeHook
  hapiTerminalActions?: TerminalViewAccessories | undefined
}
const composedBodies = new WeakSet<object>()
/** Reusing the active keyed seat must not add a second toolbar or input owner. */
export function hasTerminalControls(component: unknown): boolean {
  return (typeof component === 'object' && component !== null || typeof component === 'function') && composedBodies.has(component)
}
function CopyText({ snapshot, t }: { snapshot: TerminalTextSnapshot; t: TerminalTranslate }) {
  const content = useRef<HTMLDivElement>(null), pre = useRef<HTMLPreElement>(null), previous = useRef<{ top: number; height: number } | null>(null)
  const [status, setStatus] = useState(''), [shown, setShown] = useState(200)
  const remaining = Math.max(0, snapshot.lines.length - shown), text = snapshot.lines.slice(remaining).join('\n')
  useLayoutEffect(() => {
    const element = pre.current
    if (!element) return
    element.scrollTop = previous.current ? previous.current.top + element.scrollHeight - previous.current.height : element.scrollHeight
    previous.current = null
  }, [shown])
  return <div ref={content}><p className="hapi-terminal-hint">{t(snapshot.kind === 'selected' ? 'terminal.copy.selected' : snapshot.kind === 'source' ? 'terminal.copy.source' : snapshot.kind === 'legacy' ? 'terminal.copy.legacy' : 'terminal.copy.visible')}</p>
    {(snapshot.kind === 'source' || snapshot.kind === 'legacy') && <>
      <p className="hapi-terminal-hint">{t(snapshot.kind === 'legacy' ? 'terminal.copy.legacyBounded' : 'terminal.copy.sourceBounded')}</p>
      <p className="hapi-terminal-hint">{t(snapshot.kind === 'legacy' ? 'terminal.copy.legacyCaptured' : 'terminal.copy.captured').replace('{time}', new Date(snapshot.value.capturedAt).toLocaleTimeString()).replace('{sequence}', String(snapshot.value.sequence))}</p>
      {snapshot.value.localLimitReached && <p role="alert">{t('terminal.copy.localLimit')}</p>}
      {snapshot.kind === 'legacy' && snapshot.value.replayIssue && <p role="alert">{t('terminal.copy.replayIssue').replace('{issue}', snapshot.value.replayIssue)}</p>}
    </>}
    <p className="hapi-terminal-hint">{t('terminal.copy.description')}</p>
    {remaining > 0 && <button type="button" onClick={() => {
      previous.current = pre.current ? { top: pre.current.scrollTop, height: pre.current.scrollHeight } : null
      setShown(value => value + 200)
    }}>{t('terminal.copy.loadMore').replace('{count}', String(remaining))}</button>}
    <pre ref={pre} tabIndex={0} aria-label={t('terminal.copy.textLabel')}>{text}</pre>
    <p className="hapi-terminal-copy-status" role="status">{status}</p><button type="button" disabled={!text} onClick={() => { void (async () => {
      const selection = window.getSelection(), selected = selection?.anchorNode && selection.focusNode && pre.current?.contains(selection.anchorNode) && pre.current.contains(selection.focusNode) ? selection.toString() : ''
      const copied = await copyTerminalText(selected || text, content.current!)
      setStatus(t(copied ? 'terminal.copy.success' : 'terminal.copy.failed'))
    })() }}>{t('button.copy')}</button></div>
}

type CopyState = { state: 'loading' } | { state: 'ready'; snapshot: TerminalTextSnapshot } | { state: 'failed'; error: string }

export function composedTerminalBody(ctx: Context, Official: ComponentType<TerminalBodyFace>, t: TerminalTranslate, api?: TerminalSnapshotApi): (props: TerminalBodyFace) => ReactNode {
  function ComposedTerminal(props: TerminalBodyFace) {
    const { tab } = props.useTabInfo(), original = props.view(tab.id)
    const native = props.useProjection('hapi'), observed = props.useProjection('hapiObserved')
    const controls = useMemo(() => new TerminalInputControls(original), [original])
    useEffect(() => () => controls.dispose(), [controls])
    const face = useMemo(() => (key: string): TerminalPublicView => key === tab.id ? controls.view : props.view(key), [tab.id, controls, props.view])
    const state = useSyncExternalStore(original.state.subscribe, original.state.getSnapshot)
    const keyboard = useSyncExternalStore(controls.subscribe, controls.getSnapshot)
    useEffect(() => { if (!tab.visible) controls.clear() }, [controls, tab.visible])
    const officialTheme = props.useTheme(value => value), baseFont = officialTheme.fontSizes.terminal
    const [pinchFont, setPinchFont] = useState<{ base: number; size: number } | null>(null)
    const localFont = pinchFont?.base === baseFont ? pinchFont.size : baseFont
    const fontState = useRef({ base: baseFont, local: localFont, visible: tab.visible })
    fontState.current = { base: baseFont, local: localFont, visible: tab.visible }
    useEffect(() => { setPinchFont(null) }, [baseFont, original])
    const useOccurrenceTheme = useMemo<TerminalThemeHook>(() => {
      let source: ThemeSnapshot | undefined, mapped: ThemeSnapshot | undefined
      return function useOccurrenceTheme<T>(selector: (snapshot: ThemeSnapshot) => T): T {
        return props.useTheme(snapshot => {
          if (snapshot !== source) {
            source = snapshot
            mapped = snapshot.fontSizes.terminal === localFont ? snapshot : { ...snapshot, fontSizes: { ...snapshot.fontSizes, terminal: localFont } }
          }
          return selector(mapped!)
        })
      }
    }, [props.useTheme, localFont])
    const officialBody = useRef<HTMLDivElement>(null)
    useEffect(() => {
      const container = officialBody.current
      if (!container || !tab.visible) return
      return attachTerminalGestures(container, {
        visible: () => fontState.current.visible && container.ownerDocument.visibilityState !== 'hidden',
        fontSize: () => fontState.current.local,
        setFontSize: size => { setPinchFont({ base: fontState.current.base, size }) },
        mode: () => controls.gestureMode,
        focus: () => { if (controls.writable) terminalTextInput(container)?.focus({ preventScroll: true }) },
      })
    }, [controls, tab.visible])
    useSyncExternalStore(listener => ctx.locale.subscribe(listener), () => ctx.locale.getSnapshot())
    const storage = useMemo(() => {
      const shared = ctx.get('hapiWorkspacePane')?.preferences
      if (shared) return { value: shared, dispose() {} }
      let local: Storage | undefined
      try { local = window.localStorage } catch { /* Temporary view preferences remain usable. */ }
      const value = createWorkspaceUiPreferences(local, window)
      return { value, dispose: () => value.dispose() }
    }, [])
    const preferences = useMemo(() => new TerminalPreferences(storage.value), [storage])
    useEffect(() => () => { preferences.dispose(); storage.dispose() }, [preferences, storage])
    const saved = useSyncExternalStore(preferences.subscribe, preferences.getSnapshot)
    const root = useRef<HTMLDivElement>(null), commandInput = useRef<HTMLInputElement>(null)
    const alive = useRef(true), copyRequest = useRef<AbortController | null>(null)
    useEffect(() => { alive.current = true; return () => { alive.current = false; copyRequest.current?.abort() } }, [])
    const [customize, setCustomize] = useState(false), [more, setMore] = useState(false), [snippets, setSnippets] = useState(false)
    const [commandMode, setCommandMode] = useState(false), [command, setCommand] = useState('')
    const [copy, setCopy] = useState<CopyState | null>(null), [paste, setPaste] = useState<string | null>(null)
    useEffect(() => () => { copyRequest.current?.abort(); copyRequest.current = null }, [original])
    useEffect(() => { if (!tab.visible) { copyRequest.current?.abort(); copyRequest.current = null; setCopy(null) } }, [tab.visible])
    const writable = state.writable && state.phase === 'connected' && state.info?.state === 'running'
    const focus = (): void => { terminalTextInput(root.current)?.focus({ preventScroll: true }) }
    const blur = (): void => { terminalTextInput(root.current)?.blur() }
    const readCopy = (): void => {
      const selection = terminalSelection(root.current), abort = new AbortController()
      copyRequest.current?.abort(); copyRequest.current = abort; setCopy({ state: 'loading' }); blur()
      const reading = props.hapiTerminalActions?.readCopy
        ? props.hapiTerminalActions.readCopy(selection, abort.signal)
        : readTerminalCopySnapshot(api, native ?? observed, !!observed?.sidechain, original.id, selection, abort.signal)
      void reading
        .then(snapshot => { if (alive.current && !abort.signal.aborted) setCopy({ state: 'ready', snapshot }) })
        .catch(error => { if (alive.current && !abort.signal.aborted) setCopy({ state: 'failed', error: error instanceof Error ? error.message : String(error) }) })
    }
    const readPaste = (): void => {
      if (!writable) return
      if (!navigator.clipboard?.readText) { setPaste(''); blur(); return }
      void navigator.clipboard.readText().then(text => { if (alive.current && controls.paste(text)) focus() }).catch(() => { if (alive.current) { setPaste(''); blur() } })
    }
    const keys = saved.keys.filter(key => key.row === 0 && key.send || key.id.startsWith('custom-') && key.send)
    return <div className="hapi-terminal-composed" ref={root} data-hapi-terminal-controls data-terminal-font={localFont}>
      {props.hapiTerminalActions?.toolbar?.({ view: original, state, fontSize: localFont, visible: tab.visible,
        setFontSize: size => { if (Number.isFinite(size)) setPinchFont({ base: baseFont, size: Math.max(9, Math.min(28, size)) }) },
      })}
      <div className="hapi-terminal-official" ref={officialBody}>{createElement(Official, { ...props, view: face, useTheme: useOccurrenceTheme })}</div>
      {!controls.modes.alternateBuffer && controls.modes.mouseWheelReporting && <p className="hapi-terminal-hint" data-hapi-terminal-touch-unavailable>{t('terminal.gesture.mouseCapture')}</p>}
      {commandMode && <form className="hapi-terminal-command" onSubmit={event => {
        event.preventDefault(); if (!writable || !command) return; if (controls.command(command)) setCommand('')
      }}><input ref={commandInput} aria-label={t('terminal.command.inputLabel')} placeholder={t('terminal.command.placeholder')} value={command} onChange={event => setCommand(event.target.value)}
          autoCapitalize="none" autoComplete="off" autoCorrect="off" spellCheck={false}/><button type="submit" disabled={!writable || !command}>{t('terminal.command.run')}</button></form>}
      <TouchBar t={t} keys={saved.keys} disabled={!writable || !tab.visible} readOnlyActionsAvailable={tab.visible} settings={saved.settings} modifiers={keyboard.modifiers} lockedModifiers={keyboard.locked}
        onToggleModifier={modifier => controls.toggle(modifier)} onLockModifier={modifier => controls.toggle(modifier, true)}
        onPress={data => controls.press(data)} resolveSequence={data => controls.resolve(data)} onRepeat={data => controls.repeat(data)} onResetModifiers={() => {}}
        commandMode={commandMode} onCommand={() => { setCommandMode(value => !value); blur(); setTimeout(() => commandInput.current?.focus(), 0) }}
        onSnippets={() => { setSnippets(true); blur() }} onMoreKeys={() => { setMore(true); blur() }} onCustomize={() => { setCustomize(true); blur() }}
        onCopy={readCopy} onPaste={readPaste}
        onKeyboard={() => { if (commandMode) setCommandMode(false); const input = terminalTextInput(root.current); if (input === document.activeElement) input?.blur(); else input?.focus({ preventScroll: true }) }}/>
      {saved.error && <p className="hapi-terminal-preference-error" role="alert">{saved.error}</p>}
      <KeyEditor t={t} error={saved.error} open={customize} keys={saved.keys} settings={saved.settings} onChange={keys => { preferences.updateKeys(keys) }} onSettingsChange={settings => { preferences.updateSettings(settings) }} onClose={() => { setCustomize(false); focus() }}/>
      <TerminalDialog open={more} title={t('terminal.keys.more')} closeLabel={t('button.close')} onClose={() => { setMore(false); focus() }}>
        <div className="hapi-terminal-more">{BUILTIN_KEYS.filter(key => key.send && !saved.keys.some(saved => saved.row !== 0 && saved.send === key.send && !saved.action && !saved.modifier)).map(key =>
          <button type="button" key={key.id} disabled={!writable} onClick={() => controls.press(key.send)}>{key.label}</button>)}</div>
      </TerminalDialog>
      <TerminalDialog open={snippets} title={t('terminal.keys.snippets')} closeLabel={t('button.close')} onClose={() => { setSnippets(false); focus() }}>
        <div className="hapi-terminal-more">{keys.length ? keys.map(key => <button type="button" key={key.id} disabled={!writable} onClick={() => { controls.press(key.send); setSnippets(false); focus() }}>{key.label}</button>) : <p>{t('terminal.keys.emptySnippets')}</p>}</div>
        <button type="button" onClick={() => { setSnippets(false); setCustomize(true) }}>{t('terminal.keys.edit')}</button>
      </TerminalDialog>
      <TerminalDialog open={copy !== null} title={t('terminal.copy.title')} closeLabel={t('button.close')} onClose={() => { copyRequest.current?.abort(); copyRequest.current = null; setCopy(null); focus() }}>
        {copy?.state === 'loading' && <p role="status">{t('terminal.copy.loading')}</p>}
        {copy?.state === 'failed' && <><p role="alert">{t('terminal.copy.readFailed')} {copy.error}</p><button type="button" onClick={readCopy}>{t('terminal.copy.retry')}</button></>}
        {copy?.state === 'ready' && <CopyText snapshot={copy.snapshot} t={t}/>}
      </TerminalDialog>
      <TerminalDialog open={paste !== null} title={t('terminal.paste.fallbackTitle')} description={t('terminal.paste.fallbackDescription')} closeLabel={t('button.close')} onClose={() => { setPaste(null); focus() }}>
        <textarea aria-label={t('terminal.paste.fallbackTitle')} placeholder={t('terminal.paste.placeholder')} value={paste ?? ''} onChange={event => setPaste(event.target.value)} autoCapitalize="none" autoCorrect="off" spellCheck={false}/>
        <button type="button" disabled={!writable || !paste} onClick={() => { if (paste && controls.paste(paste)) { setPaste(null); focus() } }}>{t('button.paste')}</button>
      </TerminalDialog>
    </div>
  }
  const body = (props: TerminalBodyFace) => typeof props.view === 'function' && typeof props.useTheme === 'function' ? <ComposedTerminal {...props}/> : createElement(Official, props)
  composedBodies.add(body)
  return body
}
