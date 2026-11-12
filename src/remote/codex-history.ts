/** Normalize native items once, at their source. Paging only reads SourceEventIndex. */
import { freezeMessage, MessageId, ToolCallId, type ContentBlock } from '@deepseek-ai/dsh-llm';
import type { SessionEventMap, SessionEventType, TurnEndReason } from '@deepseek-ai/dsh-session';
import { SourceEventIndex, type EventInput } from './event-index.ts';
import { isRecord, nativeText, type NativeItem, type NativeItemEntry, type NativeTurn } from './codex-native.ts';
import { nativeOtherContent, nativeToolPresentation, nativeUserContent, type NativeToolPresentation } from './codex-presentation.ts';
import type { SourceSession } from './protocol.ts';

/** Reproject accepted native records to expose plan actions and generated image galleries. */
export const CODEX_HISTORY_PROJECTION_VERSION = 7;
export interface CodexHistoryOptions {
    userContent?: (turnId: string, item: NativeItem) => ContentBlock[] | undefined;
    toolContent?: (turnId: string, item: NativeItem) => ContentBlock[] | undefined;
    /** Source-native ordinals, persisted before projection; never browser offsets. */
    nativeOrder?: boolean;
    toolPresentation?: (turnId: string, item: NativeItem, tool: NativeToolPresentation) => NativeToolPresentation;
}
interface ItemState { item: NativeItem; turnId: string; time: number; completed: boolean; completedAtMs?: number; presentationContent?: ContentBlock[] }
interface TurnState { turn: NativeTurn; time: number }
/** A Review outer turn can lack task_started; this is a derived projection
 * boundary at its first real item, not an invented native event or identity. */
export interface NativeReviewStart { itemId: string; ordinal: number; turnOrdinal: number }
const key = (...parts: string[]): string => JSON.stringify(parts);
const turnKey = (id: string): string => key('turn', id);
const itemKey = (turn: string, id: string): string => key('item', turn, id);

