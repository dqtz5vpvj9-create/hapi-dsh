/** Recovery regression tests use synthetic transport and editor boundaries. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSourceResumeCommand } from '../src/client/source-resume-command.ts'
import { PaneReadingIntents } from '../src/client/reading-intent.ts'
import { migrateMessageAppearance } from '../src/client/appearance/migration.ts'
import { createWorkspaceUiPreferences } from '../src/client/ui-preferences.ts'

test('resume command quotes source paths and rejects unsupported identities instead of substituting display IDs', () => {
    const identity = { engine: 'codex', nativeId: '11111111-1111-4111-8111-111111111111', directory: "/workspace/it's here", machineId: 'source-runner', machineName: null, codexHome: '/original/codex', platformOs: 'linux', platformFamily: 'unix' }
    const result = buildSourceResumeCommand(identity)
    assert.equal(result.available, true)
    const { codexHome: _home, ...unknownHome } = identity
    assert.deepEqual(buildSourceResumeCommand(unknownHome), { available: false, reason: 'missing-codex-home' })
    if (result.available) assert.equal(result.command, `cd '/workspace/it'"'"'s here' && env CODEX_HOME='/original/codex' codex resume '${identity.nativeId}'`)
    assert.equal(buildSourceResumeCommand({ ...identity, nativeId: 'display-id' }).available, false)
    assert.equal(buildSourceResumeCommand({ ...identity, directory: 'C:\\workspace' }).available, false)
})

test('reading intent revisions are independent per occurrence and a newer target invalidates old completion', () => {
    const intents = new PaneReadingIntents(), old = intents.request('left', 'session', { kind: 'latest' })
    intents.request('right', 'session', { kind: 'approval', requestId: 'request' })
    const message = intents.request('left', 'session', { kind: 'message', messageId: 'message', origin: 'search' })
    assert.equal(intents.current('left', old), false)
    assert.equal(intents.current('left', message), true)
    assert.equal(intents.read('right')?.target.kind, 'approval')
    intents.retain(new Set(['right']))
    assert.equal(intents.read('left'), undefined)
})

test('message appearance migration removes only retired bubble preferences', () => {
    const values = new Map([['hapi-user-message-bg', 'blue'], ['hapi-theme-colors', JSON.stringify({ dark: { userBubble: '#0000ff', text: '#eeeeee', extra: 'kept' }, plugin: { value: true } })]])
    const prefs = createWorkspaceUiPreferences({ getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value) }, removeItem: key => { values.delete(key) } })
    migrateMessageAppearance(prefs)
    assert.equal(values.has('hapi-user-message-bg'), false)
    assert.deepEqual(JSON.parse(values.get('hapi-theme-colors')!), { dark: { text: '#eeeeee', extra: 'kept' }, plugin: { value: true } })
    prefs.dispose()
})
