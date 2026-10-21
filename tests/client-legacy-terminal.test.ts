import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LegacyTerminalInputControls } from '../src/client/legacy-terminal-input.ts'

function setup() {
  const state = { writable: true, applicationCursor: false, bracketedPaste: false, accept: true }
  const writes: string[] = []
  const controls = new LegacyTerminalInputControls({ writable: () => state.writable,
    applicationCursor: () => state.applicationCursor, bracketedPaste: () => state.bracketedPaste,
    write: data => { if (!state.accept) return false; writes.push(data); return true } })
  return { controls, writes, state }
}

test('legacy one-shot and locked modifiers act on the existing writer without inventing terminal state', () => {
  const { controls, writes } = setup()
  controls.toggle('ctrl'); assert.equal(controls.type('c'), true); controls.type('n')
  assert.deepEqual(writes, ['\x03', 'n']); assert.equal(controls.getSnapshot().modifiers.ctrl, false)
  controls.toggle('ctrl', true); controls.type('c'); controls.type('n')
  assert.deepEqual(writes.slice(2), ['\x03', '\x0e']); assert.equal(controls.getSnapshot().locked.ctrl, true)
  controls.toggle('ctrl'); controls.type('c'); assert.equal(writes.at(-1), 'c')
  controls.toggle('shift'); controls.press('\t'); assert.equal(writes.at(-1), '\x1b[Z')
  controls.dispose()
})

test('touch navigation follows actual application mode and hold-repeat preserves its captured sequence', () => {
  const { controls, writes, state } = setup(); state.applicationCursor = true
  controls.press('\x1b[A'); assert.equal(writes.at(-1), '\x1bOA')
  controls.type('\x1bOB'); assert.equal(writes.at(-1), '\x1bOB', 'Physical xterm input is already encoded')
  controls.toggle('ctrl'); controls.toggle('alt')
  const held = controls.resolve('\x1b[D'); controls.repeat(held); controls.repeat(held)
  assert.deepEqual(writes.slice(-2), ['\x1b[1;7D', '\x1b[1;7D'])
  assert.equal(controls.getSnapshot().modifiers.ctrl, false)
  controls.dispose()
})

test('source replay admission or rejected writes cannot consume a modifier or send a buffered command later', () => {
  const { controls, writes, state } = setup(); controls.toggle('ctrl'); state.accept = false
  assert.equal(controls.press('c'), false); assert.equal(controls.getSnapshot().modifiers.ctrl, true)
  assert.equal(controls.command('unchanged command draft'), false)
  state.writable = false; state.accept = true
  assert.equal(controls.press('c'), false); assert.equal(controls.paste('not delivered'), false)
  controls.toggle('alt'); assert.equal(controls.getSnapshot().modifiers.alt, false)
  state.writable = true; assert.deepEqual(writes, [], 'No automatic replay occurs after reconnect')
  controls.clear(); controls.command('explicit later command'); assert.deepEqual(writes, ['explicit later command\r'])
  controls.dispose()
})

test('paste and command use original terminal modes, exact macros and normalized line endings', () => {
  const { controls, writes, state } = setup(); state.bracketedPaste = true
  controls.toggle('ctrl', true); controls.paste('first\r\nsecond\nthird')
  assert.equal(writes[0], '\x1b[200~first\rsecond\rthird\x1b[201~')
  assert.equal(controls.getSnapshot().locked.ctrl, false)
  controls.command('printf one\nprintf two'); assert.equal(writes[1], 'printf one\rprintf two\r')
  controls.press('echo exact macro\r'); assert.equal(writes[2], 'echo exact macro\r')
  assert.equal(controls.command(''), false); assert.equal(controls.paste(''), false)
  controls.dispose()
})
