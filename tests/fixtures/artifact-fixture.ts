/** Real HTTP carrier for explicit artifact bytes. Office conversion is supplied
 * fixture output, not a simulated claim that a real Office converter ran. */
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HapiSession } from '../src/codex/contracts.ts';

export interface ArtifactFixtureValue {
    fileName: string;
    mimeType: string;
    bytes: Uint8Array;
    /** Explicit PDF output used to exercise the real native-preview transport. */
    preview?: Uint8Array;
}
type StoredArtifact = Omit<ArtifactFixtureValue, 'bytes' | 'preview'> & {
    bytes: Buffer; preview?: Buffer; version: string; previewId: string;
};

export class ArtifactWireFixture {
    private readonly values = new Map<string, Map<string, StoredArtifact>>();
    private readonly generated = new Map<string, Map<string, ArtifactFixtureValue>>();
    readonly requests: Array<{ sessionId: string; machineId: string | null; method: string; route: string; artifactId?: string; previewId?: string; imageId?: string }> = [];

    set(sessionId: string, artifactId: string, value: ArtifactFixtureValue): void {
        let source = this.values.get(sessionId);
        if (!source) this.values.set(sessionId, source = new Map());
        const bytes = Buffer.from(value.bytes);
        const version = createHash('sha256').update(bytes).digest('hex');
        const previewId = createHash('sha256').update(JSON.stringify([sessionId, artifactId, version])).digest('hex');
        source.set(artifactId, { fileName: value.fileName, mimeType: value.mimeType, bytes,
            ...(value.preview ? { preview: Buffer.from(value.preview) } : {}), version, previewId });
    }

    /** Explicit original Runner registry bytes, independent of artifact IDs. */
    setGenerated(sessionId: string, imageId: string, value: ArtifactFixtureValue): void {
        let source = this.generated.get(sessionId);
        if (!source) this.generated.set(sessionId, source = new Map());
        source.set(imageId, { ...value, bytes: Uint8Array.from(value.bytes) });
    }

    handle(session: HapiSession, tail: string, _url: URL, request: IncomingMessage, response: ServerResponse, body: Record<string, unknown> = {}): boolean {
        if (!tail.startsWith('artifacts/') && !tail.startsWith('generated-images/') && tail !== 'document-preview' && !tail.startsWith('document-preview/')) return false;
        const log = { sessionId: session.id, machineId: session.metadata?.machineId ?? null, method: request.method ?? '', route: tail };
        const source = this.values.get(session.id);
        const json = (value: unknown, status = 200): void => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
        const binary = (bytes: Buffer, mimeType: string, name: string, range = false): void => {
            const headers: Record<string, string> = { 'content-type': mimeType, 'content-length': String(bytes.length),
                'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(name)}` };
            if (!range || !request.headers.range) { response.writeHead(200, headers); response.end(bytes); return; }
            const parts = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range);
            const start = parts ? Number(parts[1]) : -1;
            const end = parts?.[2] ? Math.min(Number(parts[2]), bytes.length - 1) : bytes.length - 1;
            if (start < 0 || start > end || start >= bytes.length) { response.writeHead(416, { 'content-range': `bytes */${bytes.length}` }); response.end(); return; }
            const result = bytes.subarray(start, end + 1);
            response.writeHead(206, { ...headers, 'content-length': String(result.length), 'content-range': `bytes ${start}-${end}/${bytes.length}`, 'accept-ranges': 'bytes' });
            response.end(result);
        };
        if (tail.startsWith('generated-images/')) {
            const imageId = tail.slice('generated-images/'.length);
            this.requests.push({ ...log, imageId });
            if (request.method !== 'GET') { json({ error: 'Only generated media reads are supported' }, 405); return true; }
            const value = this.generated.get(session.id)?.get(imageId);
            if (!value) { json({ error: 'The original Runner no longer has this generated media' }, 404); return true; }
            binary(Buffer.from(value.bytes), value.mimeType, value.fileName); return true;
        }
        if (tail.startsWith('artifacts/')) {
            const artifactId = tail.slice('artifacts/'.length);
            this.requests.push({ ...log, artifactId });
            if (request.method !== 'GET') { json({ error: 'Only artifact reads are supported' }, 405); return true; }
            const value = source?.get(artifactId);
            if (!value) { json({ error: 'Source artifact not found' }, 404); return true; }
            binary(value.bytes, value.mimeType, value.fileName); return true;
        }
        if (tail === 'document-preview') {
            const document = body.document as { kind?: string; artifactId?: string } | undefined;
            const artifactId = document?.kind === 'artifact' ? document.artifactId : undefined;
            this.requests.push({ ...log, ...(artifactId ? { artifactId } : {}) });
            if (request.method !== 'POST' || !artifactId) { json({ error: 'An original artifact reference is required' }, 400); return true; }
            const value = source?.get(artifactId);
            if (!value?.preview) { json({ error: 'No explicit conversion output was supplied by this fixture' }, 404); return true; }
            json({ previewId: value.previewId, length: value.preview.length, version: value.version, size: value.bytes.length }); return true;
        }
        const previewId = tail.slice('document-preview/'.length);
        this.requests.push({ ...log, previewId });
        const value = [...(source?.values() ?? [])].find(candidate => candidate.previewId === previewId);
        if (request.method !== 'GET' || !value?.preview) { json({ error: 'Source preview not found' }, 404); return true; }
        binary(value.preview, 'application/pdf', 'preview.pdf', true); return true;
    }
}
