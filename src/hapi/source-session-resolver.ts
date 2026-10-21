import { HapiRequestError, type HapiSession, type HapiTransport } from '../codex/contracts.ts';

export interface OriginalSessionRequest { hubId: string; sourceSessionId: string }
export interface OriginalSessionResolution extends OriginalSessionRequest { sessionId: string }
interface SourceDisplay {
    id: string;
    binding: { hubId: string; hapiSessionId: string };
    sourceSession: HapiSession;
}
interface SourceDisplays {
    attach(sourceId: string): Promise<SourceDisplay | undefined>;
    reconcileSource(sourceId: string): Promise<SourceDisplay | undefined>;
    byHapiSession(sourceId: string): SourceDisplay | undefined;
}

/** Prioritize one original session without waiting for every older history. */
export class SourceSessionResolver {
    private readonly pending = new Map<string, Promise<OriginalSessionResolution>>();
    constructor(
        private readonly transport: Pick<HapiTransport, 'hubId' | 'getSession'>,
        private readonly codex: SourceDisplays,
        private readonly observed: SourceDisplays,
    ) {}

    resolve(request: OriginalSessionRequest): Promise<OriginalSessionResolution> {
        if (!validIdentity(request.hubId) || !validIdentity(request.sourceSessionId)) return Promise.reject(new HapiRequestError('The original Hub and session identity are required.', 'rejected', 400));
        if (request.hubId !== this.transport.hubId) return Promise.reject(new HapiRequestError('This Host is connected to a different original HAPI Hub.', 'rejected', 409, 'source_hub_mismatch'));
        const sourceSessionId = request.sourceSessionId;
        const current = this.pending.get(sourceSessionId);
        if (current) return current;
        const task = this.resolveSource(sourceSessionId);
        this.pending.set(sourceSessionId, task);
        void task.finally(() => { if (this.pending.get(sourceSessionId) === task) this.pending.delete(sourceSessionId); }).catch(() => {});
        return task;
    }

    private async resolveSource(sourceSessionId: string): Promise<OriginalSessionResolution> {
        const source = await this.transport.getSession(sourceSessionId);
        if (source.id !== sourceSessionId) throw new HapiRequestError('The original Hub returned another session for this request.', 'rejected', 409, 'source_identity_mismatch');
        const owner = source.metadata?.codexNativeSession === true ? this.codex : this.observed;
        const display = owner.byHapiSession(sourceSessionId) ? await owner.reconcileSource(sourceSessionId) : await owner.attach(sourceSessionId);
        if (!display) throw new HapiRequestError('The original session exists, but its source identity is not ready to open.', 'rejected', 409, 'source_not_ready');
        if (display.binding.hubId !== this.transport.hubId || display.binding.hapiSessionId !== sourceSessionId || display.sourceSession.id !== sourceSessionId
            || owner.byHapiSession(sourceSessionId) !== display) {
            throw new HapiRequestError('The original session changed while its display was loading. Retry its exact source identity.', 'rejected', 409, 'source_identity_mismatch');
        }
        return { hubId: this.transport.hubId, sourceSessionId, sessionId: display.id };
    }
}

function validIdentity(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value) && value.trim().length > 0;
}
