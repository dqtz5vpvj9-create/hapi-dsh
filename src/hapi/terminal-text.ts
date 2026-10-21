/** Read one retained source screen without taking input control or opening a PTY. */
import headless from '@xterm/headless'
import { HapiRequestError } from '../codex/contracts.ts'
import type { HapiClient } from './client.ts'
import { connectMachineTerminal, machineTerminalReplaySchema, sourceMachineTerminalPrefix, type MachineTerminalConnector } from './machine-terminals.ts'
import { MAX_TERMINAL_TEXT_BYTES, MAX_TERMINAL_TEXT_ROWS, type WorkbenchResponse, type WorkbenchSource } from '../workbench-types.ts'

/** Public xterm buffer API only. The decoder has no source input callback. */
export async function decodeRetainedTerminalText(screen: string, cols: number, rows: number, signal: AbortSignal): Promise<{ lines: string[]; localLimitReached: boolean }> {
  signal.throwIfAborted()
  if (!Number.isInteger(cols) || cols < 2 || cols > 500 || !Number.isInteger(rows) || rows < 1 || rows > 200) throw new Error('Invalid source terminal dimensions')
  if (Buffer.byteLength(screen, 'utf8') > 16 * 1024 * 1024) throw new HapiRequestError('Source terminal snapshot exceeds the supported size', 'rejected', 413, 'too-large')
  const capacity = Math.min(MAX_TERMINAL_TEXT_ROWS, Math.floor(2_000_000 / cols))
  const terminal = new headless.Terminal({ cols, rows, scrollback: Math.max(0, capacity - rows), allowProposedApi: true })
  try {
    await new Promise<void>((resolve, reject) => {
      const abort = (): void => { signal.removeEventListener('abort', abort); reject(signal.reason ?? new Error('Terminal text read cancelled')) }
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) { abort(); return }
      terminal.write(screen, () => { signal.removeEventListener('abort', abort); resolve() })
    })
    signal.throwIfAborted()
    const buffer = terminal.buffer.active, lines: string[] = []
    let localLimitReached = buffer.length >= capacity
    // Same wrapping rule as the original HAPI SelectOverlay, over a read-only
    // decoder of the source's own serialized snapshot instead of another view.
    for (let index = 0; index < buffer.length; index++) {
      const line = buffer.getLine(index), text = line?.translateToString(!buffer.getLine(index + 1)?.isWrapped) ?? ''
      if (line?.isWrapped && lines.length) lines[lines.length - 1] += text
      else lines.push(text)
    }
    while (lines.length && lines.at(-1) === '') lines.pop()
    const bounded: string[] = []; let bytes = 0
    for (let index = lines.length - 1; index >= 0; index--) {
      let line = lines[index]!, size = Buffer.byteLength(line, 'utf8') + (bounded.length ? 1 : 0)
      if (bytes + size > MAX_TERMINAL_TEXT_BYTES || bounded.length >= MAX_TERMINAL_TEXT_ROWS) {
        localLimitReached = true
        // A single huge wrapped line may exceed the text cap. Retain its tail
        // on Unicode boundaries and explicitly mark the local limitation.
        if (!bounded.length) {
          const tail: string[] = []; let available = MAX_TERMINAL_TEXT_BYTES
          for (const character of [...line].reverse()) { const length = Buffer.byteLength(character, 'utf8'); if (length > available) break; tail.push(character); available -= length }
          line = tail.reverse().join(''); size = Buffer.byteLength(line, 'utf8'); bounded.push(line); bytes += size
        }
        break
      }
      bounded.push(line); bytes += size
    }
    return { lines: bounded.reverse(), localLimitReached }
  } finally { terminal.dispose() }
}

export async function readSourceTerminalText(authentication: Awaited<ReturnType<HapiClient['socketAuthentication']>>,
  source: WorkbenchSource, machineId: string, terminalId: string, signal: AbortSignal,
  connect: MachineTerminalConnector = connectMachineTerminal): Promise<WorkbenchResponse<'nativeTerminalText'>> {
  signal.throwIfAborted()
  if (!/^[\w-]{1,128}$/u.test(terminalId)) throw new HapiRequestError('Invalid source terminal identity', 'rejected', 400)
  const rawId = sourceMachineTerminalPrefix(source, machineId) + terminalId
  const channel = await connect(authentication, signal)
  try {
    // In the pinned HAPI protocol attach reads replay only. claim is a distinct
    // command and is deliberately never issued by this read-only viewer.
    const result = machineTerminalReplaySchema.safeParse(await channel.request(machineId, { type: 'attach', terminalId: rawId }, signal))
    if (!result.success || !result.data.reset || result.data.terminal.terminalId !== rawId || result.data.seq !== result.data.terminal.seq) {
      throw new HapiRequestError('The source did not return this terminal’s complete retained screen', 'rejected', 502, 'protocol_mismatch')
    }
    const replay = result.data, text = await decodeRetainedTerminalText(replay.data, replay.terminal.cols, replay.terminal.rows, signal)
    return { terminalId, title: replay.terminal.title, cwd: replay.terminal.cwd, sequence: replay.seq,
      capturedAt: Date.now(), ...text, sourceHistory: 'bounded-unknown' }
  } finally {
    // The source bridge gives each socket its own peer. Closing this viewer
    // releases no other viewer's input lease, and never terminates the process.
    channel.close()
  }
}
