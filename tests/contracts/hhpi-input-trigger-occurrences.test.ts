import assert from 'node:assert/strict'
import test from 'node:test'
import { fixture } from './hhpi-reading-fixture.ts'

test('official Slash and command popup services resolve independent retained pane bindings', { timeout: 15000 }, async t => {
  const f = await fixture(t)
  const slash = f.officialPlugin('@deepseek-ai/dsh-client-ui-input-trigger')
  const commands = f.officialPlugin('@deepseek-ai/dsh-client-ui-commands')
  await f.ctx.plugin(slash.InputTriggerService as never)

  const runtime = new (commands.CommandUiRuntime as new (ctx: typeof f.ctx) => {
    popupFor(ctx: typeof f.ctx): object
  })(f.ctx)
  const a = await f.open('pane-a'), b = await f.open('pane-b')
  const input = f.ctx.get('inputTriggers') as { sessionOf(ctx: typeof a.binding.ctx): object }
  assert.equal(input.sessionOf(a.binding.ctx), input.sessionOf(a.binding.ctx))
  assert.notEqual(input.sessionOf(a.binding.ctx), input.sessionOf(b.binding.ctx), 'each pane gets an independent Slash controller')

  const popupA = runtime.popupFor(a.binding.ctx)
  const popupB = runtime.popupFor(b.binding.ctx)
  assert.equal(runtime.popupFor(a.binding.ctx), popupA)
  assert.notEqual(popupA, popupB, 'each pane gets an independent command popup')

  a.reference.release()
  assert.throws(() => input.sessionOf(a.binding.ctx), /requires a retained Session scope/)
  assert.throws(() => runtime.popupFor(a.binding.ctx), /requires a retained Session scope/)
  assert.equal(runtime.popupFor(b.binding.ctx), popupB, 'releasing one pane leaves its sibling input live')
})
