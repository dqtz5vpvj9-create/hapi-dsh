/** Installed InputTriggerController -> production file onPick -> installed SessionInput/Lexical.
 * Only native file discovery is supplied at the explicit candidate boundary. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { fixture } from './hhpi-reading-fixture.ts'
import { codexInputSources } from '../../src/client/remote-input-triggers.ts'
import type { HhpiRemoteApi } from '../../src/hhpi-api.ts'

test('official reference insertion consumes the complete token and preserves an intentional caret suffix', { timeout: 15000 }, async t => {
    const f = await fixture(t, { rendering: false })
    const plugin = f.officialPlugin('@deepseek-ai/dsh-client-ui-input-trigger', true, false)
    await f.ctx.plugin(plugin.InputTriggerService as import('@deepseek-ai/cordis').Plugin<{}>, {})
    const pane = await f.open('reference-pane'), input = pane.input
    const file = codexInputSources({} as HhpiRemoteApi, () => undefined, () => false)[1]!
    const stop = f.ctx.inputTriggers.registerSource({ ...file,
        candidates: async () => [{ name: 'README.md', value: '/synthetic/README.md' }] })
    t.after(stop)
    const controller = f.ctx.inputTriggers.sessionOf(pane.binding.ctx)
    for (const caret of [7, 6]) {
        input.setDraft('@README')
        controller.track('@README', caret, { tier: 'plain' }, input.state.getSnapshot().draftRev)
        for (let turn = 0; turn < 20 && controller.menu.getSnapshot().groups[0]?.status !== 'ready'; turn++) await new Promise<void>(resolve => setImmediate(resolve))
        assert.equal(controller.menu.getSnapshot().groups[0]?.status, 'ready')
        controller.pick('codex-files', 0)
        const result = input.state.getSnapshot()
        assert.equal(result.occurrences.length, 1)
        assert.equal(result.occurrences[0]?.ref, '/synthetic/README.md')
        assert.equal(result.draft.endsWith('E'), caret === 6, 'only text after the actual caret survives the half-open replacement')
    }
    input.setDraft('@README')
    const oldRevision = input.state.getSnapshot().draftRev
    input.setDraft('@README new text')
    assert.equal(input.insertReference({ source: 'codex-files', ref: '/synthetic/README.md', label: 'README.md', appearance: 'file', clipboardText: '@README.md' },
        { start: 0, end: 7, draftRev: oldRevision }), false, 'a late pick cannot consume a newer draft')
    assert.equal(input.state.getSnapshot().draft, '@README new text')
})
