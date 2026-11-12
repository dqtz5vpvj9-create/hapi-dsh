import type { FileUploadValue, ImageUploadValue } from '@deepseek-ai/dsh-client-file-upload/types';
/** Native display material; execution names and ownership never enter the DSH tool registry. */
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import { isRecord, nativeText, type NativeItem } from './codex-native.ts';
import { createHash } from 'node:crypto';
import type { NativeImagePlan } from './codex-image-pages.ts';

export interface NativeToolPresentation {
    name: string;
    input: Record<string, unknown>;
    content: ContentBlock[];
    isError: boolean;
}

const text = (value: unknown): ContentBlock[] => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2) }];

/** Keep text readable instead of printing the transport's content-block envelope. */
function outputContent(value: unknown): ContentBlock[] {
    if (!Array.isArray(value)) return text(value);
    return value.flatMap((part): ContentBlock[] => {
        if (!isRecord(part)) return text(part);
        if ((part.type === 'text' || part.type === 'inputText' || part.type === 'input_text' || part.type === 'output_text') && typeof part.text === 'string') return text(part.text);
        if (part.type === 'image' || part.type === 'inputImage' || part.type === 'input_image' || part.type === 'output_image') return text('Image output');
        if (part.type === 'audio' || part.type === 'inputAudio' || part.type === 'input_audio') return text('Audio output');
        if (part.type === 'encrypted_content') return text('Encrypted output');
        return text(part);
    });
}

/** No raw native IDs or embedded image bytes are used as visible message copy. */
export function nativeUserContent(item: NativeItem): ContentBlock[] {
    return (Array.isArray(item.content) ? item.content : []).flatMap((value): ContentBlock[] => {
        if (!isRecord(value)) return [];
        if (value.type === 'text' && typeof value.text === 'string') return text(value.text);
        if (value.type === 'image' || value.type === 'localImage') return text('Image attachment');
        if (value.type === 'audio' || value.type === 'localAudio') return text('Audio attachment');
        if (value.type === 'skill' || value.type === 'mention') return text(nativeText(value.name) || String(value.type));
        return [];
    });
}

/** Preserve source semantics needed by the official shell, diff and details rows. */
export function nativeToolPresentation(item: NativeItem, preparedContent?: readonly ContentBlock[]): NativeToolPresentation | undefined {
    const name = `codex.${item.type}`;
    const isError = item.status === 'failed' || item.status === 'declined' || item.success === false
        || item.error != null || typeof item.exitCode === 'number' && item.exitCode !== 0
        || item.type === 'mcpToolCall' && isRecord(item.result) && item.result.isError === true;
    switch (item.type) {
        case 'commandExecution': return { name, isError,
            input: { command: item.command, cwd: item.cwd, commandActions: item.commandActions ?? [],
                ...(typeof item.processId === 'string' ? { processId: item.processId } : {}) },
            content: text({ output: nativeText(item.aggregatedOutput), exitCode: item.exitCode ?? null, durationMs: item.durationMs ?? null }) };
        case 'fileChange': return { name, isError, input: { changes: item.changes ?? [] }, content: text(item.changes ?? []) };
        case 'webSearch': return { name, isError, input: { query: item.query, action: item.action }, content: text(item.results ?? item.action ?? item.query ?? '') };
        // This source emits the public read_image vocabulary so its unique, authorized
        // image-gallery child slot remains owned by the official DSH registrant.
        case 'imageView': return { name: 'read_image', isError, input: { file_path: item.path }, content: preparedContent ? [...preparedContent] : text(nativeText(item.path)) };
        case 'imageGeneration': return { name, isError: isError || item.failure != null,
            input: { prompt: item.revisedPrompt, ...(typeof item.savedPath === 'string' ? { path: item.savedPath } : {}) },
            content: preparedContent ? [...preparedContent, ...(item.failure == null ? [] : text(item.failure))]
                : text(item.failure ?? { status: item.status, ...(typeof item.savedPath === 'string' ? { path: item.savedPath } : {}) }) };
        case 'mcpToolCall': {
            const result = isRecord(item.result) ? item.result : undefined;
            // Preview preparation replaces only the native media blocks. It must
            // not replace structured results or a source-reported error.
            const content = preparedContent ? [...preparedContent] : result && Array.isArray(result.content) ? outputContent(result.content) : [];
            if (result?.structuredContent != null) content.push(...text(result.structuredContent));
            if (item.error != null) content.push(...text(isRecord(item.error) ? item.error.message ?? item.error : item.error));
            return { name, isError, input: { server: item.server, tool: item.tool, arguments: item.arguments ?? {} }, content };
        }
        case 'dynamicToolCall': return { name, isError,
            input: { namespace: item.namespace, tool: item.tool, arguments: item.arguments ?? {} },
            content: preparedContent ? [...preparedContent] : outputContent(item.contentItems ?? item.output ?? []) };
        case 'collabAgentToolCall': return { name, isError,
            input: { tool: item.tool, prompt: item.prompt, receiverThreadIds: item.receiverThreadIds ?? [], model: item.model, reasoningEffort: item.reasoningEffort },
            content: text({ status: item.status, agentsStates: item.agentsStates ?? {} }) };
        case 'subAgentActivity': return { name, isError,
            input: { kind: item.kind, agentPath: item.agentPath, agentThreadId: item.agentThreadId, model: item.model, reasoningEffort: item.reasoningEffort },
            content: text({ kind: item.kind, agentPath: item.agentPath, model: item.model, reasoningEffort: item.reasoningEffort }) };
        case 'functionCallOutput': return { name, isError,
            input: { tool: item.name, namespace: item.namespace }, content: preparedContent ? [...preparedContent] : outputContent(item.output) };
        case 'sleep': return { name, isError, input: { durationMs: item.durationMs }, content: text({ durationMs: item.durationMs }) };
        default: return undefined;
    }
}

