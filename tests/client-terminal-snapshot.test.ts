import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readTerminalCopySnapshot } from '../src/client/source-terminal/snapshot.ts'

test('terminal copy preserves the official selection and explicitly labels visible rows', async () => {
    const signal = new AbortController().signal
    assert.deepEqual(await readTerminalCopySnapshot({ text: 'selected portion', selected: true }, signal), { kind: 'selected', lines: ['selected portion'] })
    assert.deepEqual(await readTerminalCopySnapshot({ text: 'visible rows only\nlast row', selected: false }, signal), { kind: 'visible', lines: ['visible rows only', 'last row'] })
})

test('a closed copy view cannot publish its mounted terminal text', async () => {
    const abort = new AbortController(); abort.abort(new Error('Closed copy view'))
    await assert.rejects(readTerminalCopySnapshot({ text: 'old occurrence', selected: false }, abort.signal), /Closed copy view/)
})
