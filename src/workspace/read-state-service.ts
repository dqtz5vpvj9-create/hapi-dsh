/** Account/source read watermarks. SQLite serializes CAS and idempotent user intents. */
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { appAccountScopeSchema, appReadStateSchema, appServiceInputs, appSourceKey,
    type AppReadPosition, type AppReadState, type AppServiceContext, type AppServiceRequest, type AppServiceResponse,
    type AppSourceRoute } from './app-service-types.ts';

/** Source coordinates are monotone only within the same original event generation. */
export function compareReadPositions(left: AppReadPosition, right: AppReadPosition): number | undefined {
    if (left.kind !== right.kind || left.kind === 'hhpi' && (right.kind !== 'hhpi' || left.epoch !== right.epoch)) return;
    return Math.sign(left.seq - right.seq);
}

export class ReadStateService {
    private readonly db: DatabaseSync;
    constructor(options: { path: string }) {
        if (options.path !== ':memory:') mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });
        this.db = new DatabaseSync(options.path);
        if (options.path !== ':memory:') chmodSync(options.path, 0o600);
        this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
            CREATE TABLE IF NOT EXISTS app_read_states (source_key TEXT PRIMARY KEY, payload TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS app_read_operations (source_key TEXT NOT NULL, operation_id TEXT NOT NULL,
                intent TEXT NOT NULL, PRIMARY KEY(source_key,operation_id));`);
    }
    private read(context: AppServiceContext, source: AppSourceRoute): AppReadState | null {
        const key = appSourceKey(context.scope, source), row = this.db.prepare('SELECT payload FROM app_read_states WHERE source_key=?').get(key);
        return row ? appReadStateSchema.parse(JSON.parse(String(row.payload))) : null;
    }
    private empty(context: AppServiceContext, source: AppSourceRoute): AppReadState {
        return { scope: appAccountScopeSchema.parse(context.scope), source, revision: 0, seen: null, manualUnreadAt: null, lastOperationId: null };
    }
    async appReadState(context: AppServiceContext, value: AppServiceRequest<'appReadState'>): Promise<AppServiceResponse<'appReadState'>> {
        const { source } = appServiceInputs.appReadState.parse(value);
        appAccountScopeSchema.parse(context.scope); await context.authorizeSource(source);
        return this.read(context, source);
    }
    async appReadStates(context: AppServiceContext, value: AppServiceRequest<'appReadStates'>): Promise<AppServiceResponse<'appReadStates'>> {
        const { sources } = appServiceInputs.appReadStates.parse(value);
        appAccountScopeSchema.parse(context.scope);
        // Authorize the complete admitted batch before returning any source record.
        for (const source of sources) await context.authorizeSource(source);
        return sources.map(source => this.read(context, source));
    }
    async appReadStateWrite(context: AppServiceContext, value: AppServiceRequest<'appReadStateWrite'>): Promise<AppServiceResponse<'appReadStateWrite'>> {
        const request = appServiceInputs.appReadStateWrite.parse(value);
        const scope = appAccountScopeSchema.parse(context.scope);
        await context.authorizeSource(request.source);
        const key = appSourceKey(scope, request.source), intent = JSON.stringify({ deviceId: request.deviceId, intent: request.intent });
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const state = this.read(context, request.source) ?? this.empty(context, request.source);
            const operation = this.db.prepare('SELECT intent FROM app_read_operations WHERE source_key=? AND operation_id=?').get(key, request.operationId);
            if (operation) {
                if (operation.intent !== intent) throw new Error('The read operation identity already belongs to another intent');
                this.db.exec('COMMIT'); return { applied: true, state };
            }
            if (state.revision !== request.expectedRevision) { this.db.exec('COMMIT'); return { applied: false, state }; }
            let seen = state.seen, manualUnreadAt = state.manualUnreadAt;
            if (request.intent.kind === 'unread') manualUnreadAt = request.intent.at;
            else if (!seen || compareReadPositions(request.intent.position, seen.position) !== -1) {
                const sameGeneration = seen && compareReadPositions(request.intent.position, seen.position) !== undefined;
                seen = { position: request.intent.position, at: seen && sameGeneration ? Math.max(seen.at, request.intent.at) : request.intent.at }; manualUnreadAt = null;
            }
            const next: AppReadState = { scope, source: request.source, revision: state.revision + 1, seen, manualUnreadAt, lastOperationId: request.operationId };
            this.db.prepare('INSERT OR REPLACE INTO app_read_states VALUES (?,?)').run(key, JSON.stringify(next));
            this.db.prepare('INSERT INTO app_read_operations VALUES (?,?,?)').run(key, request.operationId, intent);
            this.db.exec('COMMIT'); return { applied: true, state: next };
        } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }
    close(): void { this.db.close(); }
}