/** DSH compatibility has lifecycle coupling; all lifecycle IDs live only here. */
export class CodexHistory {
    constructor(readonly index: SourceEventIndex, private readonly options: CodexHistoryOptions = {}) {}
    hasTurn(id: string): boolean { return this.index.cached(turnKey(id)) !== undefined; }
    turnState(id: string): NativeTurn | undefined { return this.index.cached<TurnState>(turnKey(id))?.turn; }
    itemState(turnId: string, itemId: string): ItemState | undefined { return this.index.cached<ItemState>(itemKey(turnId, itemId)); }
    /** Return only an event that this projection actually accepted for the exact native identity. */
    locatePosition(turnId: string, itemId?: string): number | undefined {
        if (itemId === undefined) return this.index.sequence(key('turn', turnId, 'start'));
        const native = itemKey(turnId, itemId);
        return this.index.sequence(key(native, 'message')) ?? this.index.sequence(key(native, 'tool/call'))
            ?? this.index.sequence(key(native, 'step/start'));
    }
    private event<T extends SessionEventType>(type: T, data: SessionEventMap[T], time: number): EventInput {
        return { type, data, time, ...(['user/message', 'assistant/message', 'tool/result'].includes(type) ? { surfaceOp: 'append' as const } : {}) } as EventInput;
    }
    private ensureTurn(turnId: string, time: number): { turn: number; start: string } {
        const ordinal = this.options.nativeOrder ? this.index.cached<number>(`source-turn:${turnId}`) : undefined;
        const review = this.options.nativeOrder ? this.index.cached<NativeReviewStart>(`source-review-start:${turnId}`) : undefined;
        const turn = this.index.coordinate('turn', '', turnId, ordinal), start = key('turn', turnId, 'start');
        if (this.index.sequence(start) === undefined) this.index.put(start, this.event('turn/start', { turn }, time), [], review ? review.ordinal * 8 : ordinal === undefined ? undefined : ordinal * 8);
        return { turn, start };
    }
    beginTurn(session: SourceSession, turn: NativeTurn): void {
        if (this.options.nativeOrder && this.index.cached<number>(`source-turn:${turn.id}`) === undefined) return;
        this.index.edit(session, () => {
            const previous = this.index.cached<TurnState>(turnKey(turn.id));
            const time = previous?.time ?? (turn.startedAt == null ? session.updatedAt : turn.startedAt * 1000);
            this.ensureTurn(turn.id, time);
            // Keep the last accepted terminal boundary until the source provides a genuine rewrite.
            if (!previous || previous.turn.status === 'inProgress') this.index.cache(turnKey(turn.id), { turn: { ...turn, status: 'inProgress' }, time } satisfies TurnState);
        });
    }
    invalidateSuffix(session: SourceSession, turnIds: readonly string[]): void {
        const sequences = turnIds.flatMap(id => { const seq = this.index.sequence(key('turn', id, 'start')); return seq === undefined ? [] : [seq]; });
        this.index.edit(session, () => {
            if (sequences.length) this.index.removeFrom(Math.min(...sequences));
            for (const id of turnIds) {
                this.index.forget(turnKey(id));
                this.index.forget(JSON.stringify(['item', id]).slice(0, -1) + ',');
                this.index.forget(`tail:${id}`);
            }
            const before = this.index.cached<string[]>('turn-order') ?? [];
            this.index.cache('turn-order', before.filter(id => !turnIds.includes(id)));
        });
    }
    acceptTurn(session: SourceSession, turn: NativeTurn, includeItems = false): void {
        if (this.options.nativeOrder && this.index.cached<number>(`source-turn:${turn.id}`) === undefined) return;
        this.index.edit(session, () => {
            const previous = this.index.cached<TurnState>(turnKey(turn.id));
            const time = previous?.time ?? (turn.startedAt == null ? session.updatedAt : turn.startedAt * 1000);
            this.ensureTurn(turn.id, time);
            this.index.cache(turnKey(turn.id), { turn, time } satisfies TurnState);
            if (includeItems) for (const item of turn.items ?? []) this.acceptItemInEdit(session, { turnId: turn.id, item }, turn.status !== 'inProgress');
            if (turn.status !== 'inProgress' && (!this.options.nativeOrder || this.index.cached<number>(`source-end:${turn.id}`) !== undefined)) {
                const numericTurn = this.index.coordinate('turn', '', turn.id, this.options.nativeOrder ? this.index.cached<number>(`source-turn:${turn.id}`) : undefined);
                const reason: TurnEndReason = turn.status === 'completed' ? { kind: 'completed' }
                    : turn.status === 'interrupted' ? { kind: 'aborted', reason: { kind: 'user' } }
                        : { kind: 'error', error: { code: 'CODEX_NATIVE_TURN_FAILED', message: isRecord(turn.error) ? nativeText(turn.error.message) || 'The source turn failed.' : 'The source turn failed.' } };
                this.index.put(key('turn', turn.id, 'end'), this.event('turn/end', { turn: numericTurn, reason }, turn.completedAt == null ? time : turn.completedAt * 1000), [key('turn', turn.id, 'start')], this.options.nativeOrder ? this.index.cached<number>(`source-end:${turn.id}`)! * 8 + 7 : undefined);
            }
        });
    }
    acceptItems(session: SourceSession, entries: readonly NativeItemEntry[], terminal: boolean): void {
        this.index.edit(session, () => { for (const entry of entries) this.acceptItemInEdit(session, entry, terminal || entry.completedAtMs != null); });
    }
    acceptItem(session: SourceSession, turnId: string, item: NativeItem, completed: boolean): void {
        this.acceptItems(session, [{ turnId, item }], completed);
    }
    private acceptItemInEdit(session: SourceSession, entry: NativeItemEntry, completed: boolean): void {
        const { turnId, item } = entry, nativeKey = itemKey(turnId, item.id);
        const ordinal = this.options.nativeOrder ? this.index.cached<number>(`source-item:${turnId}:${item.id}`) : undefined;
        if (this.options.nativeOrder && ordinal === undefined) return; // Live snapshots wait for their authoritative native position.
        const review = this.options.nativeOrder ? this.index.cached<NativeReviewStart>(`source-review-start:${turnId}`) : undefined;
        // Keep the boundary after every subevent of the preceding native
        // ordinal. Only this first Review item uses slots 1–5 instead of 0–4;
        // slot 0 carries its derived turn/start. Native ordinals stay intact.
        const shift = review?.itemId === item.id && review.ordinal === ordinal ? 1 : 0;
        const position = (slot: number): number | undefined => ordinal === undefined ? undefined : ordinal * 8 + slot + shift;
        const prior = this.index.cached<ItemState>(nativeKey);
        // A replayed started event cannot downgrade an already completed item.
        if (prior?.completed && !completed) return;
        const time = prior?.time ?? entry.startedAtMs ?? this.index.cached<TurnState>(turnKey(turnId))?.time ?? session.updatedAt;
        const completedAtMs = entry.completedAtMs ?? prior?.completedAtMs;
        const presentationContent = item.type === 'userMessage' ? this.options.userContent?.(turnId, item) : this.options.toolContent?.(turnId, item);
        const state: ItemState = { turnId, item, time, completed: completed || prior?.completed === true,
            ...(completedAtMs == null ? {} : { completedAtMs }),
            ...(presentationContent === undefined ? {} : { presentationContent }) };
        if (prior && JSON.stringify(prior) === JSON.stringify(state)) return;
        const { turn, start: turnStart } = this.ensureTurn(turnId, time);
        const identity = `codex:${[session.nativeId, turnId, item.id].map(encodeURIComponent).join(':')}`;
        if (item.type === 'userMessage') {
            const content = presentationContent ?? nativeUserContent(item);
            const message = freezeMessage({ id: MessageId(identity), role: 'user', content,
                source: { kind: 'user', ...(typeof item.clientId === 'string' ? { rpcId: item.clientId } : {}) } });
            this.index.put(key(nativeKey, 'message'), this.event('user/message', message, time), [turnStart], position(1));
        } else {
            const step = this.index.coordinate('step', turnId, item.id, ordinal);
            const stepStart = key(nativeKey, 'step/start');
            if (this.index.sequence(stepStart) === undefined) this.index.put(stepStart, this.event('step/start', { turn, step }, time), [turnStart], position(0));
            const dependencies = [turnStart, stepStart];
            const message = (content: ContentBlock[]) => freezeMessage({ id: MessageId(identity), role: 'assistant', content,
                source: { kind: 'model', provider: 'codex', model: 'native' } });
            const putMessage = (content: ContentBlock[]): void => {
                this.index.put(key(nativeKey, 'message'), this.event('assistant/message', { turn, step, message: message(content), stream: [] }, time), dependencies, position(1));
            };
            const nativeTool = nativeToolPresentation(item, presentationContent);
            const tool = nativeTool && (this.options.toolPresentation?.(turnId, item, nativeTool) ?? nativeTool);
            if (item.type === 'agentMessage' || item.type === 'plan') putMessage([{ type: 'text', text: item.type === 'plan'
                ? `<proposed_plan>\n${nativeText(item.text)}\n</proposed_plan>` : nativeText(item.text) }]);
            else if (item.type === 'reasoning') {
                const summary = Array.isArray(item.summary) ? item.summary.filter((v): v is string => typeof v === 'string') : [];
                const body = Array.isArray(item.content) ? item.content.filter((v): v is string => typeof v === 'string') : [];
                putMessage([{ type: 'reasoning', text: (summary.length ? summary : body).join('\n\n') }]);
            } else if (tool) {
                const callId = ToolCallId(identity), { name } = tool;
                const argumentsText = JSON.stringify(tool.input);
                putMessage([{ type: 'tool-call', id: callId, name, arguments: argumentsText },
                    // Generated output is answer material, independently visible from folded process rows.
                    ...(item.type === 'imageView' ? [] : presentationContent?.filter(block => block.type === 'image') ?? [])]);
                const callKey = key(nativeKey, 'tool/call');
                this.index.put(callKey, this.event('tool/call', { turn, step, callId, name, arguments: argumentsText }, time), [...dependencies, key(nativeKey, 'message')], position(2));
                if (state.completed) {
                    this.index.put(key(nativeKey, 'tool/result'), this.event('tool/result', { turn, step, message: freezeMessage({
                        id: MessageId(`${identity}:result`), role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId,
                        content: tool.content,
                        ...(tool.isError ? { isError: true } : {}),
                    }), ...(item.type === 'imageView' && typeof item.path === 'string' ? { meta: { path: item.path } } : {}) }, time), [...dependencies, key(nativeKey, 'message'), callKey], position(3));
                }
            } else {
                // Unknown native capabilities remain visible and do not masquerade as an executable DSH tool.
                putMessage(nativeOtherContent(item));
            }
            if (state.completed) this.index.put(key(nativeKey, 'step/end'), this.event('step/end', { turn, step }, state.completedAtMs ?? time), dependencies, position(4));
        }
        this.index.cache(nativeKey, state);
    }
}
