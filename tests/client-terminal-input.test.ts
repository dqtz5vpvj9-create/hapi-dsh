import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TerminalInputControls, TerminalInputModes, type TerminalPublicView } from '../src/client/source-terminal/input.ts'
import type { TerminalViewState } from '@deepseek-ai/dsh-api-terminal-controller/client'
import headless from '@xterm/headless'

test('terminal mode observer accepts split control sequences and follows ESC termination of OSC/DCS payloads', () => {
  const modes = new TerminalInputModes()
  modes.feed('\x1b[?1;20'); modes.feed('04h'); assert.equal(modes.applicationCursor, true); assert.equal(modes.bracketedPaste, true)
  modes.feed('\x1b]0;title [ ? 1 l\x07'); assert.equal(modes.applicationCursor, true)
  modes.feed('\x1b]0;title \x1b[?1l\x07'); assert.equal(modes.applicationCursor, false)
  modes.feed('\x1bPquoted\x1b[?2004l\x1b\\'); assert.equal(modes.bracketedPaste, false)
  modes.feed('\x9dtitle\x1b[?2004h\x9c'); assert.equal(modes.bracketedPaste, true)
  modes.feed('\x1b[?1l'); assert.equal(modes.applicationCursor, false)
  modes.feed('\x1b[?10'); modes.feed('49h'); assert.equal(modes.alternateBuffer, true)
  modes.feed('\x1b[?1000h'); assert.equal(modes.mouseWheelReporting, true)
  modes.feed('\x1b]0;title\x1b[?1049;1000l\x07'); assert.equal(modes.alternateBuffer, false); assert.equal(modes.mouseWheelReporting, false)
  modes.feed('\x1b[?9h'); assert.equal(modes.mouseWheelReporting, false)
  modes.feed('\x1b[?9;1003h'); assert.equal(modes.mouseWheelReporting, true)
  modes.feed('\x1b[?1002l'); assert.equal(modes.mouseWheelReporting, false)
  modes.feed('\x1b[?47l'); assert.equal(modes.alternateBuffer, false)
  modes.feed('\x1bc'); assert.equal(modes.bracketedPaste, false)
})

test('touch mode observation matches the pinned public xterm modes, including fragmented control-string and CSI edge cases', async () => {
  const cases = [
    '\x1b[?1;2004;1049;1000h', '\x1b[?1;2004;1049;1000l',
    '\x1b]0;title \x1b[?1049h\x07', '\x1bPquoted\x1b[?1000h\x1b\\',
    '\x1b[?01049:1h', '\x1b[?10\x0749l', '\x1b[?001;02004h',
    '\x1b[?' + '000000;'.repeat(31) + '1049h',
    '\x1b[?' + '0;'.repeat(32) + '1049l', '\x1b[?1003;9h', '\x1b[?9;1002h',
    '\x1b[0!p', '\x1b[?1002l', '\x1b[?47l', '\x1b[?1049h\x1bc',
  ]
  const terminal = new headless.Terminal({ allowProposedApi: true }), modes = new TerminalInputModes()
  try {
    for (const value of cases) {
      for (const character of value) modes.feed(character)
      await new Promise<void>(resolve => terminal.write(value, resolve))
      assert.deepEqual({ alternate: modes.alternateBuffer, mouseWheel: modes.mouseWheelReporting, cursor: modes.applicationCursor, paste: modes.bracketedPaste },
        { alternate: terminal.buffer.active.type === 'alternate', mouseWheel: ['vt200', 'drag', 'any'].includes(terminal.modes.mouseTrackingMode),
          cursor: terminal.modes.applicationCursorKeysMode, paste: terminal.modes.bracketedPasteMode }, JSON.stringify(value))
    }
  } finally { terminal.dispose() }
  modes.feed('\x1b[?' + '0'.repeat(4096) + '1049h')
  assert.equal(modes.gestureModesKnown, false, 'a bounded observer cannot admit wheels after an unobserved mode')
  modes.feed('\x1bc'); assert.equal(modes.gestureModesKnown, true)
})

test('touch wheels require original renderer ACK and never turn normal inertia into unconfirmed alternate or mouse input', () => {
  let state = { phase: 'connected', writable: true, info: { state: 'running' }, environment: { scrollback: 1000 },
    render: { revision: 1, frame: { type: 'snapshot', screen: '' } } } as TerminalViewState
  const listeners = new Set<() => void>(), acknowledgements: number[] = []
  const original = { id: 'gesture-fixture', state: { getSnapshot: () => state, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } } },
    acknowledge: (revision: number) => { acknowledgements.push(revision) }, write: () => assert.fail('A mode observer must not send any input'),
  } as unknown as TerminalPublicView
  const controls = new TerminalInputControls(original)
  const output = (data: string): number => {
    const revision = state.render!.revision + 1
    state = { ...state, render: { revision, frame: { type: 'output', data } } } as TerminalViewState
    for (const listener of listeners) listener()
    return revision
  }
  assert.equal(controls.gestureMode, 'blocked'); controls.view.acknowledge(1); assert.equal(controls.gestureMode, 'normal')
  const alternate = output('\x1b[?1049h'); assert.equal(controls.gestureMode, 'blocked')
  controls.view.acknowledge(1); assert.equal(controls.gestureMode, 'blocked', 'a late old ACK cannot enable a different queued mode')
  controls.view.acknowledge(alternate); assert.equal(controls.gestureMode, 'alternate')
  state = { ...state, writable: false }; assert.equal(controls.gestureMode, 'blocked')
  state = { ...state, writable: true }
  const normal = output('\x1b[?1049l'); assert.equal(controls.gestureMode, 'blocked')
  controls.view.acknowledge(normal); assert.equal(controls.gestureMode, 'normal')
  controls.view.acknowledge(output('\x1b[?1000h')); assert.equal(controls.gestureMode, 'blocked', 'normal mouse reporting is not viewport scrolling')
  controls.view.acknowledge(output('\x1b[?1000l')); assert.equal(controls.gestureMode, 'normal')
  controls.view.acknowledge(output('\x1b[?' + '0'.repeat(4096) + '1049h')); assert.equal(controls.gestureMode, 'blocked', 'renderer ACK cannot make unknown mode parsing safe')
  controls.view.acknowledge(output('\x1bc')); assert.equal(controls.gestureMode, 'normal')
  state = { ...state, environment: { ...state.environment!, scrollback: 0 } }; assert.equal(controls.gestureMode, 'blocked')
  assert.equal(acknowledgements.length, 8); controls.dispose(); assert.equal(listeners.size, 0)
})

