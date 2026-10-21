/** Optional mobile controls for the official TerminalView; no second connection or renderer. */
import type { TerminalView, TerminalViewState } from '@deepseek-ai/dsh-api-terminal-controller/client'
import { terminalKey } from '../workbench-model.ts'
import type { TerminalModifier } from './types.ts'
import type { TerminalGestureMode } from './gestures.ts'

export type TerminalPublicView = Pick<TerminalView, keyof TerminalView>
type Modifiers = Record<TerminalModifier, boolean>
const empty = (): Modifiers => ({ ctrl: false, alt: false, shift: false })

/** Observe documented DEC modes with the pinned renderer's control-string rules. */
export class TerminalInputModes {
  applicationCursor = false
  bracketedPaste = false
  alternateBuffer = false
  mouseWheelReporting = false
  gestureModesKnown = true
  private state: 'ground' | 'escape' | 'csi' | 'csi-ignore' | 'osc' | 'string' = 'ground'
  private parameters = ''
  reset(): void { this.applicationCursor = false; this.bracketedPaste = false; this.alternateBuffer = false; this.mouseWheelReporting = false; this.gestureModesKnown = true; this.state = 'ground'; this.parameters = '' }
  feed(data: string): void {
    for (const character of data) {
      const code = character.charCodeAt(0)
      // ESC terminates OSC/DCS and begins a new escape sequence. An embedded
      // ESC [ is active control syntax, not quoted text (verified against the
      // public @xterm/headless modes and buffer APIs).
      if (character === '\x1b') { this.state = 'escape'; this.parameters = ''; continue }
      if (character === '\x9b') { this.state = 'csi'; this.parameters = ''; continue }
      if (character === '\x9d') { this.state = 'osc'; this.parameters = ''; continue }
      if ('\x90\x98\x9e\x9f'.includes(character)) { this.state = 'string'; this.parameters = ''; continue }
      if (code === 0x18 || code === 0x1a || code >= 0x80 && code <= 0x9f) { this.state = 'ground'; this.parameters = ''; continue }
      if (this.state === 'osc' || this.state === 'string') {
        if (this.state === 'osc' && character === '\x07') this.state = 'ground'
        continue
      }
      // Executable C0 controls do not terminate an in-progress CSI. DEL is
      // ignored; CAN/SUB and C1 cancellation were handled above.
      if (code < 0x20 || code === 0x7f) continue
      if (this.state === 'escape') {
        if (character === '[') this.state = 'csi'
        else if (character === ']') this.state = 'osc'
        else if ('PX^_'.includes(character)) this.state = 'string'
        else { this.state = 'ground'; if (character === 'c') this.reset() }
        continue
      }
      if (this.state === 'csi-ignore') { if (code >= 0x40 && code <= 0x7e) this.state = 'ground'; continue }
      if (this.state !== 'csi') continue
      if (code >= 0x40 && code <= 0x7e) {
        if ((character === 'h' || character === 'l') && /^\?[0-9:;]*$/.test(this.parameters)) {
          // xterm retains 32 main parameters. Subparameters do not change
          // DECSET/DECRST's main values, and leading zeroes are accepted.
          for (const parameter of this.parameters.slice(1).split(';').slice(0, 32)) {
            const mode = Number(parameter.split(':')[0] || 0)
            if (mode === 1) this.applicationCursor = character === 'h'
            if (mode === 2004) this.bracketedPaste = character === 'h'
            if (mode === 47 || mode === 1047 || mode === 1049) this.alternateBuffer = character === 'h'
            // The pinned xterm selects one protocol; disabling any listed
            // mouse protocol returns to NONE. X10 does not report wheels.
            if (mode === 9 || mode === 1000 || mode === 1002 || mode === 1003) this.mouseWheelReporting = character === 'h' && mode !== 9
          }
        }
        if (character === 'p' && /^[0-9:;]*!$/.test(this.parameters)) { this.applicationCursor = false; this.bracketedPaste = false }
        this.state = 'ground'; this.parameters = ''
      } else if (code >= 0x20 && code <= 0x3f) {
        if (this.parameters.length < 4096) this.parameters += character
        else { this.gestureModesKnown = false; this.state = 'csi-ignore'; this.parameters = '' }
      }
      else { this.state = 'ground'; this.parameters = '' }
    }
  }
}

