/** Normalize explicit native media blocks; never infer file access from prose or tool arguments. */
import { isRecord, type NativeItem } from './codex-native.ts';

export function nativeContentParts(item: NativeItem): Record<string, unknown>[] {
    if (item.type === 'imageView') return [{ type: 'localImage', path: item.path }];
    if (item.type === 'imageGeneration') {
        if (typeof item.savedPath === 'string' && item.savedPath) return [{ type: 'localImage', path: item.savedPath }];
        return typeof item.result === 'string' && item.result ? [{ type: 'image', url: `data:image/png;base64,${item.result}` }] : [];
    }
    let value: unknown = item.type === 'userMessage' ? item.content
        : item.type === 'mcpToolCall' && isRecord(item.result) ? item.result.content
        : item.type === 'dynamicToolCall' ? item.contentItems ?? item.output
        : item.type === 'functionCallOutput' ? item.output : undefined;
    if (typeof value === 'string') {
        try { const parsed: unknown = JSON.parse(value); if (Array.isArray(parsed)) value = parsed; } catch { /* Ordinary tool text. */ }
    }
    if (!Array.isArray(value)) return [];
    return value.filter(isRecord).map(part => {
        if (['inputImage', 'input_image', 'output_image'].includes(String(part.type))) {
            const url = typeof part.image_url === 'string' ? part.image_url : isRecord(part.image_url) ? part.image_url.url : part.imageUrl ?? part.url;
            return { type: 'image', url, name: part.name };
        }
        if (part.type === 'image' && typeof part.data === 'string' && typeof part.mimeType === 'string') return { type: 'image', url: `data:${part.mimeType};base64,${part.data}`, name: part.name };
        if (['inputText', 'input_text', 'output_text'].includes(String(part.type))) return { type: 'text', text: part.text };
        return part;
    });
}

export function hasNativeImages(item: NativeItem): boolean {
    return nativeContentParts(item).some(part => part.type === 'image' || part.type === 'localImage');
}
