/** Explicit observable, catalog, and block-registry fakes for admission ownership. */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ComposerBlock, ComposerBlocks } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { HapiProjection } from '../src/codex/projection-types.ts'
import { installNativeComposerAdmission } from '../src/client/native-composer.ts'
import { en } from '../src/client/locales.ts'

function store<T>(initial: T): SnapshotStore<T> {
    let snapshot = initial
    const listeners = new Set<() => void>()
    return {
        getSnapshot: () => snapshot,
        subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
        set(value) { snapshot = value; for (const listener of [...listeners]) listener() },
        update() { throw new Error('This fixture does not use draft mutations') },
    }
}

test('source read-only state blocks the official composer without erasing another plugin reason', () => {
    const id = 'native' as SessionId
    const list = store<SessionListState>({ ids: [], byId: {}, phase: 'ready', projectionsBySession: {} })
    const values = new Map<SessionId, ReturnType<ComposerBlocks['storeFor']>>()
    const blocks: ComposerBlocks = {
        storeFor(sessionId) {
            let value = values.get(sessionId)
            if (!value) { value = store<ComposerBlock | undefined>(undefined); values.set(sessionId, value) }
            return value
        },
        set(sessionId, block) { blocks.storeFor(sessionId).set(block) },
        forget(sessionId) { values.delete(sessionId) },
    }
    const update = (connection: NonNullable<HapiProjection>['nativeConnection'], readOnly: boolean): void => {
        // Only these admission facts are consumed; all execution data is absent
        // in this explicit unit fixture and is covered by the Host tests.
        const projection = { engine: 'codex', nativeConnection: connection, readOnly } as NonNullable<HapiProjection>
        list.set({ ids: [id], phase: 'ready', projectionsBySession: {}, byId: {
            [id]: { id, displayTitle: 'Native', running: false, blank: false, updatedAt: 1, retainedBy: {}, projectionValues: { hapi: projection } },
        } })
    }
    const foreign = { reason: 'Select a model first' }
    blocks.set(id, foreign)
    const dispose = installNativeComposerAdmission({ list }, blocks, { t: key => en[key], subscribe: () => () => {} })
    update('disconnected', true)
    assert.equal(blocks.storeFor(id).getSnapshot(), foreign)
    blocks.set(id, undefined)
    assert.equal(blocks.storeFor(id).getSnapshot()?.reason, en.nativeReconnecting)
    update('history', true)
    assert.equal(blocks.storeFor(id).getSnapshot()?.reason, en.nativeResumeToSend)
    update('attached', false)
    assert.equal(blocks.storeFor(id).getSnapshot(), undefined)
    update('disconnected', true)
    blocks.set(id, foreign)
    update('attached', false)
    assert.equal(blocks.storeFor(id).getSnapshot(), foreign)
    blocks.set(id, undefined)
    update('attached', true)
    assert.equal(blocks.storeFor(id).getSnapshot()?.reason, en.nativeReadOnly)
    dispose()
    assert.equal(blocks.storeFor(id).getSnapshot(), undefined)
    update('disconnected', true)
    assert.equal(blocks.storeFor(id).getSnapshot(), undefined)
})