export interface TerminalKeysState { readonly modifiers: Modifiers; readonly locked: Modifiers; readonly revision: number }
/** Every route still calls the original view.write and its one sequence/ACK owner. */
export class TerminalInputControls {
  readonly modes = new TerminalInputModes()
  readonly view: TerminalPublicView
  private state: TerminalKeysState = { modifiers: empty(), locked: empty(), revision: 0 }
  private outputRevision = 0
  private acknowledgedRevision = 0
  private readonly listeners = new Set<() => void>()
  private readonly unobserve: () => void
  constructor(readonly original: TerminalPublicView) {
    this.view = {
      id: original.id, state: original.state,
      mount: () => original.mount(), refresh: () => original.refresh(), connect: () => original.connect(),
      acknowledge: revision => {
        // This public callback is invoked only after the original xterm has
        // parsed its frame. An earlier queued mode cannot admit touch inertia.
        if (original.state.getSnapshot().render?.revision === revision) this.acknowledgedRevision = revision
        original.acknowledge(revision)
      }, resize: (cols, rows) => original.resize(cols, rows),
      rename: title => original.rename(title), close: () => original.close(), dispose: () => original.dispose(),
      write: data => this.type(data),
    }
    const observe = (): void => this.observe(original.state.getSnapshot())
    this.unobserve = original.state.subscribe(observe); observe()
  }
  getSnapshot = (): TerminalKeysState => this.state
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  get writable(): boolean { const state = this.original.state.getSnapshot(); return state.writable && state.phase === 'connected' && state.info?.state === 'running' }
  get gestureMode(): TerminalGestureMode {
    const state = this.original.state.getSnapshot()
    if (!this.modes.gestureModesKnown || !state.render || state.render.revision !== this.acknowledgedRevision || state.render.revision !== this.outputRevision) return 'blocked'
    if (this.modes.alternateBuffer) return this.writable ? 'alternate' : 'blocked'
    // In the normal buffer a wheel must mean viewport scrolling, never an
    // application mouse report or no-scrollback arrow-key fallback.
    return !this.modes.mouseWheelReporting && (state.environment?.scrollback ?? 0) > 0 ? 'normal' : 'blocked'
  }
  toggle(modifier: TerminalModifier, lock = false): void {
    if (lock) {
      const locked = { ...this.state.locked, [modifier]: !this.state.locked[modifier] }
      this.publish({ locked, modifiers: { ...this.state.modifiers, [modifier]: locked[modifier] } })
    } else this.publish({ locked: { ...this.state.locked, [modifier]: false }, modifiers: { ...this.state.modifiers, [modifier]: !this.state.modifiers[modifier] } })
  }
  clear(): void { this.publish({ modifiers: empty(), locked: empty() }) }
  resolve(data: string): string { return terminalKey(data, this.state.modifiers, this.modes.applicationCursor) }
  /** Emulator input is already encoded for application mode. Only armed modifiers are added. */
  type(data: string): void { this.write(terminalKey(data, this.state.modifiers)); }
  press(data: string): void { this.write(this.resolve(data)) }
  /** Repeated keys retain the modifier sequence captured at pointer-down. */
  repeat(sequence: string): void { this.write(sequence) }
  paste(text: string): boolean {
    if (!this.writable || !text) return false
    const normalized = text.replace(/\r?\n/g, '\r')
    const accepted = this.write(this.modes.bracketedPaste ? `\x1b[200~${normalized}\x1b[201~` : normalized)
    if (accepted) this.clear()
    return accepted
  }
  /** True only means no synchronous rejection from the public input owner, never a source execution acknowledgement. */
  command(text: string): boolean {
    if (!this.writable || !text) return false
    const accepted = this.write(text.replace(/\r?\n/g, '\r') + '\r')
    if (accepted) this.clear()
    return accepted
  }
  private write(data: string): boolean {
    if (!this.writable || !data) return false
    this.original.write(data)
    // The official void write API reports inputFull/carrier failures through
    // its public observable state before returning. Preserve command/paste
    // drafts in that case; later ACK loss must still never authorize replay.
    if (!this.writable) return false
    this.publish({ modifiers: { ...this.state.locked } })
    return true
  }
  private observe(state: TerminalViewState): void {
    const render = state.render
    if (render && render.revision > this.outputRevision) {
      this.outputRevision = render.revision
      if (render.frame.type === 'snapshot') { this.modes.reset(); this.modes.feed(render.frame.screen) }
      else this.modes.feed(render.frame.data)
    }
    // An armed modifier cannot unexpectedly survive a lost control lease.
    if (!state.writable && (Object.values(this.state.modifiers).some(Boolean) || Object.values(this.state.locked).some(Boolean))) this.clear()
  }
  private publish(patch: Partial<TerminalKeysState>): void { this.state = { ...this.state, ...patch, revision: this.state.revision + 1 }; for (const listener of this.listeners) listener() }
  /** Releases observers only; official mount/dispose owns attachment lifetime. */
  dispose(): void { this.unobserve(); this.listeners.clear() }
}