test('mobile, emulator, modifiers, paste, and repeats share one public write owner and never replay on reconnect', () => {
  let state = { phase: 'connected', writable: true, info: { state: 'running' } } as TerminalViewState
  const listeners = new Set<() => void>(), writes: string[] = [], acknowledged: number[] = []
  let mounts = 0, detaches = 0, closes = 0
  const original = { id: 'fixture-terminal', state: { getSnapshot: () => state, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } } },
    write: (data: string) => writes.push(data), mount: () => { mounts++; return () => { detaches++ } }, refresh: async () => {}, connect: () => {}, resize: () => {},
    acknowledge: (revision: number) => acknowledged.push(revision), rename: async () => {}, close: async () => { closes++ }, dispose: async () => {},
  } as unknown as TerminalPublicView
  const controls = new TerminalInputControls(original), detach = controls.view.mount()
  controls.toggle('ctrl'); controls.view.write('c'); controls.view.write('a')
  controls.toggle('alt', true); controls.press('x'); controls.press('y'); controls.toggle('alt')
  controls.modes.feed('\x1b[?1;2004h'); controls.press('\x1b[A'); controls.paste('line1\nline2')
  controls.toggle('ctrl'); const sequence = controls.resolve('\x1b[D'); controls.repeat(sequence); controls.repeat(sequence)
  controls.command('echo command')
  assert.deepEqual(writes, ['\x03', 'a', '\x1bx', '\x1by', '\x1bOA', '\x1b[200~line1\rline2\x1b[201~', '\x1b[1;5D', '\x1b[1;5D', 'echo command\r'])
  state = { ...state, phase: 'disconnected', writable: false }; for (const listener of listeners) listener()
  controls.press('dropped'); controls.paste('dropped')
  state = { ...state, phase: 'connected', writable: true }; for (const listener of listeners) listener()
  assert.equal(writes.length, 9); assert.equal(acknowledged.length, 0)
  controls.view.acknowledge(3); assert.deepEqual(acknowledged, [3])
  detach(); controls.dispose(); assert.equal(mounts, 1); assert.equal(detaches, 1); assert.equal(closes, 0)
})

test('command and paste drafts survive synchronous official input rejection without retrying after reconnection', () => {
  // Public-model fixture: the pinned TerminalView reports write admission
  // failures through state synchronously; its void write is not a source ACK.
  let state = { phase: 'connected', writable: true, info: { state: 'running' } } as TerminalViewState
  let reject = true
  const listeners = new Set<() => void>(), attempts: string[] = [], admitted: string[] = []
  const update = (patch: Partial<TerminalViewState>): void => {
    state = { ...state, ...patch }; for (const listener of listeners) listener()
  }
  const original = {
    id: 'input-admission-fixture',
    state: { getSnapshot: () => state, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } } },
    write: (data: string) => {
      attempts.push(data)
      if (reject) update({ phase: 'failed', writable: false, issue: 'inputFull' })
      else admitted.push(data)
    },
  } as unknown as TerminalPublicView
  const controls = new TerminalInputControls(original)
  let command = 'echo keep my command', paste = 'keep my pasted text'
  if (controls.command(command)) command = ''
  assert.equal(command, 'echo keep my command'); assert.deepEqual(admitted, [])
  assert.equal(controls.command(command), false, 'A disconnected input owner must not receive a second attempt')
  assert.equal(attempts.length, 1)
  update({ phase: 'connected', writable: true })
  if (controls.paste(paste)) paste = ''
  assert.equal(paste, 'keep my pasted text'); assert.equal(attempts.length, 2)
  assert.deepEqual(admitted, [])
  reject = false; update({ phase: 'connected', writable: true })
  assert.equal(attempts.length, 2, 'Returning connectivity does not replay either draft')
  if (controls.command(command)) command = ''
  assert.equal(command, ''); assert.deepEqual(admitted, ['echo keep my command\r'])
  update({ phase: 'disconnected', writable: false })
  update({ phase: 'connected', writable: true })
  assert.equal(attempts.length, 3, 'Lost later acknowledgement does not authorize re-sending an admitted command')
  controls.dispose(); assert.equal(listeners.size, 0)
})
