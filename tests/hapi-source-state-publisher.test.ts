import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SourceStatePublisher } from '../src/shared/source-state-publisher.ts'

test('independent execution publication retains full values while unrelated large domains stay unchanged', () => {
    type State = { notices: string[]; execution: { sequence: number; status: string } | null; delivery: string[]; approvals: string[]; sidechains: string[] }
    const events: Array<{ type: string; value: unknown }> = []
    const record = (type: string, value: unknown) => { events.push({ type, value: structuredClone(value) }) }
    const publisher = new SourceStatePublisher<State, 'execution'>({
        initial: value => record('initial', value), status: value => record('status', value), notices: value => record('notices', value),
    }, { key: 'execution', write: value => record('execution', value) })
    const state: State = { notices: ['notice'], execution: { sequence: 1, status: 'active' },
        delivery: ['queued '.repeat(10_000)], approvals: ['approval '.repeat(10_000)], sidechains: ['child '.repeat(10_000)] }
    publisher.publish(state)
    for (let sequence = 2; sequence <= 101; sequence++) publisher.publish({ ...state, execution: { sequence, status: 'active' } })
    assert.equal(events.length, 101)
    assert.ok(events.slice(1).every(event => event.type === 'execution'))
    assert.ok(JSON.stringify(events.slice(1)).length < 10_000)
    const changed = { ...state, execution: null, notices: [], delivery: [] }
    publisher.publish(changed); publisher.publish(structuredClone(changed))
    assert.deepEqual(events.slice(-3), [
        { type: 'notices', value: [] },
        { type: 'status', value: { delivery: [], approvals: state.approvals, sidechains: state.sidechains } },
        { type: 'execution', value: null },
    ])
    assert.deepEqual(state.execution, { sequence: 1, status: 'active' }, 'publishing must not mutate the owner snapshot')
})

test('a publisher with no independent domain preserves the existing complete status contract', () => {
    type State = { notices: string[]; thinking: boolean }
    const events: unknown[] = []
    const publisher = new SourceStatePublisher<State>({ initial: value => { events.push(value) },
        status: value => { events.push(value) }, notices: value => { events.push(value) } })
    publisher.publish({ notices: ['kept'], thinking: false })
    publisher.publish({ notices: ['kept'], thinking: true })
    publisher.publish({ notices: [], thinking: true })
    assert.deepEqual(events, [{ notices: ['kept'], thinking: false }, { thinking: true }, []])
})
