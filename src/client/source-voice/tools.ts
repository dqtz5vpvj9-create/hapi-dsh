/** Voice tools use the existing Session submission and approval owners. */
import type { Context } from '@deepseek-ai/cordis';
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client';
import { remoteValue, type HapiRemoteApi } from '../../client-api.ts';
import { isObject } from '../../voice/messages.ts';
import { assertVoiceBinding, publicApproval, type VoiceContext } from './context.ts';

export interface VoiceToolRequest { id: string; name: string; args: unknown }
export interface VoiceToolReceipt { id: string; name: string; fingerprint: string; requestId: string | null; status: 'pending' | 'submitted' | 'rejected' | 'indeterminate'; result: string }
export interface VoiceToolOwner {
    current(): void;
    readContext(signal: AbortSignal): Promise<VoiceContext>;
    submit(text: string, signal: AbortSignal, identified: (requestId: string) => void): Promise<void>;
    answer(requestId: string, decision: 'allow' | 'deny'): Promise<void>;
    inspect(requestId: string): 'submitted' | 'rejected' | 'unknown';
}
function stable(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
    if (isObject(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
    return JSON.stringify(value) ?? 'null';
}
function description(error: unknown): string { return error instanceof Error ? error.message : isObject(error) && typeof error.message === 'string' ? error.message : 'The source did not confirm this request'; }
function knownRejection(error: unknown): boolean { return isObject(error) && isObject(error.details) && error.details.outcome === 'rejected'; }

/** Real Gemini/Qwen call IDs cache the original result; ElevenLabs invokes with a fresh ID per callback. */
export class VoiceToolDispatcher {
    private readonly entries = new Map<string, VoiceToolReceipt>();
    private readonly flights = new Map<string, Promise<string>>();
    private serial: Promise<unknown> = Promise.resolve();
    private closed = false;
    private advertised: VoiceContext | null = null;
    constructor(private readonly owner: VoiceToolOwner, private readonly signal: AbortSignal, private readonly changed: () => void = () => {}) {}
    receipts(): VoiceToolReceipt[] { return [...this.entries.values()].map(entry => ({ ...entry })); }
    advertise(context: VoiceContext): void { this.advertised = context; }
    reconcile(): void { for (const entry of this.entries.values()) if (entry.status === 'indeterminate') this.inspect(entry); }
    dispose(): void { this.closed = true; }
    call(input: VoiceToolRequest): Promise<string> {
        if (!input.id || input.id.length > 1024 || !['messageCodingAgent', 'processPermissionRequest'].includes(input.name)) return Promise.resolve('error (Unknown voice tool or missing tool identity)');
        let fingerprint: string;
        try { fingerprint = `${input.name}:${stable(input.args)}`; } catch { return Promise.resolve('error (Invalid voice tool arguments)'); }
        if (fingerprint.length > 32_768) return Promise.resolve('error (Voice tool arguments are too large)');
        const previous = this.entries.get(input.id);
        if (previous) return previous.fingerprint === fingerprint ? this.flights.get(input.id) ?? Promise.resolve(this.inspect(previous)) : Promise.resolve('error (This voice tool ID already belongs to different arguments)');
        if (this.entries.size >= 1024) return Promise.resolve('error (This voice session reached its tool request limit; end the call before starting another)');
        const entry: VoiceToolReceipt = { id: input.id, name: input.name, fingerprint, requestId: null, status: 'pending', result: '' };
        this.entries.set(input.id, entry); this.changed();
        const task = this.serial.then(async () => {
            let dispatched = false;
            try {
                if (this.closed) throw new Error('The voice session has ended'); this.signal.throwIfAborted(); this.owner.current();
                for (const other of this.entries.values()) if (other !== entry && other.fingerprint === fingerprint && other.status === 'indeterminate') {
                    this.inspect(other); if (other.status === 'indeterminate') throw new Error(`The original request ${other.requestId ?? other.id} is still unconfirmed. Read its source receipt; it will not be sent again automatically.`);
                }
                const args = input.args;
                if (!isObject(args)) throw new Error('Voice tool arguments must be an object');
                if (input.name === 'messageCodingAgent') {
                    if (typeof args.message !== 'string' || !args.message.trim() || args.message.length > 16_384) throw new Error('Provide one nonempty coding request up to 16,384 characters');
                    await this.owner.submit(args.message.trim(), this.signal, requestId => { entry.requestId = requestId; dispatched = true; });
                    entry.status = 'submitted'; entry.result = `Submitted to the original conversation queue (request ${entry.requestId}). This is admission, not task completion. Wait for the coding agent; do not repeat the request.`;
                } else {
                    if (args.decision !== 'allow' && args.decision !== 'deny') throw new Error('The decision must be exactly allow or deny');
                    const expected = this.advertised?.approvals;
                    if (expected?.length !== 1 || !expected[0]!.answerable) throw new Error('Choose the exact pending request in the original conversation. Voice cannot guess among requests or answer structured questions.');
                    const context = await this.owner.readContext(this.signal); this.owner.current(); this.signal.throwIfAborted();
                    if (context.approvals.length !== 1 || !context.approvals[0]!.answerable || context.approvals[0]!.id !== expected[0]!.id) throw new Error('The pending approval changed after the voice context was sent. Review the current request in the conversation.');
                    entry.requestId = context.approvals[0]!.id; dispatched = true;
                    await this.owner.answer(entry.requestId, args.decision); entry.status = 'submitted';
                    entry.result = `The ${args.decision} response was submitted for request ${entry.requestId}. The original source still owns final resolution.`;
                }
            } catch (error) {
                entry.status = dispatched && !knownRejection(error) ? 'indeterminate' : 'rejected';
                entry.result = `error (${description(error)}${entry.status === 'indeterminate' ? `; request ${entry.requestId ?? entry.id} has an unknown outcome and was not retried` : ''})`;
            }
            this.changed(); return entry.result;
        });
        this.serial = task.catch(() => {}); this.flights.set(input.id, task); void task.then(() => this.flights.delete(input.id), () => this.flights.delete(input.id)); return task;
    }
    private inspect(entry: VoiceToolReceipt): string {
        if (entry.status === 'indeterminate' && entry.requestId) {
            const state = this.owner.inspect(entry.requestId);
            if (state !== 'unknown') { entry.status = state; entry.result = `The original source now shows request ${entry.requestId} as ${state}. No duplicate request was sent.`; this.changed(); }
        }
        return entry.result;
    }
}

export function voiceToolOwner(ctx: Context, api: Pick<HapiRemoteApi, 'nativeAnswer'>, binding: SessionBinding, source: boolean,
    readContext: (signal: AbortSignal) => Promise<VoiceContext>): VoiceToolOwner {
    const current = () => assertVoiceBinding(ctx, binding);
    return { current, readContext,
        async submit(text, signal, identified) {
            current(); signal.throwIfAborted();
            const submission = binding.session.beginSubmission({ mode: 'queue', text, attachments: [] });
            identified(submission.requestId);
            // Original Session owns optimistic echo, durable request identity,
            // and admission. This never edits or submits another draft.
            remoteValue(await binding.session.prompt([{ type: 'text', text }], 'queue', signal, submission.requestId));
        },
        async answer(requestId, decision) {
            current();
            if (source) { remoteValue(await api.nativeAnswer({ sessionId: binding.sessionId, requestId, answer: { decision: decision === 'allow' ? 'approved' : 'denied' }, ...(decision === 'deny' ? { deny: true } : {}) })); return; }
            const pending = publicApproval(ctx, binding.sessionId);
            if (!pending || pending.key !== requestId || !pending.answerable) throw new Error('The original approval request has changed');
            await pending.answer(decision === 'allow' ? 'allowed-once' : 'rejected');
        },
        inspect(requestId) {
            if (ctx.sessions.binding(binding.sessionId) !== binding) return 'unknown';
            for (const name of ['hapi', 'hapiObserved']) {
                const projection = binding.session.projections.faceOf(name).getSnapshot();
                if (!isObject(projection)) continue;
                const delivery = Array.isArray(projection.delivery) ? projection.delivery.find(row => isObject(row) && row.localId === `dsh:${requestId}`) : undefined;
                if (isObject(delivery)) {
                    if (['accepted', 'queued', 'invoked'].includes(String(delivery.state))) return 'submitted';
                    if (['rejected', 'cancelled'].includes(String(delivery.state))) return 'rejected';
                }
                if (Array.isArray(projection.resolvedRequests) && projection.resolvedRequests.some(row => isObject(row) && row.requestId === requestId)) return 'submitted';
            }
            for (const entry of binding.eventSource.getSnapshot().entries) {
                if (entry.type !== 'event' || entry.event.type !== 'user/message') continue;
                const source = entry.event.data.source;
                if (source?.kind === 'user' && 'rpcId' in source && source.rpcId === requestId) return 'submitted';
            }
            return 'unknown';
        },
    };
}
