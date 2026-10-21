import test from 'node:test'
import assert from 'node:assert/strict'
import { LaunchDraftStore, nativeFieldsFromRequest, nativeFieldsForContext, sourceFieldsForContext, nativeLaunchFieldsSchema, readNativeLaunchIntent, saveLaunchIntent, sourceLaunchFieldsSchema } from '../src/client/launch-drafts.ts'
import { SourceCreationController } from '../src/client/source-creation.ts'
import { nativeCreationRequest } from '../src/client/new-session.tsx'

const storage = () => { const values = new Map<string, string>(); return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } } }

test('new-in-folder keeps the original Runner and does not reuse another machine’s home/account/model', () => {
    const saved = nativeLaunchFieldsSchema.parse({ machineId: 'alpha', directory: '/old', home: '/alpha/codex', accountId: 'alpha-account', keyProfileId: 'alpha-key', model: 'alpha-model', reasoning: 'high' })
    const result = nativeFieldsForContext(saved, { hostId: 'local', machineId: 'beta', directory: '/beta/project', engine: 'codex' })
    assert.equal(result.machineId, 'beta'); assert.equal(result.directory, '/beta/project')
    assert.equal(result.home, ''); assert.equal(result.accountId, ''); assert.equal(result.keyProfileId, ''); assert.equal(result.model, '')
    const unmapped = nativeFieldsForContext(saved, { hostId: 'remote-dsh-host', directory: '/remote/project' })
    assert.equal(unmapped.machineId, '', 'An unrelated DSH Host must not guess a HAPI Runner identity')
});

test('source folder context changes the engine using its own selectors and clears directory-dependent models', () => {
    const saved = sourceLaunchFieldsSchema.parse({ agent: 'claude', machineId: 'alpha', directory: '/first', model: 'old-model', effort: 'high', permission: 'bypassPermissions', startingMode: 'pty' })
    const next = sourceFieldsForContext(saved, { hostId: 'local', machineId: 'beta', directory: '/second', engine: 'dsh' })
    assert.equal(next.agent, 'dsh'); assert.equal(next.machineId, 'beta'); assert.equal(next.directory, '/second'); assert.equal(next.model, '')
    assert.equal(next.permission, ''); assert.equal(next.startingMode, 'remote')
});

test('unfinished launch fields survive closing, but only a confirmed launch updates reusable preferences', () => {
    const disk = storage()
    const draft = new LaunchDraftStore(disk, 'hub-a:native', nativeLaunchFieldsSchema)
    const fields = nativeLaunchFieldsSchema.parse({ machineId: 'alpha', directory: '/project', home: '/native', model: 'source-model', permission: 'read-only', collaboration: 'plan', serviceTier: 'fast', worktree: true, worktreeName: 'one-time-branch' })
    draft.save(fields)
    assert.deepEqual(new LaunchDraftStore(disk, 'hub-a:native', nativeLaunchFieldsSchema).load(), fields)
    assert.equal(disk.getItem('hub-a:native:preferences'), null)
    draft.completed(fields)
    assert.deepEqual(new LaunchDraftStore(disk, 'hub-a:native', nativeLaunchFieldsSchema).load(), { ...fields, worktreeName: '' })
    assert.equal(new LaunchDraftStore(disk, 'hub-b:native', nativeLaunchFieldsSchema).load().machineId, '')
    disk.setItem('hub-a:native:draft', '{broken')
    assert.equal(draft.load().model, 'source-model')
})

test('native recovery keeps the exact request and all source-owned launch selectors', () => {
    const disk = storage()
    const fields = nativeLaunchFieldsSchema.parse({ machineId: 'alpha', directory: '/project', accountId: 'original-account', keyProfileId: 'runner-key', permission: 'default', collaboration: 'plan', serviceTier: 'fast' })
    const request = nativeCreationRequest(fields, 'still-the-same-request-1234')
    saveLaunchIntent(disk, 'intent', request)
    const restored = readNativeLaunchIntent(disk, 'intent')!
    assert.deepEqual(restored, request)
    assert.deepEqual(nativeFieldsFromRequest(restored), fields)
    assert.equal(restored.codexAccountId, 'original-account')
    assert.equal(restored.codexKeyProfileId, 'runner-key')
    assert.equal(restored.collaborationMode, 'plan')
    assert.equal(restored.serviceTier, 'fast')
    disk.setItem('intent', JSON.stringify({ ...request, token: 'must-not-cross-schema' }))
    assert.equal(readNativeLaunchIntent(disk, 'intent'), null)
})

test('failed durable draft storage cannot dispatch a new source launch', async () => {
    let launches = 0
    const api = { createSourceSession: async () => { launches++; throw new Error('must not execute') }, sourceCreations: async () => ({ ok: true as const, value: [] }), sourceCreationOperation: async () => { throw new Error('must not execute') } }
    const disk = { getItem: () => null, setItem: () => { throw new Error('Storage quota exceeded') } }
    const controller = new SourceCreationController(api, () => 'request-that-must-be-durable', disk)
    await controller.start(sourceLaunchFieldsSchema.parse({ machineId: 'alpha', directory: '/project' }))
    assert.equal(launches, 0)
    assert.equal(controller.getSnapshot().request, null)
    assert.match(controller.getSnapshot().error!, /quota/)
})