/** Known non-tool records retain their content instead of an implementation placeholder. */
export function nativeOtherContent(item: NativeItem): ContentBlock[] {
    if (item.type === 'hookPrompt' && Array.isArray(item.fragments)) return text(item.fragments.filter(isRecord).map(value => nativeText(value.text)).join('\n\n'));
    if (item.type === 'enteredReviewMode' || item.type === 'exitedReviewMode') return text(nativeText(item.review) || 'Code review');
    if (item.type === 'contextCompaction') return text('Conversation context compacted.');
    return text(nativeText(item.text) || `Codex activity: ${item.type}`);
}


export interface NativeUploadedPart {
    input: { type: 'text'; text: string; text_elements: never[] } | { type: 'localImage'; path: string };
    value?: FileUploadValue | ImageUploadValue;
    imagePlan?: NativeImagePlan;
}
/** Native serialization may omit detail. Byte identity and order, not display
 * labels or the number of images, correlate retained pages to their receipt. */
export function nativeImageGroup(content: readonly unknown[], start: number, part: NativeUploadedPart): boolean {
    return !!part.imagePlan?.pages.length && part.imagePlan.pages.every((page, offset) => {
        const value = content[start + offset];
        if (!isRecord(value)) return false;
        if (value.type === 'localImage') return value.path === page.path;
        if (value.type !== 'image' || typeof value.url !== 'string') return false;
        const match = /^data:image\/(?:png|jpeg|webp|gif);base64,([A-Za-z0-9+/]*={0,2})$/.exec(value.url);
        if (!match) return false;
        const data = Buffer.from(match[1]!, 'base64');
        return data.length === page.bytes && createHash('sha256').update(data).digest('hex') === page.sha256;
    });
}
/** A persisted operation + exact native input, never an arbitrary text path, supplies durable file authority. */
export function nativeUploadedContent(item: NativeItem, parts: readonly NativeUploadedPart[], prepared?: ContentBlock[]): ContentBlock[] | undefined {
    if (item.type !== 'userMessage' || !Array.isArray(item.content) || !parts.some(part => part.value)) return undefined;
    const content = [...(prepared ?? nativeUserContent(item))];
    let changed = false;
    // User image previews have one block per native image. Keep all unrelated
    // native text/media in place and replace only a complete exact page group.
    let offset = 0;
    let unhandledImage = false;
    const used = new Set<NativeUploadedPart>();
    for (let i = 0; i < item.content.length; i++) {
        const part = parts.find(part => !used.has(part) && part.value && 'image' in part.value && nativeImageGroup(item.content as unknown[], i, part));
        if (part?.imagePlan && part.value && 'image' in part.value) {
            content.splice(offset, part.imagePlan.pages.length, { type: 'image', attachment: part.value.image });
            i += part.imagePlan.pages.length - 1;
            offset++; changed = true; used.add(part);
        } else {
            const value = item.content[i];
            if (isRecord(value) && (value.type === 'image' || value.type === 'localImage')) unhandledImage = true;
            offset += nativeUserContent({ ...item, content: [value] }).length;
        }
    }
    // Let the existing lazy reader prepare any unrelated image first.
    if (!prepared && unhandledImage) return undefined;
    for (const part of parts) {
        if (!part.value || !('file' in part.value) || part.input.type !== 'text') continue;
        // Structured references can place receipts between other native inputs. Match only an exact source-issued input.
        const expected = part.input.text;
        if (!item.content.some((value: unknown) => isRecord(value) && value.type === 'text' && value.text === expected)) continue;
        const index = content.findIndex(value => value.type === 'text' && value.text === expected);
        if (index < 0) continue;
        content[index] = { type: 'file', attachment: part.value.file }; changed = true;
    }
    return changed ? content : undefined;
}
