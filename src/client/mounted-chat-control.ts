/**
 * Structural consumer for the ext mounted-Chat control.
 *
 * The official Chat plugin looks up an optional `mountedChatConsumer` service
 * and hands it the mounted view's control face, plus null on unmount. The
 * consumer is provided per Pane graph (see `pane-native.ts`), so a control is
 * always associated with exactly one Pane element; the page-global seamless
 * controller resolves the control from the element it is acting on.
 */
import type { Context } from '@deepseek-ai/cordis';

/** Read-side facts published by one mounted Chat view. */
export interface MountedChatReadingV1 {
    readonly revision: number;
    readonly anchor: { readonly key: string; readonly top: number } | null;
    readonly following: boolean;
    readonly hasOlder: boolean;
    readonly busy: boolean;
}

/** Durable history target named by a stable Chat node key and its sequence. */
export interface MountedChatTargetV1 {
    readonly key: string;
    readonly seq: number;
}

/** Control face of one mounted Chat view (ext contract subset). */
export interface MountedChatControlV1 {
    readonly version: 1;
    read(): MountedChatReadingV1;
    subscribe(listener: () => void): () => void;
    loadOlder(signal?: AbortSignal): Promise<void>;
    reveal(target: MountedChatTargetV1, signal?: AbortSignal): Promise<void>;
    toLatest(signal?: AbortSignal): Promise<void>;
}

/** Consumer registered on the Chat plugin's optional service. */
export interface MountedChatConsumerV1 {
    onMountedChat?: (control: MountedChatControlV1 | null) => void;
    readLatest?: (sessionId: string, signal: AbortSignal) => Promise<void>;
}

/** Fetch the newest source window for one Session; rejects when unavailable. */
export type ReadLatestV1 = (sessionId: string, signal: AbortSignal) => Promise<void>;

/** Attribute a Pane element carries while one Chat control is mounted. */
export const MOUNTED_CHAT_ATTRIBUTE = 'data-hapi-mounted-chat';

interface RegisteredControl { control: MountedChatControlV1; readLatest: boolean }
const controls = new Map<string, RegisteredControl>();
const tokens = new WeakMap<object, string>();
let sequence = 0;

/** Minimal Pane element surface the registry needs. */
export interface MountedChatPane {
    readonly dataset: Record<string, string | undefined>;
}

/** Minimal scroll/content element surface used to find its owning Pane. */
export interface MountedChatOwnerLookup {
    closest(selector: string): { dataset?: Record<string, string | undefined> } | null;
}

/**
 * Publish one Pane's mounted control.
 * @param pane - Pane element owning the mounted Chat view.
 * @param control - mounted control, or null when the view unmounted.
 */
export function publishPaneMountedChat(pane: MountedChatPane, control: MountedChatControlV1 | null | undefined, readLatest = false): void {
    const key = tokens.get(pane);
    if (control === null || control === undefined) {
        if (key !== undefined) { controls.delete(key); tokens.delete(pane); }
        delete pane.dataset[MOUNTED_CHAT_ATTRIBUTE];
        return;
    }
    let token = key;
    if (token === undefined) {
        sequence += 1;
        token = `chat-${sequence}`;
        tokens.set(pane, token);
    }
    controls.set(token, { control, readLatest });
    pane.dataset[MOUNTED_CHAT_ATTRIBUTE] = token;
}

/**
 * Resolve the control of the Pane containing the acted-on element.
 * @param element - scroll/content element inside a Pane.
 * @returns that Pane's mounted control, when present.
 */
export function resolveMountedChatForPane(element: MountedChatOwnerLookup): MountedChatControlV1 | undefined {
    const owner = element.closest(`[${MOUNTED_CHAT_ATTRIBUTE}]`);
    const token = owner?.dataset?.[MOUNTED_CHAT_ATTRIBUTE];
    return token === undefined ? undefined : controls.get(token)?.control;
}

/**
 * Resolve the control only when its consumer can fetch the newest source window.
 * `toLatest` must not land on a stale retained window and call it the tail.
 * @param element - scroll/content element inside a Pane.
 * @returns that Pane's control when `readLatest` is provided.
 */
export function resolveMountedChatLatestForPane(element: MountedChatOwnerLookup): MountedChatControlV1 | undefined {
    const owner = element.closest(`[${MOUNTED_CHAT_ATTRIBUTE}]`);
    const token = owner?.dataset?.[MOUNTED_CHAT_ATTRIBUTE];
    const registered = token === undefined ? undefined : controls.get(token);
    return registered?.readLatest ? registered.control : undefined;
}

/**
 * Request one older page through the mounted control.
 * @param control - resolved control, when the Pane has one.
 * @param signal - caller cancellation.
 * @returns true when the control accepted the page; false means fall back.
 */
export async function requestOlderThroughMountedChat(
    control: MountedChatControlV1 | undefined, signal: AbortSignal,
): Promise<boolean> {
    if (!control) return false;
    try { await control.loadOlder(signal); return true }
    catch { return false }
}

/**
 * Land on the tail through the mounted control; the control asks `readLatest`
 * first when this consumer provides it.
 * @param control - resolved control, when the Pane has one.
 * @param signal - caller cancellation.
 * @returns true when the control committed the tail landing; false means fall
 * back to the source's own latest path.
 */
export async function toLatestThroughMountedChat(
    control: MountedChatControlV1 | undefined, signal: AbortSignal,
): Promise<boolean> {
    if (!control) return false;
    try { await control.toLatest(signal); return true }
    catch { return false }
}

/**
 * Provide the consumer on one Pane graph. The pane's control is published under
 * its own element, so unmounting one Pane never clears another's control.
 * @param ctx - pane graph context.
 * @param pane - Pane element that owns this graph's Chat view.
 * @returns disposer clearing this pane's registration.
 */
export function installPaneMountedChatConsumer(ctx: Context, pane: MountedChatPane, readLatest?: ReadLatestV1): () => void {
    const consumer: MountedChatConsumerV1 = {
        onMountedChat: control => {
            try { performance.mark(control ? 'hapi-dsh:mounted-chat:control' : 'hapi-dsh:mounted-chat:unmounted') } catch { /* diagnostics are optional */ }
            publishPaneMountedChat(pane, control, readLatest !== undefined)
        },
        ...(readLatest === undefined ? {} : { readLatest }),
    };
    try { performance.mark('hapi-dsh:mounted-chat:provided') } catch { /* diagnostics are optional */ }
    const unprovide = ctx.reflect.provide('mountedChatConsumer', consumer);
    return () => {
        publishPaneMountedChat(pane, null);
        unprovide?.();
    };
}

/** Clear all registrations; only for tests and full client teardown. */
export function resetMountedChatRegistrations(): void {
    controls.clear();
}
