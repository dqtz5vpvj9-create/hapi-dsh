/** Native display material; execution names and ownership never enter the DSH tool registry. */
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import { isRecord, nativeText, type NativeItem } from './codex-native.ts';

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
        if (part.type === 'image' || part.type === 'inputImage' || part.type === 'input_image') return text('Image output');
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
export function nativeToolPresentation(item: NativeItem): NativeToolPresentation | undefined {
    const name = `codex.${item.type}`;
    const isError = item.status === 'failed' || item.status === 'declined' || item.success === false
        || item.error != null || typeof item.exitCode === 'number' && item.exitCode !== 0;
    switch (item.type) {
        case 'commandExecution': return { name, isError,
            input: { command: item.command, cwd: item.cwd, commandActions: item.commandActions ?? [],
                ...(typeof item.processId === 'string' ? { processId: item.processId } : {}) },
            content: text({ output: nativeText(item.aggregatedOutput), exitCode: item.exitCode ?? null, durationMs: item.durationMs ?? null }) };
        case 'fileChange': return { name, isError, input: { changes: item.changes ?? [] }, content: text(item.changes ?? []) };
        case 'webSearch': return { name, isError, input: { query: item.query, action: item.action }, content: text(item.results ?? item.action ?? item.query ?? '') };
        // This source emits the public read_image vocabulary so its unique, authorized
        // image-gallery child slot remains owned by the official DSH registrant.
        case 'imageView': return { name: 'read_image', isError, input: { file_path: item.path }, content: text(nativeText(item.path)) };
        case 'imageGeneration': return { name, isError: isError || item.failure != null,
            input: { prompt: item.revisedPrompt, ...(typeof item.savedPath === 'string' ? { path: item.savedPath } : {}) },
            content: text(item.failure ?? { status: item.status, ...(typeof item.savedPath === 'string' ? { path: item.savedPath } : {}) }) };
        case 'mcpToolCall': {
            const result = isRecord(item.result) ? item.result : undefined;
            const content = result && Array.isArray(result.content) ? outputContent(result.content) : [];
            if (result?.structuredContent != null) content.push(...text(result.structuredContent));
            if (item.error != null) content.push(...text(isRecord(item.error) ? item.error.message ?? item.error : item.error));
            return { name, isError, input: { server: item.server, tool: item.tool, arguments: item.arguments ?? {} }, content };
        }
        case 'dynamicToolCall': return { name, isError,
            input: { namespace: item.namespace, tool: item.tool, arguments: item.arguments ?? {} },
            content: outputContent(item.contentItems ?? item.output ?? []) };
        case 'collabAgentToolCall': return { name, isError,
            input: { tool: item.tool, prompt: item.prompt, receiverThreadIds: item.receiverThreadIds ?? [], model: item.model, reasoningEffort: item.reasoningEffort },
            content: text({ status: item.status, agentsStates: item.agentsStates ?? {} }) };
        case 'subAgentActivity': return { name, isError,
            input: { kind: item.kind, agentPath: item.agentPath, agentThreadId: item.agentThreadId, model: item.model, reasoningEffort: item.reasoningEffort },
            content: text({ kind: item.kind, agentPath: item.agentPath, model: item.model, reasoningEffort: item.reasoningEffort }) };
        case 'functionCallOutput': return { name, isError,
            input: { tool: item.name, namespace: item.namespace }, content: outputContent(item.output) };
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
