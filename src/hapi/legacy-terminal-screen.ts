/** A real, bounded decoder of observed legacy output; never a source PTY. */
import headless from '@xterm/headless'
import serialize from '@xterm/addon-serialize'
import { MAX_LEGACY_TERMINAL_TEXT_BYTES, MAX_LEGACY_TERMINAL_TEXT_ROWS } from '../legacy-terminal-text-types.ts'

export class LegacyTerminalScreen {
  private readonly terminal: headless.Terminal
  private readonly serializer = new serialize.SerializeAddon()
  private disposed = false
  constructor(cols: number, rows: number, scrollback: number) {
    this.terminal = new headless.Terminal({ cols, rows, scrollback, allowProposedApi: true })
    this.terminal.loadAddon(this.serializer)
    // No onData callback is installed: parsing a retained screen must not send
    // terminal responses or any other input back to the original process.
  }
  get cols(): number { return this.terminal.cols }
  get rows(): number { return this.terminal.rows }
  write(data: string): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('Legacy terminal screen was disposed'))
    if (!data) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      try { this.terminal.write(data, resolve) } catch (error) { reject(error) }
    })
  }
  resize(cols: number, rows: number): void { this.terminal.resize(cols, rows) }
  reset(): void { this.terminal.reset() }
  snapshot(): string {
    if (this.disposed) throw new Error('Legacy terminal screen was disposed')
    return this.serializer.serialize()
  }
  text(): { lines: string[]; localLimitReached: boolean } {
    if (this.disposed) throw new Error('Legacy terminal screen was disposed')
    const buffer = this.terminal.buffer.active, lines: string[] = []
    let localLimitReached = buffer.length >= this.terminal.rows + (this.terminal.options.scrollback ?? 0)
    // The original SelectOverlay joins wrapped rows. Public xterm cells are
    // decoded here; no escape sequences, source query, or process metadata.
    for (let index = 0; index < buffer.length; index++) {
      const line = buffer.getLine(index), text = line?.translateToString(!buffer.getLine(index + 1)?.isWrapped) ?? ''
      if (line?.isWrapped && lines.length) lines[lines.length - 1] += text
      else lines.push(text)
    }
    while (lines.at(-1) === '') lines.pop()
    const bounded: string[] = []; let bytes = 0
    for (let index = lines.length - 1; index >= 0; index--) {
      const line = lines[index]!, separator = bounded.length ? 1 : 0
      const size = Buffer.byteLength(line, 'utf8') + separator
      if (bytes + size > MAX_LEGACY_TERMINAL_TEXT_BYTES || bounded.length >= MAX_LEGACY_TERMINAL_TEXT_ROWS) {
        localLimitReached = true
        if (bounded.length < MAX_LEGACY_TERMINAL_TEXT_ROWS) {
          const tail: string[] = []; let available = MAX_LEGACY_TERMINAL_TEXT_BYTES - bytes - separator
          for (let end = line.length; end > 0;) {
            let start = end - 1
            const low = line.charCodeAt(start), high = line.charCodeAt(start - 1)
            if (low >= 0xdc00 && low <= 0xdfff && start > 0 && high >= 0xd800 && high <= 0xdbff) start--
            const character = line.slice(start, end), length = Buffer.byteLength(character, 'utf8')
            if (length > available) break
            tail.push(character); available -= length; end = start
          }
          if (tail.length) bounded.push(tail.reverse().join(''))
        }
        break
      }
      bounded.push(line); bytes += size
    }
    return { lines: bounded.reverse(), localLimitReached }
  }
  dispose(): void { if (!this.disposed) { this.disposed = true; this.terminal.dispose() } }
}
