import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TerminalOutputTracker, decodeGitPath, parseWorkbenchChanges, terminalKey } from '../src/client/workbench-model.ts';
import { discardNativeDocumentDraft, hasDirtyNativeDocument, nativeDocumentDraft, rememberNativeDocumentDraft } from '../src/client/workbench-drafts.ts';
import type { TerminalOutputStream, WorkbenchResponse } from '../src/workbench-types.ts';

const stream = (startOffset: number, endOffset: number, replay = false): TerminalOutputStream => ({ version: 1, epoch: 'source-epoch', startOffset, endOffset, replay });
test('PTY replay advances only for accepted output and deduplicates overlapping UTF-16 ranges', () => {
    const tracker = new TerminalOutputTracker(); const output: string[] = [];
    tracker.receive('abc', stream(0, 3, true), () => false); assert.equal(tracker.cursor, undefined);
    tracker.receive('abc', stream(0, 3, true), value => { output.push(value); });
    tracker.reconnect(); tracker.receive('bc😀', stream(1, 5, true), value => { output.push(value); });
    tracker.receive('abc😀', stream(0, 5, true), () => { throw new Error('Duplicate replay must not be appended'); });
    assert.deepEqual(output, ['abc', '😀']); assert.deepEqual(tracker.cursor, { epoch: 'source-epoch', offset: 5 });
});
test('PTY gaps, changed epochs, malformed bounds and legacy reconnect block input without inventing output', () => {
    for (const invalid of [{ ...stream(0, 1, true), gap: 'epoch-changed' as const }, stream(0, 2, true), stream(1, 2, false)]) {
        const tracker = new TerminalOutputTracker(); tracker.receive('x', invalid, () => { throw new Error('Bad output cannot enter xterm'); }); assert.equal(tracker.blocked, true);
    }
    const tracker = new TerminalOutputTracker(); tracker.receive('x', stream(0, 1, true), () => {});
    tracker.receive('y', { ...stream(1, 2), epoch: 'new-epoch' }, () => { throw new Error('New epoch cannot append'); }); assert.equal(tracker.blocked, true);
    tracker.reset(); tracker.receive('old', undefined, () => {}); tracker.reconnect(); assert.equal(tracker.issue, 'legacy');
});
test('initial source-truncated scrollback is explicit but retains a valid live cursor', () => {
    const tracker = new TerminalOutputTracker(); tracker.receive('tail', { ...stream(100, 104, true), truncated: true }, () => {});
    assert.equal(tracker.issue, 'truncated'); assert.equal(tracker.blocked, false); assert.equal(tracker.cursor?.offset, 104);
});
test('porcelain-v2 parsing preserves spaced, renamed, conflicted and quoted UTF-8 paths', () => {
    const result = parseWorkbenchChanges([
        '# branch.head feature', '1 MM N... 100644 100644 100644 aaa bbb file with spaces.ts',
        '2 R. N... 100644 100644 100644 aaa bbb R100 new name.ts\told name.ts',
        'u UU N... 100644 100644 100644 100644 aaa bbb ccc conflict.txt', '? "\\346\\226\\207\\344\\273\\266.md"',
    ].join('\n'), '2\t1\tfile with spaces.ts', '3\t4\tfile with spaces.ts');
    assert.equal(result.branch, 'feature'); assert.equal(result.changes.length, 5);
    assert.deepEqual(result.changes[0], { path: 'file with spaces.ts', staged: true, status: 'M', added: 2, removed: 1 });
    assert.equal(result.changes[2]?.previousPath, 'old name.ts'); assert.equal(result.changes[3]?.status, 'conflict'); assert.equal(result.changes[4]?.path, '文件.md');
    assert.equal(decodeGitPath('"has\\ttab.txt"'), 'has\ttab.txt');
});
test('drafts survive pane closure by immutable source and retain their original CAS baseline', () => {
    const source = { sourceSessionId: 'fixture-native', sourceHubId: 'fixture-hub' };
    const document = { kind: 'file' as const, path: 'notes.md', machineId: 'fixture-machine' };
    const base: WorkbenchResponse<'nativeDocument'> = { document, fileName: 'notes.md', mimeType: 'text/markdown', size: 4, text: 'base', hash: 'a'.repeat(64), writable: true, downloadUrl: '/fixture', officePreview: false };
    rememberNativeDocumentDraft(source, document, { base, text: 'draft', uncertain: true });
    assert.equal(hasDirtyNativeDocument({ kind: 'document', sessionId: 'display-v2', ...source, document }), true);
    assert.equal(nativeDocumentDraft(source, document)?.base.hash, 'a'.repeat(64));
    assert.equal(hasDirtyNativeDocument({ kind: 'document', sessionId: 'display-v2', sourceSessionId: 'different-native', document }), false);
    discardNativeDocumentDraft(source, document); assert.equal(hasDirtyNativeDocument({ kind: 'document', ...source, document }), false);
});
test('mobile terminal keys preserve application cursor mode and xterm modifier sequences', () => {
    assert.equal(terminalKey('\u001b[A', { ctrl: false, alt: false, shift: false }, true), '\u001bOA');
    assert.equal(terminalKey('\u001b[A', { ctrl: true, alt: false, shift: true }), '\u001b[1;6A');
    assert.equal(terminalKey('c', { ctrl: true, alt: false, shift: false }), '\u0003');
    assert.equal(terminalKey('\t', { ctrl: false, alt: false, shift: true }), '\u001b[Z');
    assert.equal(terminalKey('\u001b[5~', { ctrl: false, alt: true, shift: false }), '\u001b[5;3~');
});
