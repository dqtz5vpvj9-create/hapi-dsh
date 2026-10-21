/** Explicit observable, catalog, and block-registry fakes for admission ownership. */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ComposerBlock, ComposerBlocks } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { HapiObservedProjection } from '../src/hapi-agent/projection-types.ts'
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

function fixture() {
    const id = 'native' as SessionId
    const list = store<SessionListState>({ ids: [id], byId: {}, phase: 'ready', projectionsBySession: {} })
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
    const setProjection = (projectionValues: Record<string, unknown> | undefined): void => {
        const row = { id, displayTitle: 'Native', running: false, blank: false, updatedAt: 1, retainedBy: {} }
        list.set({ ids: [id], phase: 'ready', projectionsBySession: {},
            byId: { [id]: projectionValues === undefined ? row : { ...row, projectionValues } } })
    }
    const dispose = installNativeComposerAdmission({ list }, blocks, { t: key => en[key], subscribe: () => () => {} })
    return { id, blocks, setProjection, dispose }
}

const native = (patch: Partial<NonNullable<HapiProjection>> = {}): NonNullable<HapiProjection> =>
    ({ engine: 'codex', nativeConnection: 'attached', readOnly: false, ...patch }) as NonNullable<HapiProjection>
const observed = (patch: Partial<NonNullable<HapiObservedProjection>> = {}): NonNullable<HapiObservedProjection> =>
    ({ engine: 'hapi', controlledByUser: false, readOnly: false, readOnlyReason: null, ...patch }) as NonNullable<HapiObservedProjection>

test('native Codex connection and fault availability never freezes the composer', () => {
    const app = fixture()
    try {
        // Availability is a non-blocking status for native Codex: these states
        // still accept a durable send and resolve the source on delivery.
        for (const projection of [
            native({ nativeConnection: 'disconnected', readOnly: true, readOnlyReason: 'unavailable' }),
            native({ nativeConnection: 'history', readOnly: true, readOnlyReason: 'unavailable' }),
            native({ nativeConnection: 'attached', readOnly: true, readOnlyReason: 'fault' }),
            native({ nativeConnection: 'attached', readOnly: true, readOnlyReason: 'migration' }),
        ]) {
            app.setProjection({ hapi: projection })
            assert.equal(app.blocks.storeFor(app.id).getSnapshot(), undefined)
        }
        app.setProjection(undefined)
        assert.equal(app.blocks.storeFor(app.id).getSnapshot(), undefined)
    } finally { app.dispose() }
})

test('only the original engine owning local input blocks the composer, with accurate copy', () => {
    const app = fixture()
    try {
        app.setProjection({ hapiObserved: observed({ readOnly: true, readOnlyReason: 'engine-owned', controlledByUser: true }) })
        assert.equal(app.blocks.storeFor(app.id).getSnapshot()?.reason, en.sourceLocallyControlled)
        // A disconnected inactive source is resumable, not inert.
        app.setProjection({ hapiObserved: observed({ readOnly: true, readOnlyReason: 'unavailable', active: false }) })
        assert.equal(app.blocks.storeFor(app.id).getSnapshot(), undefined)
        app.setProjection({ hapiObserved: observed({ readOnly: true, readOnlyReason: 'fault' }) })
        assert.equal(app.blocks.storeFor(app.id).getSnapshot(), undefined)
    } finally { app.dispose() }
})

test('another plugin reason is never erased and the engine-owned block releases with its owner', () => {
    const app = fixture()
    const foreign = { reason: 'Select a model first' }
    try {
        app.blocks.set(app.id, foreign)
        app.setProjection({ hapiObserved: observed({ readOnly: true, readOnlyReason: 'engine-owned', controlledByUser: true }) })
        assert.equal(app.blocks.storeFor(app.id).getSnapshot(), foreign)
        app.blocks.set(app.id, undefined)
        assert.equal(app.blocks.storeFor(app.id).getSnapshot()?.reason, en.sourceLocallyControlled)
        app.setProjection({ hapiObserved: observed() })
        assert.equal(app.blocks.storeFor(app.id).getSnapshot(), undefined)
    } finally { app.dispose() }
    assert.equal(app.blocks.storeFor(app.id).getSnapshot(), undefined)
})
