/** Offload oversized native tool material without changing execution records. */
import { TOOL_DETAIL_CHUNK_BYTES, TOOL_DETAIL_MIME, TOOL_INLINE_BYTES, TOOL_PREVIEW_BYTES, type ToolDetailEnvelope, type ToolDetailPage } from '../shared/native-tool-detail.ts';
import type { NativeToolPresentation } from './codex-presentation.ts';
import type { NativeItem } from './codex-native.ts';
import { SourceError } from './errors.ts';
import type { SourceEventIndex } from './event-index.ts';
import type { SourceResource } from './protocol.ts';

const scope = (turnId: string, itemId: string, part: 'input' | 'output'): string => JSON.stringify(['tool-detail', turnId, itemId, part]);
function prefix(bytes: Buffer): string {
    // TextDecoder keeps a split multi-byte character out of the visible preview.
    return new TextDecoder().decode(bytes.subarray(0, TOOL_PREVIEW_BYTES), { stream: true });
}
export class CodexToolDetails {
    constructor(private readonly index: SourceEventIndex) {}
    project(turnId: string, item: NativeItem, tool: NativeToolPresentation): NativeToolPresentation {
        const revision = this.index.cached<number>(`source-declared-revision:${turnId}:${item.id}`) ?? 0;
        const prepare = (part: 'input' | 'output', value: unknown): ToolDetailEnvelope | undefined => {
            const key = scope(turnId, item.id, part), payload = Buffer.from(JSON.stringify(value), 'utf8');
            if (payload.byteLength <= TOOL_INLINE_BYTES) { this.index.clearDetail(key); return; }
            const reference = this.index.putDetail(key, revision, payload);
            return { _hhpiDetail: { kind: 'hhpi-tool-detail', ...reference, part }, preview: prefix(payload) };
        };
        const input = prepare('input', tool.input), output = prepare('output', tool.content);
        const dedicated = (input || output) && (tool.name === 'codex.imageGeneration' || tool.name === 'codex.sleep');
        return { ...tool, ...(dedicated ? { name: 'hhpi-native-tool-detail' } : {}),
            input: dedicated ? { ...(input ?? tool.input), _hhpiSourceTool: tool.name } : input ? { ...input } : tool.input,
            content: output ? [{ type: 'text', text: JSON.stringify(output) }] : tool.content };
    }
    read(path: string): SourceResource {
        const match = /^detail:([0-9a-f-]{36}):(\d+):(\d+)$/.exec(path);
        if (!match) throw new SourceError('INVALID_REQUEST', 'Invalid tool detail reference.');
        const [, ref, revisionText, offsetText] = match;
        const revision = Number(revisionText), offset = Number(offsetText);
        if (!Number.isSafeInteger(revision)) throw new SourceError('INVALID_REQUEST', 'Invalid tool detail revision.');
        const selected = this.index.readDetail(ref!, revision, offset, TOOL_DETAIL_CHUNK_BYTES);
        const identity: unknown = JSON.parse(selected.scope);
        if (!Array.isArray(identity) || identity[0] !== 'tool-detail' || identity.length !== 4
            || (identity[3] !== 'input' && identity[3] !== 'output')
            || !this.index.hasCached(JSON.stringify(['item', identity[1], identity[2]]))) {
            throw new SourceError('STALE_VERSION', 'This native tool no longer grants access to its detail.');
        }
        let content = selected.bytes;
        if (offset + content.byteLength < selected.total) {
            let start = content.byteLength - 1;
            while (start > 0 && (content[start]! & 0xc0) === 0x80) start--;
            const lead = content[start]!, width = lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4;
            if (start + width > content.byteLength) content = content.subarray(0, start);
        }
        const next = offset + content.byteLength;
        const page: ToolDetailPage = { ref: ref!, revision, part: identity[3], offset, total: selected.total,
            nextOffset: next < selected.total ? next : null, bytesBase64: Buffer.from(content).toString('base64') };
        return { encoding: 'base64', mimeType: TOOL_DETAIL_MIME, content: Buffer.from(JSON.stringify(page)).toString('base64') };
    }
}
