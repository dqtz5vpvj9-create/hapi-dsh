/** Explicit remote WorkspaceServices fixture; browser state and production routing stay real. */
import { randomUUID } from 'node:crypto';
import type { SourceFileContext } from '../src/client/source-workspace-provider.ts';
import type { SourceFileOwner } from '../src/client/source-file-mutation-journal.ts';
import type { WorkspaceDocument, WorkspaceServices } from '../src/workspace/service-types.ts';

export function fileOwner(session: string = randomUUID()): SourceFileOwner {
    return { scope: 'authenticated-account', binding: { target: { hostId: 'source-host', sessionId: `hhpi:machine:source:codex:${session}` },
        machineId: 'machine', workspaceId: 'source-workspace', root: '/source', pathStyle: 'posix' } };
}
export function fileContext(owner = fileOwner()): SourceFileContext {
    const file = { absolutePath: '/source/file.txt', version: 'stat:initial', bytes: 8 };
    const doc: WorkspaceDocument = { resource: { target: owner.binding.target, document: { kind: 'file', path: file.absolutePath } },
        fileName: 'file.txt', mimeType: 'text/plain', text: 'original', writable: true, ...file };
    const services: WorkspaceServices = { binding: owner.binding, files: {
        async read() { return { ...file, offset: 1, text: 'original', lines: 1, eof: true }; },
        async readBytes() { return { ...file, offset: 0, data: new TextEncoder().encode('original'), eof: true }; },
        async stat() { return file; }, async list() { return { path: '', entries: [], truncated: false }; }, async *changes() { yield { kind: 'ready' }; },
    }, documents: { async open() { return structuredClone(doc); }, async bytes() { return services.files.readBytes('', {}, {} as never); },
        async inspect() { return null; }, async search() { return []; }, async git() { return { stdout: '', stderr: '', exitCode: 0 }; } },
        mutations: { async save(request) { return { status: 'applied', operationId: request.operationId, value: file }; },
            async manage(request) { return { status: 'applied', operationId: request.operationId, value: null }; }, async receipt() { return null; } } };
    return { owner, services };
}

/** Explicit transactional browser-journal boundary for DOM tests, with production record shape and CAS. */
export function documentJournalFixture(): import('../src/client/native-document-journal.ts').NativeDocumentJournal {
    const rows = new Map<string, import('../src/client/native-document-journal.ts').NativeDocumentJournalEntry>();
    return { async read(key) { return structuredClone(rows.get(key) ?? null); }, async write(key, expected, draft) {
        if ((rows.get(key)?.revision ?? null) !== expected) throw new Error('Another editor saved a newer draft for this source file.');
        const row = { version: 2 as const, revision: randomUUID(), updatedAt: Date.now(), draft: structuredClone(draft) };
        rows.set(key, row); return row;
    } };
}
