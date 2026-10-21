import test from 'node:test'
import assert from 'node:assert/strict'
import { nativeLaunchOptions } from '../src/hapi/native-launch-options.ts'

test('native launch discovery preserves original selectors and strips credentials and other machines', async () => {
    const calls: string[] = []
    const options = await nativeLaunchOptions({
        request: async path => {
            calls.push(path)
            if (path.endsWith('/codex-homes')) return { success: true, homes: [{ id: 'home', label: 'Official', path: '/native', official: true, auth: 'private' }] }
            if (path.endsWith('/codex-models')) return { success: true, models: [{ id: 'source-model', displayName: 'Source model', supportedReasoningEfforts: ['high'] }] }
            return { success: true, accounts: [{ id: 'account', label: 'Student', email: 'example@invalid.test', enabled: true, accessToken: 'private', refreshToken: 'private' }] }
        },
        listMachines: async () => [{ id: 'other', active: true, activeAt: 1, metadata: { codexKeyProfiles: [{ id: 'wrong', label: 'Wrong' }] } }, { id: 'alpha/beta', active: true, activeAt: 1, metadata: { codexKeyProfiles: [{ id: 'profile', label: 'Classroom', homeId: 'home', key: 'private' }] } }],
    }, 'alpha/beta')
    assert.equal(calls.every(path => path.startsWith('/api/machines/alpha%2Fbeta/')), true)
    assert.deepEqual(options.homes, [{ id: 'home', name: 'Official', path: '/native', official: true }])
    assert.deepEqual(options.accounts, [{ id: 'account', label: 'Student', email: 'example@invalid.test', enabled: true }])
    assert.deepEqual(options.keyProfiles, [{ id: 'profile', label: 'Classroom', homeId: 'home' }])
    assert.equal(JSON.stringify(options).includes('private'), false)
})

test('failed source discovery stays unavailable instead of inventing Hub defaults', async () => {
    const options = await nativeLaunchOptions({ request: async () => { throw new Error('offline') }, listMachines: async () => [] }, 'offline-runner')
    assert.deepEqual(options.models, []); assert.deepEqual(options.accounts, []); assert.deepEqual(options.keyProfiles, [])
    assert.equal(options.warnings.length, 3)
})
