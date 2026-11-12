import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeGitPath, parseWorkbenchChanges, terminalKey } from '../src/client/workbench-model.ts';
import { discardNativeDocumentDraft, hasDirtyNativeDocument, nativeDocumentDraft, rememberNativeDocumentDraft } from '../src/client/workbench-drafts.ts';
import type { WorkbenchResponse } from '../src/workbench-types.ts';

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
