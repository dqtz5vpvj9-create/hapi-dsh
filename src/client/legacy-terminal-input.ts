/** Keyboard controls for the original HAPI SessionTerminal protocol.
 * This is not a DSH TerminalView: the existing replay-gated socket owns writes. */
import { terminalKey } from './workbench-model.ts'
import type { TerminalModifier } from './source-terminal/types.ts'

type Modifiers = Record<TerminalModifier, boolean>
const empty = (): Modifiers => ({ ctrl: false, alt: false, shift: false })
export interface LegacyTerminalInputTarget {
  writable(): boolean
  applicationCursor(): boolean
  bracketedPaste(): boolean
  /** True means accepted by the existing browser socket, not executed by a shell. */
  write(data: string): boolean
}
export interface LegacyTerminalKeysState { modifiers: Modifiers; locked: Modifiers }
export class LegacyTerminalInputControls {
  private state: LegacyTerminalKeysState = { modifiers: empty(), locked: empty() }
  private readonly listeners = new Set<() => void>()
  constructor(private readonly target: LegacyTerminalInputTarget) {}
  getSnapshot = (): LegacyTerminalKeysState => this.state
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  get writable(): boolean { return this.target.writable() }
  toggle(modifier: TerminalModifier, lock = false): void {
    if (!this.writable) return
    const active = lock ? !this.state.locked[modifier] : !this.state.modifiers[modifier]
    this.publish({ locked: { ...this.state.locked, [modifier]: lock && active }, modifiers: { ...this.state.modifiers, [modifier]: active } })
  }
  clear(): void {
    if (Object.values(this.state.modifiers).some(Boolean) || Object.values(this.state.locked).some(Boolean)) this.publish({ modifiers: empty(), locked: empty() })
  }
  resolve(data: string): string { return terminalKey(data, this.state.modifiers, this.target.applicationCursor()) }
  /** xterm has already encoded physical input for its current modes. */
  type(data: string): boolean { return this.write(terminalKey(data, this.state.modifiers)) }
  press(data: string): boolean { return this.write(this.resolve(data)) }
  repeat(sequence: string): boolean { return this.write(sequence) }
  paste(text: string): boolean {
    if (!this.writable || !text) return false
    const normalized = text.replace(/\r?\n/g, '\r')
    const accepted = this.target.write(this.target.bracketedPaste() ? `\x1b[200~${normalized}\x1b[201~` : normalized)
    if (accepted) this.clear()
    return accepted
  }
  command(text: string): boolean {
    if (!this.writable || !text) return false
    const accepted = this.target.write(text.replace(/\r?\n/g, '\r') + '\r')
    if (accepted) this.clear()
    return accepted
  }
  private write(data: string): boolean {
    if (!this.writable || !data || !this.target.write(data)) return false
    this.publish({ modifiers: { ...this.state.locked } }); return true
  }
  private publish(patch: Partial<LegacyTerminalKeysState>): void { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener() }
  dispose(): void { this.clear(); this.listeners.clear() }
}
