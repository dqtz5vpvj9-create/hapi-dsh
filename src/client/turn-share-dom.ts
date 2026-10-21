import type { ShareTurnSelection } from './turn-share-model.ts';
import { SHARE_MAX_MEDIA } from './turn-share-model.ts';

export interface TurnShareSnapshot { html: string; text: string; styles: Readonly<Record<string, string>> }
const excluded = 'script,iframe,object,embed,audio,video,source,input,textarea,select,[data-hapi-share-exclude],[data-hapi-share-dialog],[data-chat-group-part="reasoning"],[data-variant="think"],[data-clock],[data-chat-flow-kind="turn-process"],.hapi-native-user-actions,[data-slot="conversation.chat.assistant-actions"]';

/** Read-only export of the pinned official Chat DOM. No renderer is replaced. */
export async function captureShareTurn(surface: HTMLElement, selection: ShareTurnSelection, signal: AbortSignal): Promise<TurnShareSnapshot> {
    signal.throwIfAborted();
    const all = [...surface.querySelectorAll<HTMLElement>('[data-chat-turn]')].filter(row => Number(row.dataset.chatTurn) === selection.turn);
    const keys = new Set(all.filter(row => row.dataset.chatGroupPart !== 'reasoning').map(row => row.dataset.chatNodeKey).filter(Boolean));
    if (selection.keys.some(key => !keys.has(key))) throw new Error('The official renderer has not finished displaying every message in this turn. Try sharing again.');
    const tops = all.filter(row => !all.some(parent => parent !== row && parent.contains(row)));
    if (!tops.length) throw new Error('The original conversation view is no longer available.');
    const container = document.createElement('div');
    for (const row of tops) container.append(row.cloneNode(true));
    for (const node of container.querySelectorAll(excluded)) node.remove();
    // Preserve useful button labels such as a tool name or source file path,
    // without copying their actions, IDs, hotkeys or focus behavior.
    for (const button of container.querySelectorAll('button')) {
        if (!button.textContent?.trim() && !button.querySelector('img')) { button.remove(); continue; }
        const label = document.createElement('span'); label.className = button.className;
        label.append(...button.childNodes); button.replaceWith(label);
    }
    for (const node of container.querySelectorAll('*')) {
        for (const attr of [...node.attributes]) {
            if (/^on/iu.test(attr.name) || ['id', 'href', 'target', 'rel', 'tabindex', 'contenteditable', 'autofocus', 'form', 'srcdoc', 'aria-controls', 'aria-owns', 'data-chat-turn', 'data-chat-node-key', 'data-chat-anchor-key', 'data-chat-flow-key', 'data-chat-paging-anchor'].includes(attr.name)) node.removeAttribute(attr.name);
        }
    }
    const media = new Map<string, string>(); let total = 0;
    for (const image of container.querySelectorAll('img')) {
        signal.throwIfAborted();
        const original = image.currentSrc || image.src;
        if (!original) throw new Error('An image in this turn has not loaded yet.');
        let data = media.get(original);
        if (!data) {
            const url = new URL(original, location.href);
            if (!['blob:', 'data:', 'https:', 'http:'].includes(url.protocol)) throw new Error('An image cannot be read for this export.');
            const response = await fetch(url, { signal, mode: 'cors', credentials: 'same-origin' });
            if (!response.ok) throw new Error('An image in this turn could not be loaded for export.');
            const blob = await response.blob(); total += blob.size;
            if (total > SHARE_MAX_MEDIA) throw new Error('Images in this turn exceed the 8 MB export limit.');
            data = await new Promise<string>((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob);
            });
            signal.throwIfAborted(); media.set(original, data);
        }
        image.removeAttribute('srcset'); image.loading = 'eager'; image.src = data;
        await image.decode(); signal.throwIfAborted();
    }
    const computed = getComputedStyle(surface), styles: Record<string, string> = {};
    for (const key of computed) if (key.startsWith('--')) styles[key] = computed.getPropertyValue(key);
    for (const key of ['font-family', 'font-size', 'line-height', 'color', 'color-scheme']) styles[key] = computed.getPropertyValue(key);
    const html = container.innerHTML;
    if (new TextEncoder().encode(html).length > 16 * 1024 * 1024) throw new Error('This turn exceeds the export size limit.');
    return { html, text: container.textContent ?? '', styles };
}
