/** Native files remain on the owning Runner; this module never opens a Hub path. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { posix, win32 } from 'node:path';
import { z } from 'zod';
import { HapiRequestError, type HapiSession } from '../codex/contracts.ts';
import type { HapiClient } from './client.ts';
import type { FederationMount } from '../hub/federation.ts';
import type { MachineTerminalConnector } from './machine-terminals.ts';
import { readSourceTerminalText } from './terminal-text.ts';
import { MAX_SOURCE_GENERATED_MEDIA } from './generated-media.ts';
import {
    MAX_DOCUMENT_BYTES, MAX_EDITABLE_BYTES, WORKBENCH_DOCUMENT_PATH, WORKBENCH_PREVIEW_PATH,
    workbenchInputs, workbenchOutputs, workbenchSourceSchema,
    type WorkbenchSource, type WorkbenchRequest, type WorkbenchResponse, type NativeDocumentRef, type NativeTextFormat,
} from '../workbench-types.ts';

type WorkbenchClient = Pick<HapiClient, 'hubId' | 'getSession' | 'request' | 'readBinary'> & Partial<Pick<HapiClient, 'socketAuthentication'>>;
const upstreamDirectory = z.object({ success: z.boolean(), error: z.string().optional(), entries: workbenchOutputs.nativeDirectory.shape.entries.optional() });
const upstreamSearch = z.object({ success: z.boolean(), error: z.string().optional(), files: workbenchOutputs.nativeFileSearch.shape.files.optional() });
const fileInfo = z.object({ success: z.boolean(), error: z.string().optional(), entries: z.array(z.object({ path: z.string(), size: z.number().int().nonnegative().optional(), modified: z.number().optional() })).optional() });
const fileRead = z.object({ success: z.boolean(), error: z.string().optional(), path: z.string().optional(), content: z.string().optional(), hash: z.string().regex(/^[a-f0-9]{64}$/).optional(), writable: z.boolean().optional(), size: z.number().int().nonnegative().optional(), modified: z.number().optional() });
export interface SourceDocumentRead { absolutePath: string; version: string; data: Uint8Array; writable: boolean; modified?: number }
const previewRead = workbenchOutputs.nativePreview.omit({ url: true });
const previewRequest = z.strictObject({ source: workbenchSourceSchema, previewId: previewRead.shape.previewId });
const officeExtensions = new Set(['doc', 'docx', 'odt', 'rtf', 'xls', 'xlsx', 'ods', 'ppt', 'pptx', 'odp']);
const textExtensions = new Set(['txt', 'md', 'mdx', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'ini', 'conf', 'log', 'html', 'htm', 'xml', 'svg', 'css', 'scss', 'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'py', 'rs', 'go', 'java', 'kt', 'c', 'h', 'cc', 'cpp', 'hpp', 'sh', 'bash', 'zsh', 'fish', 'sql', 'rb', 'php', 'swift', 'vue', 'svelte', 'tex', 'r', 'ipynb', 'gitignore', 'env', 'lock']);
const mimeTypes: Record<string, string> = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', svg: 'image/svg+xml', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', mp4: 'video/mp4', webm: 'video/webm', json: 'application/json', csv: 'text/csv', md: 'text/markdown', html: 'text/html', htm: 'text/html' };
const fileName = (path: string): string => path.split(/[\\/]/).at(-1) || 'document';
const extension = (name: string): string => name.split('.').at(-1)?.toLowerCase() ?? '';
function mimeFor(name: string): string { return mimeTypes[extension(name)] ?? (textExtensions.has(extension(name)) ? 'text/plain' : 'application/octet-stream'); }
function readableText(bytes: Uint8Array, mimeType: string, name: string): { text: string; format: NativeTextFormat } | null {
    if (bytes.byteLength > MAX_EDITABLE_BYTES || bytes.includes(0)) return null;
    if (mimeType === 'application/pdf' || officeExtensions.has(extension(name)) || ['zip', 'gz', 'tar', '7z', 'rar', 'pdf', 'wasm', 'exe'].includes(extension(name))) return null;
    if (!mimeType.startsWith('text/') && !textExtensions.has(extension(name)) && /^(image|audio|video)\//.test(mimeType)) return null;
    try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        const remainder = text.replaceAll('\r\n', '');
        const mixed = remainder.includes('\r') || text.includes('\r\n') && remainder.includes('\n');
        return { text: text.replaceAll('\r\n', '\n'), format: { bom: bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf, eol: text.includes('\r\n') ? '\r\n' : '\n', ...(mixed ? { mixed: true } : {}) } };
    } catch { return null; }
}
function parseResponse<T>(schema: z.ZodType<T>, value: unknown): T {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new HapiRequestError('The source returned an incompatible workbench response', 'indeterminate', undefined, 'protocol_mismatch');
    return parsed.data;
}
function sourcePath(id: string, suffix: string): string { return `/api/sessions/${encodeURIComponent(id)}${suffix}`; }
function resourceUrl(path: string, request: unknown): string { return `${path}?request=${encodeURIComponent(JSON.stringify(request))}`; }
function assertSuccess(response: { success: boolean; error?: string | undefined }): void {
    if (!response.success) throw new HapiRequestError(response.error?.slice(0, 8192) || 'The owning Runner could not read this resource', 'rejected');
}

export class NativeWorkbench {
    private readonly disposers: Array<() => void> = [];
    private readonly lifetime = new AbortController();
    constructor(private readonly client: WorkbenchClient, private readonly options: { terminalConnect?: MachineTerminalConnector } = {}) {}

    /** HAPI validates namespace membership, then the immutable source-machine hint is checked. */
    async resolveSource(input: WorkbenchSource, document?: NativeDocumentRef, options: { allowInactive?: boolean } = {}): Promise<HapiSession> {
        const source = workbenchSourceSchema.parse(input);
        if (source.sourceHubId !== undefined && source.sourceHubId !== this.client.hubId) throw new HapiRequestError('This resource belongs to another HAPI Hub', 'rejected', 409, 'source_mismatch');
        const session = await this.client.getSession(source.sourceSessionId);
        if (session.id !== source.sourceSessionId) throw new HapiRequestError('The source returned a different session identity', 'rejected', 409, 'source_mismatch');
        if (!session.active && !options.allowInactive) throw new HapiRequestError('The source session is offline. Resume it on its owning Runner to use files.', 'rejected', 409, 'session_inactive');
        if (!session.metadata?.path || !session.metadata.machineId) throw new HapiRequestError('The source session has no verified machine and working directory', 'rejected', 409, 'source_unavailable');
        if (source.machineId !== undefined && source.machineId !== session.metadata.machineId
            || document?.kind === 'file' && document.machineId !== undefined && document.machineId !== session.metadata.machineId) {
            throw new HapiRequestError('This document belongs to another source machine', 'rejected', 409, 'source_mismatch');
        }
        return session;
    }

    /** Machine terminals outlive the chat process; the original Runner still authorizes the source machine and cwd. */
    resolveTerminalSource(input: WorkbenchSource): Promise<HapiSession> { return this.resolveSource(input, undefined, { allowInactive: true }); }

    async nativeTerminalText(input: WorkbenchRequest<'nativeTerminalText'>, signal?: AbortSignal): Promise<WorkbenchResponse<'nativeTerminalText'>> {
        const request = workbenchInputs.nativeTerminalText.parse(input);
        const combined = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]);
        combined.throwIfAborted();
        const session = await this.resolveTerminalSource(request.source);
        combined.throwIfAborted();
        if (!this.client.socketAuthentication) throw new HapiRequestError('The source terminal transport is unavailable', 'rejected', 503);
        const authentication = await this.client.socketAuthentication();
        combined.throwIfAborted();
        return readSourceTerminalText(authentication, request.source, session.metadata!.machineId!, request.terminalId, combined, this.options.terminalConnect);
    }

    async nativeDirectory(input: WorkbenchRequest<'nativeDirectory'>, signal?: AbortSignal): Promise<WorkbenchResponse<'nativeDirectory'>> {
        const request = workbenchInputs.nativeDirectory.parse(input);
        const session = await this.resolveSource(request.source);
        signal?.throwIfAborted();
        const response = parseResponse(upstreamDirectory, await this.client.request(sourcePath(session.id, `/directory?${new URLSearchParams(request.path === undefined ? {} : { path: request.path })}`), signal ? { signal } : undefined));
        return { ...response, path: request.path ?? '', cwd: session.metadata!.path, machineId: session.metadata!.machineId!, entries: response.entries ?? [] };
    }
    async nativeFileSearch(input: WorkbenchRequest<'nativeFileSearch'>, signal?: AbortSignal): Promise<WorkbenchResponse<'nativeFileSearch'>> {
        signal?.throwIfAborted();
        const request = workbenchInputs.nativeFileSearch.parse(input);
        await this.resolveSource(request.source);
        signal?.throwIfAborted();
        const query = new URLSearchParams({ query: request.query, limit: String(request.limit ?? 200) });
        const response = parseResponse(upstreamSearch, await this.client.request(sourcePath(request.source.sourceSessionId, `/files?${query}`), signal ? { signal } : undefined));
        signal?.throwIfAborted();
        return { ...response, files: response.files ?? [] };
    }
    async nativeGit(input: WorkbenchRequest<'nativeGit'>): Promise<WorkbenchResponse<'nativeGit'>> {
        const request = workbenchInputs.nativeGit.parse(input);
        await this.resolveSource(request.source);
        if (request.kind === 'diff' && request.path === undefined) throw new HapiRequestError('Select a file to read its Git diff', 'rejected', 400);
        const suffix = { status: 'git-status', numstat: 'git-diff-numstat', diff: 'git-diff-file' }[request.kind];
        const params = new URLSearchParams();
        if (request.path !== undefined) params.set('path', request.path);
        if (request.staged !== undefined) params.set('staged', String(request.staged));
        return parseResponse(workbenchOutputs.nativeGit, await this.client.request(sourcePath(request.source.sourceSessionId, `/${suffix}?${params}`)));
    }
    async nativeDocument(input: WorkbenchRequest<'nativeDocument'>): Promise<WorkbenchResponse<'nativeDocument'>> {
        const request = workbenchInputs.nativeDocument.parse(input);
        const session = await this.resolveSource(request.source, request.document, { allowInactive: true });
        const downloadUrl = resourceUrl(WORKBENCH_DOCUMENT_PATH, request);
        if (request.document.kind === 'generated-media') {
            const response = await this.client.readBinary(sourcePath(request.source.sourceSessionId, `/generated-images/${encodeURIComponent(request.document.imageId)}`), { maxBytes: MAX_SOURCE_GENERATED_MEDIA });
            if (response.status !== 200 || !response.data.byteLength || response.data.byteLength > MAX_SOURCE_GENERATED_MEDIA) {
                throw new HapiRequestError('The original generated media is empty, partial or too large', 'indeterminate', 502);
            }
            const name = response.fileName && response.fileName !== 'native-resource' ? response.fileName : request.document.fileName;
            const decoded = readableText(response.data, response.mimeType, name);
            return { document: request.document, fileName: name, mimeType: response.mimeType, size: response.data.byteLength, writable: false,
                text: decoded?.text ?? null, ...(decoded ? { format: decoded.format } : {}), downloadUrl, officePreview: false };
        }
        if (request.document.kind === 'artifact') {
            const response = await this.client.readBinary(sourcePath(request.source.sourceSessionId, `/artifacts/${encodeURIComponent(request.document.artifactId)}`), { maxBytes: MAX_DOCUMENT_BYTES });
            const name = response.fileName || request.document.fileName;
            const mimeType = response.mimeType === 'application/octet-stream' ? mimeFor(name) : response.mimeType;
            const decoded = readableText(response.data, mimeType, name);
            return { document: request.document, fileName: name, mimeType, size: response.data.byteLength, writable: false,
                text: decoded?.text ?? null, ...(decoded ? { format: decoded.format } : {}), downloadUrl, officePreview: officeExtensions.has(extension(name)) };
        }
        const document = request.document;
        const query = new URLSearchParams({ path: document.path });
        const metadata = parseResponse(fileInfo, await this.client.request(sourcePath(request.source.sourceSessionId, `/file-info?${query}`)));
        assertSuccess(metadata);
        const info = metadata.entries?.find(entry => entry.path === document.path);
        if (info?.size === undefined) throw new HapiRequestError('The source did not return this file size', 'rejected', 404);
        if (info.size > MAX_DOCUMENT_BYTES) throw new HapiRequestError('Document preview is limited to 64 MiB', 'rejected', 413, 'too-large');
        const name = fileName(document.path);
        const mimeType = mimeFor(name);
        const result: WorkbenchResponse<'nativeDocument'> = { document, fileName: name, mimeType, size: info.size, writable: false, text: null, downloadUrl, officePreview: officeExtensions.has(extension(name)), ...(info.modified === undefined ? {} : { modified: info.modified }) };
        // Large and binary files use the bounded binary route; editable data is never
        // inflated into the JSON RPC beyond the source's real 4 MiB edit limit.
        if (info.size > MAX_EDITABLE_BYTES) return result;
        const response = parseResponse(fileRead, await this.client.request(sourcePath(request.source.sourceSessionId, `/file?${query}`)));
        assertSuccess(response);
        if (response.content === undefined) throw new HapiRequestError('The source did not return file contents', 'indeterminate', undefined, 'protocol_mismatch');
        const bytes = Buffer.from(response.content, 'base64');
        if (bytes.byteLength > MAX_EDITABLE_BYTES) throw new HapiRequestError('The file changed size while loading. Reload its source metadata.', 'rejected', 409);
        const decoded = readableText(bytes, mimeType, name);
        return { ...result, size: bytes.byteLength, text: decoded?.text ?? null, ...(decoded ? { format: decoded.format } : {}), writable: session.active && decoded !== null && !decoded.format.mixed && response.writable === true && response.hash !== undefined,
            ...(response.hash === undefined ? {} : { hash: response.hash }), ...(response.modified === undefined ? {} : { modified: response.modified }) };
    }
    async nativeFileSave(input: WorkbenchRequest<'nativeFileSave'>): Promise<WorkbenchResponse<'nativeFileSave'>> {
        const request = workbenchInputs.nativeFileSave.parse(input);
        await this.resolveSource(request.source);
        if (request.format?.mixed) throw new HapiRequestError('Mixed line endings are read-only to preserve the source format', 'rejected', 400);
        const bytes = Buffer.from((request.format?.bom ? '\ufeff' : '') + (request.format?.eol === '\r\n' ? request.text.replaceAll('\n', '\r\n') : request.text), 'utf8');
        if (bytes.byteLength > MAX_EDITABLE_BYTES) throw new HapiRequestError('Text editing is limited to 4 MiB', 'rejected', 413, 'too-large');
        return parseResponse(workbenchOutputs.nativeFileSave, await this.client.request(sourcePath(request.source.sourceSessionId, '/file'), {
            method: 'PUT', body: { path: request.path, content: bytes.toString('base64'), expectedHash: request.expectedHash },
        }));
    }
    async nativeFileInspect(input: WorkbenchRequest<'nativeFileInspect'>, signal?: AbortSignal): Promise<WorkbenchResponse<'nativeFileInspect'>> {
        const request = workbenchInputs.nativeFileInspect.parse(input);
        await this.resolveSource(request.source);
        signal?.throwIfAborted();
        return parseResponse(workbenchOutputs.nativeFileInspect, await this.client.request(sourcePath(request.source.sourceSessionId, `/filesystem/entry?${new URLSearchParams({ path: request.path })}`), { timeoutMs: 120_000, ...(signal ? { signal } : {}) }));
    }

    /**
     * Document reads use HAPI's original read endpoint, not filesystem management.
     * Its Hub selects the owning machine and its Runner enforces browse roots;
     * inactive chats and authorized files outside the chat cwd remain readable.
     * A management denial is never retried through a different owner.
     */
    async readSourceDocument(source: WorkbenchSource, path: string, signal: AbortSignal, maxBytes: number = MAX_DOCUMENT_BYTES): Promise<SourceDocumentRead> {
        const session = await this.resolveSource(source, { kind: 'file', path }, { allowInactive: true });
        signal.throwIfAborted();
        if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new HapiRequestError('Invalid document byte limit', 'rejected', 400);
        const limit = Math.min(maxBytes, MAX_DOCUMENT_BYTES);
        const response = parseResponse(fileRead, await this.client.request(sourcePath(source.sourceSessionId, `/file?${new URLSearchParams({ path })}`), {
            signal, timeoutMs: 120_000, maxResponseBytes: Math.ceil(limit / 3) * 4 + 65_536,
        }));
        signal.throwIfAborted();
        assertSuccess(response);
        const encoded = response.content;
        const unpadded = encoded?.replace(/={1,2}$/, '');
        if (encoded === undefined || encoded.length % 4 !== 0 || /[^A-Za-z0-9+/]/.test(unpadded!)) {
            throw new HapiRequestError('The source returned invalid document bytes', 'indeterminate', 502, 'protocol_mismatch');
        }
        if (Buffer.byteLength(encoded, 'base64') > limit) throw new HapiRequestError('The document exceeds the requested byte limit', 'rejected', 413, 'too-large');
        const data = Buffer.from(encoded, 'base64');
        const version = createHash('sha256').update(data).digest('hex');
        if (response.size !== undefined && response.size !== data.byteLength || response.hash !== undefined && response.hash !== version) {
            throw new HapiRequestError('The source document bytes do not match their metadata', 'indeterminate', 502, 'protocol_mismatch');
        }
        const paths = win32.isAbsolute(session.metadata!.path) && !posix.isAbsolute(session.metadata!.path) ? win32 : posix;
        const absolutePath = response.path ?? paths.resolve(session.metadata!.path, path);
        if (!paths.isAbsolute(absolutePath) || absolutePath.includes('\0') || absolutePath.length > 8192) throw new HapiRequestError('The source returned an invalid document path', 'indeterminate', 502, 'protocol_mismatch');
        return { absolutePath, version, data, writable: response.writable === true, ...(response.modified === undefined ? {} : { modified: response.modified }) };
    }
    async readSourceFile(source: WorkbenchSource, path: string, signal: AbortSignal, maxBytes: number = MAX_DOCUMENT_BYTES): Promise<Uint8Array> {
        return (await this.readSourceDocument(source, path, signal, maxBytes)).data;
    }
    /** Read-only metadata under the same source document policy, for file watches. */
    async sourceDocumentInfo(source: WorkbenchSource, path: string, signal: AbortSignal): Promise<{ size: number; modified?: number } | null> {
        await this.resolveSource(source, { kind: 'file', path }, { allowInactive: true });
        signal.throwIfAborted();
        const result = parseResponse(fileInfo, await this.client.request(sourcePath(source.sourceSessionId, `/file-info?${new URLSearchParams({ path })}`), { signal, timeoutMs: 30_000 }));
        signal.throwIfAborted();
        assertSuccess(result);
        const entry = result.entries?.find(value => value.path === path);
        if (!entry || entry.size === undefined) return null;
        return { size: entry.size, ...(entry.modified === undefined ? {} : { modified: entry.modified }) };
    }
    /**
     * Bytes of a source path through the original HAPI artifact route.
     *
     * The session file routes (`/filesystem/*`) confine the Runner to the
     * session working directory. HAPI deliberately grants one extra authority:
     * a `session-file:` artifact may also name a file this session uploaded in
     * the Runner's upload area, outside the workspace. Only the artifact route
     * performs that check (`cli/src/modules/common/handlers/artifacts.ts`), so a
     * path the original HAPI UI previewed through an artifact must be read
     * through that same route here. The Runner stays the only judge: an
     * unauthorized outside path is rejected there, never read from the Hub.
     */
    async readSourceArtifactBytes(source: WorkbenchSource, path: string, signal: AbortSignal, maxBytes: number = MAX_DOCUMENT_BYTES): Promise<Uint8Array> {
        await this.resolveSource(source, { kind: 'file', path });
        signal.throwIfAborted();
        const artifactId = `session-file:${Buffer.from(path, 'utf8').toString('base64url')}`;
        const result = await this.client.readBinary(sourcePath(source.sourceSessionId, `/artifacts/${encodeURIComponent(artifactId)}`), {
            maxBytes: Math.min(maxBytes, MAX_DOCUMENT_BYTES), signal, timeoutMs: 120_000,
        });
        return result.data;
    }
    async nativeFileManage(input: WorkbenchRequest<'nativeFileManage'>): Promise<WorkbenchResponse<'nativeFileManage'>> {
        const request = workbenchInputs.nativeFileManage.parse(input);
        await this.resolveSource(request.source);
        return parseResponse(workbenchOutputs.nativeFileManage, await this.client.request(sourcePath(request.source.sourceSessionId, '/filesystem'), { method: 'POST', body: request.operation, timeoutMs: 120_000 }));
    }
    async nativeFileUpload(input: WorkbenchRequest<'nativeFileUpload'>): Promise<WorkbenchResponse<'nativeFileUpload'>> {
        const request = workbenchInputs.nativeFileUpload.parse(input);
        await this.resolveSource(request.source);
        if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(request.content)
            || Buffer.byteLength(request.content, 'base64') > MAX_DOCUMENT_BYTES) throw new HapiRequestError('Invalid upload bytes or file exceeds 64 MiB', 'rejected', 413);
        return parseResponse(workbenchOutputs.nativeFileUpload, await this.client.request(sourcePath(request.source.sourceSessionId, '/filesystem/upload'), { method: 'POST', body: { path: request.path, content: request.content }, timeoutMs: 120_000 }));
    }
    async nativePreview(input: WorkbenchRequest<'nativePreview'>): Promise<WorkbenchResponse<'nativePreview'>> {
        const request = workbenchInputs.nativePreview.parse(input);
        if (request.document.kind === 'generated-media') throw new HapiRequestError('The original source has no Office conversion route for generated media', 'rejected', 400);
        await this.resolveSource(request.source, request.document, { allowInactive: true });
        const response = parseResponse(previewRead, await this.client.request(sourcePath(request.source.sourceSessionId, '/document-preview?mode=range'), {
            method: 'POST', body: { document: request.document, ...(request.version === undefined ? {} : { version: request.version }) }, timeoutMs: 90_000,
        }));
        return { ...response, url: resourceUrl(WORKBENCH_PREVIEW_PATH, { source: request.source, previewId: response.previewId }) };
    }

    mount({ webServer, authorize }: FederationMount): void {
        for (const path of [WORKBENCH_DOCUMENT_PATH, WORKBENCH_PREVIEW_PATH]) {
            this.disposers.push(webServer.register({ kind: 'exact', path, handler: async (request, response) => {
                const rejection = authorize(request);
                if (rejection !== undefined) { response.writeHead(rejection); response.end(); return; }
                await this.serveBinary(path, request, response);
            } }));
        }
    }
    close(): void {
        this.lifetime.abort(new Error('The source workbench was closed'));
        for (const dispose of this.disposers.splice(0)) dispose();
    }
    private async serveBinary(path: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
        if (request.method !== 'GET') { response.writeHead(405, { allow: 'GET' }); response.end(); return; }
        const abort = new AbortController();
        response.once('close', () => abort.abort());
        try {
            const raw = new URL(request.url ?? '/', 'http://workbench.local').searchParams.get('request');
            if (!raw || raw.length > 32_768) throw new HapiRequestError('Invalid document request', 'rejected', 400);
            const value: unknown = JSON.parse(raw);
            let upstream: string;
            let name: string;
            let mimeType: string | undefined;
            let generatedMedia = false;
            let documentFile: { source: WorkbenchSource; path: string } | undefined;
            if (path === WORKBENCH_DOCUMENT_PATH) {
                const input = workbenchInputs.nativeDocument.parse(value);
                generatedMedia = input.document.kind === 'generated-media';
                await this.resolveSource(input.source, input.document, { allowInactive: true });
                upstream = input.document.kind === 'file'
                    ? ''
                    : input.document.kind === 'generated-media'
                        ? sourcePath(input.source.sourceSessionId, `/generated-images/${encodeURIComponent(input.document.imageId)}`)
                        : sourcePath(input.source.sourceSessionId, `/artifacts/${encodeURIComponent(input.document.artifactId)}`);
                name = input.document.kind === 'file' ? fileName(input.document.path) : input.document.fileName;
                if (input.document.kind === 'file') { mimeType = mimeFor(name); documentFile = { source: input.source, path: input.document.path }; }
            } else {
                const input = previewRequest.parse(value);
                await this.resolveSource(input.source, undefined, { allowInactive: true });
                upstream = sourcePath(input.source.sourceSessionId, `/document-preview/${encodeURIComponent(input.previewId)}`);
                name = 'preview.pdf'; mimeType = 'application/pdf';
            }
            const range = path === WORKBENCH_PREVIEW_PATH && typeof request.headers.range === 'string' ? request.headers.range : undefined;
            const result = documentFile
                ? { data: await this.readSourceFile(documentFile.source, documentFile.path, abort.signal), fileName: name, mimeType: mimeType!, status: 200, headers: {} as Record<string, string> }
                : await this.client.readBinary(upstream, { maxBytes: generatedMedia ? MAX_SOURCE_GENERATED_MEDIA : MAX_DOCUMENT_BYTES, timeoutMs: 120_000, signal: abort.signal, ...(range === undefined ? {} : { headers: { Range: range } }) });
            if (generatedMedia && (result.status !== 200 || !result.data.byteLength || result.data.byteLength > MAX_SOURCE_GENERATED_MEDIA)) {
                throw new HapiRequestError('The original generated media is empty, partial or too large', 'indeterminate', 502);
            }
            const downloadedName = result.fileName && result.fileName !== 'native-resource' ? result.fileName : name;
            const headers: Record<string, string> = { 'content-type': mimeType ?? result.mimeType, 'content-length': String(result.data.byteLength), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
                'content-disposition': `${path === WORKBENCH_PREVIEW_PATH ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(path === WORKBENCH_PREVIEW_PATH ? name : downloadedName)}` };
            if (path === WORKBENCH_PREVIEW_PATH && result.headers['content-range']) headers['content-range'] = result.headers['content-range'];
            if (path === WORKBENCH_PREVIEW_PATH) headers['accept-ranges'] = 'bytes';
            response.writeHead(result.status, headers); response.end(result.data);
        } catch (error) {
            if (response.destroyed) return;
            const status = error instanceof HapiRequestError ? error.status ?? 502 : 400;
            response.writeHead(status >= 400 && status <= 599 ? status : 502, { 'content-type': 'application/json', 'cache-control': 'no-store' });
            response.end(JSON.stringify({ error: error instanceof HapiRequestError ? error.message : 'Invalid workbench resource request' }));
        }
    }
}
