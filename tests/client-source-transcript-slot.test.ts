/** Official slot ownership is real; component rendering is covered separately. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import type { Context } from '@deepseek-ai/cordis'
import { installSourceTranscript } from '../src/client/source-transcript.tsx'
import { installComposerDetails } from '../src/client/composer-details.tsx'

test('source transcript and composer preserve the original child-slot declarations', async () => {
  const core = new SlotCore()
  const root = core.register({ name: 'root', children: {
    'conversation.chat.node': { kind: 'keyed', scope: 'session' },
    'conversation.composer.dock': { kind: 'list', scope: 'session' },
    'hapi.source.composer-details': { kind: 'list', scope: 'session' },
  } } as never, (() => null) as never)
  const Official = () => null
  const original = core.register({ name: 'conversation.chat.node', key: 'assistant-step', children: {
    'conversation.chat.reasoning.body': { kind: 'single', scope: 'session' },
    'conversation.chat.message.images': { kind: 'single', scope: 'session' },
  } } as never, Official as never)
  const stat = core.register({ name: 'conversation.composer.dock', id: 'activity', locale: 'chat' }, Official)
  const before = core.declarationEpoch('conversation.chat.message.images')
  const ctx = { slots: { register: core.register.bind(core), entries: core.entries.bind(core), entriesOfSlot: core.entriesOfSlot.bind(core), subscribe: core.subscribe.bind(core), inject: (_name: string, install: () => () => void) => install() } } as unknown as Context
  const transcript = installSourceTranscript(ctx), details = installComposerDetails(ctx)
  const active = core.entriesOfSlot('conversation.chat.node')[0]
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(core.entriesOfSlot('conversation.chat.node')[0], active, 'publishing the wrapper must not replace itself')
  assert.equal(core.declarationEpoch('conversation.chat.message.images'), before)
  assert.equal(core.entriesOfSlot('conversation.chat.node')[0]!.children, undefined, 'adapter uses public factories, not borrowed child declarations')
  assert.equal(core.entries('conversation.composer.dock')[0]!.component, Official)
  assert.equal(core.entries('hapi.source.composer-details').length, 1)
  details(); transcript()
  assert.equal(core.entriesOfSlot('conversation.chat.node')[0]!.component, Official)
  assert.equal(core.declarationEpoch('conversation.chat.message.images'), before)
  stat(); original(); root()
})
