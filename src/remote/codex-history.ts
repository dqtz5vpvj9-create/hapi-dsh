/** Normalize native items once, at their source. Paging only reads SourceEventIndex. */
import { freezeMessage, MessageId, ToolCallId, type ContentBlock } from '@deepseek-ai/dsh-llm';
import type { SessionEventMap, SessionEventType, TurnEndReason } from '@deepseek-ai/dsh-session';
import { SourceEventIndex, type EventInput } from './event-index.ts';
import { isRecord, nativeText, type NativeItem, type NativeItemEntry, type NativeTurn } from './codex-native.ts';
import type { SourceSession } from './protocol.ts';

interface ItemState { item: NativeItem; turnId: string; time: number; completed: boolean }
interface TurnState { turn: NativeTurn; time: number }
const key = (...parts: string[]): string => JSON.stringify(parts);
const turnKey = (id: string): string => key('turn', id);
const itemKey = (turn: string, id: string): string => key('item', turn, id);

/** DSH compatibility has lifecycle coupling; all lifecycle IDs live only here. */
export class CodexHistory {
    constructor(readonly index: SourceEventIndex) {}
    hasTurn(id: string): boolean { return this.index.cached(turnKey(id)) !== undefined; }
    turnState(id: string): NativeTurn | undefined { return this.index.cached<TurnState>(turnKey(id))?.turn; }
    itemState(turnId: string, itemId: string): ItemState | undefined { return this.index.cached<ItemState>(itemKey(turnId, itemId)); }
    private event<T extends SessionEventType>(type: T, data: SessionEventMap[T], time: number): EventInput {
        return { type, data, time, ...(['user/message', 'assistant/message', 'tool/result'].includes(type) ? { surfaceOp: 'append' as const } : {}) } as EventInput;
    }
    private ensureTurn(turnId: string, time: number): { turn: number; start: string } {
        const turn = this.index.coordinate('turn', '', turnId), start = key('turn', turnId, 'start');
        if (this.index.sequence(start) === undefined) this.index.put(start, this.event('turn/start', { turn }, time));
        return { turn, start };
    }
    beginTurn(session: SourceSession, turn: NativeTurn): void {
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
        this.index.edit(session, () => {
            const previous = this.index.cached<TurnState>(turnKey(turn.id));
            const time = previous?.time ?? (turn.startedAt == null ? session.updatedAt : turn.startedAt * 1000);
            this.ensureTurn(turn.id, time);
            this.index.cache(turnKey(turn.id), { turn, time } satisfies TurnState);
            if (includeItems) for (const item of turn.items ?? []) this.acceptItemInEdit(session, { turnId: turn.id, item }, turn.status !== 'inProgress');
            if (turn.status !== 'inProgress') {
                const numericTurn = this.index.coordinate('turn', '', turn.id);
                const reason: TurnEndReason = turn.status === 'completed' ? { kind: 'completed' }
                    : turn.status === 'interrupted' ? { kind: 'aborted', reason: { kind: 'user' } }
                        : { kind: 'error', error: { code: 'CODEX_NATIVE_TURN_FAILED', message: isRecord(turn.error) ? nativeText(turn.error.message) || 'The source turn failed.' : 'The source turn failed.' } };
                this.index.put(key('turn', turn.id, 'end'), this.event('turn/end', { turn: numericTurn, reason }, turn.completedAt == null ? time : turn.completedAt * 1000), [key('turn', turn.id, 'start')]);
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
        const prior = this.index.cached<ItemState>(nativeKey);
        // A replayed started event cannot downgrade an already completed item.
        if (prior?.completed && !completed) return;
        const time = prior?.time ?? entry.startedAtMs ?? this.index.cached<TurnState>(turnKey(turnId))?.time ?? session.updatedAt;
        const state: ItemState = { turnId, item, time, completed: completed || prior?.completed === true };
        if (prior && JSON.stringify(prior) === JSON.stringify(state)) return;
        const { turn, start: turnStart } = this.ensureTurn(turnId, time);
        const identity = `codex:${[session.nativeId, turnId, item.id].map(encodeURIComponent).join(':')}`;
        if (item.type === 'userMessage') {
            const content: ContentBlock[] = [];
            for (const value of Array.isArray(item.content) ? item.content : []) {
                if (!isRecord(value)) continue;
                if (value.type === 'text' && typeof value.text === 'string') content.push({ type: 'text', text: value.text });
                else if (value.type === 'image' || value.type === 'localImage') content.push({ type: 'text', text: '[Native image attachment — open through source resource access]' });
                else if (value.type === 'audio' || value.type === 'localAudio') content.push({ type: 'text', text: '[Native audio attachment — open through source resource access]' });
                else if (value.type === 'skill' || value.type === 'mention') content.push({ type: 'text', text: nativeText(value.name) || `[${String(value.type)}]` });
            }
            const message = freezeMessage({ id: MessageId(identity), role: 'user', content,
                source: { kind: 'user', ...(typeof item.clientId === 'string' ? { rpcId: item.clientId } : {}) } });
            this.index.put(key(nativeKey, 'message'), this.event('user/message', message, time), [turnStart]);
        } else {
            const step = this.index.coordinate('step', turnId, item.id);
            const stepStart = key(nativeKey, 'step/start');
            if (this.index.sequence(stepStart) === undefined) this.index.put(stepStart, this.event('step/start', { turn, step }, time), [turnStart]);
            const dependencies = [turnStart, stepStart];
            const message = (content: ContentBlock[]) => freezeMessage({ id: MessageId(identity), role: 'assistant', content,
                source: { kind: 'model', provider: 'codex', model: 'native' } });
            const putMessage = (content: ContentBlock[]): void => {
                this.index.put(key(nativeKey, 'message'), this.event('assistant/message', { turn, step, message: message(content), stream: [] }, time), dependencies);
            };
            if (item.type === 'agentMessage' || item.type === 'plan') putMessage([{ type: 'text', text: nativeText(item.text) }]);
            else if (item.type === 'reasoning') {
                const summary = Array.isArray(item.summary) ? item.summary.filter((v): v is string => typeof v === 'string') : [];
                const body = Array.isArray(item.content) ? item.content.filter((v): v is string => typeof v === 'string') : [];
                putMessage([{ type: 'reasoning', text: (summary.length ? summary : body).join('\n\n') }]);
            } else if (['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch', 'imageView', 'imageGeneration', 'collabAgentToolCall'].includes(item.type)) {
                const callId = ToolCallId(identity), name = `codex.${item.type}`;
                const input = item.type === 'commandExecution' ? { command: item.command, cwd: item.cwd }
                    : item.type === 'fileChange' ? { changes: item.changes }
                        : item.type === 'webSearch' ? { query: item.query, action: item.action }
                            : item.type === 'imageView' ? { path: item.path }
                                : { ...(item.server === undefined ? {} : { server: item.server }), ...(item.tool === undefined ? {} : { tool: item.tool }), arguments: item.arguments ?? item.input ?? {} };
                const argumentsText = JSON.stringify(input);
                putMessage([{ type: 'tool-call', id: callId, name, arguments: argumentsText }]);
                const callKey = key(nativeKey, 'tool/call');
                this.index.put(callKey, this.event('tool/call', { turn, step, callId, name, arguments: argumentsText }, time), [...dependencies, key(nativeKey, 'message')]);
                if (state.completed) {
                    const output = item.type === 'commandExecution' ? nativeText(item.aggregatedOutput)
                        : item.type === 'fileChange' ? item.changes ?? [] : item.result ?? item.output ?? item;
                    const isError = item.status === 'failed' || item.status === 'declined' || typeof item.exitCode === 'number' && item.exitCode !== 0;
                    this.index.put(key(nativeKey, 'tool/result'), this.event('tool/result', { turn, step, message: freezeMessage({
                        id: MessageId(`${identity}:result`), role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId,
                        content: [{ type: 'text', text: typeof output === 'string' ? output : JSON.stringify(output, null, 2) }],
                        ...(isError ? { isError: true } : {}),
                    }) }, time), [...dependencies, key(nativeKey, 'message'), callKey]);
                }
            } else {
                // Unknown native capabilities remain visible and do not masquerade as an executable DSH tool.
                putMessage([{ type: 'text', text: nativeText(item.text) || `[Native ${item.type} item: ${item.id}]` }]);
            }
            if (state.completed) this.index.put(key(nativeKey, 'step/end'), this.event('step/end', { turn, step }, entry.completedAtMs ?? time), dependencies);
        }
        this.index.cache(nativeKey, state);
    }
}
