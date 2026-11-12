/** Account-scoped source references. A share ID never grants source access. */
import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { appAccountScopeSchema, appShareRecordSchema, appScopeKey, appServiceInputs, authorizeAppRecord,
    type AppServiceContext, type AppServiceRequest, type AppServiceResponse } from './app-service-types.ts'

export class ShareService {
    private readonly db: DatabaseSync
    private readonly now: () => number
    private readonly ttlMs: number
    constructor(options: { path: string; now?: () => number; ttlMs?: number }) {
        this.now = options.now ?? Date.now; this.ttlMs = options.ttlMs ?? 30 * 24 * 60 * 60_000
        if (options.path !== ':memory:') mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 })
        this.db = new DatabaseSync(options.path)
        if (options.path !== ':memory:') chmodSync(options.path, 0o600)
        this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
            CREATE TABLE IF NOT EXISTS app_shares (scope TEXT NOT NULL, id TEXT NOT NULL, created_at INTEGER NOT NULL,
                payload TEXT NOT NULL, PRIMARY KEY(scope,id));`)
    }
    async appShareCreate(context: AppServiceContext, value: AppServiceRequest<'appShareCreate'>): Promise<AppServiceResponse<'appShareCreate'>> {
        const request = appServiceInputs.appShareCreate.parse(value), scope = appAccountScopeSchema.parse(context.scope)
        await context.authorizeSource(request.target.source)
        const record = appShareRecordSchema.parse({ id: randomUUID(), scope, target: request.target, visibility: 'account', createdAt: this.now() })
        this.db.prepare('DELETE FROM app_shares WHERE created_at<?').run(this.now() - this.ttlMs)
        this.db.prepare('INSERT INTO app_shares VALUES (?,?,?,?)').run(appScopeKey(scope), record.id, record.createdAt, JSON.stringify(record))
        return record
    }
    async appShareResolve(context: AppServiceContext, value: AppServiceRequest<'appShareResolve'>): Promise<AppServiceResponse<'appShareResolve'>> {
        const { shareId } = appServiceInputs.appShareResolve.parse(value), scope = appAccountScopeSchema.parse(context.scope)
        const row = this.db.prepare('SELECT payload FROM app_shares WHERE scope=? AND id=?').get(appScopeKey(scope), shareId)
        if (!row) throw new Error('This share is unavailable for the authenticated account and application origin')
        const record = appShareRecordSchema.parse(JSON.parse(String(row.payload)))
        if (this.now() - record.createdAt >= this.ttlMs) throw new Error('This source share has expired')
        return authorizeAppRecord(context, record)
    }
    close(): void { this.db.close() }
}
