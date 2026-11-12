/** Durable translations for exact native sources; no Agent or transcript is manufactured. */
import { DatabaseSync } from 'node:sqlite'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import { SessionSeq, type SessionId } from '@deepseek-ai/dsh-session'
import type { RemoteAccessService } from '@deepseek-ai/dsh-api-remote-access'
import { principalOf } from '@deepseek-ai/dsh-typert-protocol'
import type { TranslationIdentity, TranslationRequestRecord, TranslationLog, TranslationStorageOwner } from '@deepseek-ai/dsh-experimental-translator'
import type { SourceGateway, SourceAccess } from '../remote/gateway.ts'
import { isSourceSessionId } from '../remote/protocol.ts'
import { sourceStorageScope } from '../remote/service.ts'

const identityKey = (value: TranslationIdentity): string => JSON.stringify([
    value.provider, value.text, value.sourceLanguage, value.targetLanguage, value.recipe,
])

/** The existing translator owns dispatch; this small sidecar only owns its request/result records. */
export class SourceTranslationStorage {
    private readonly db: DatabaseSync
    private readonly pending = new Map<string, Promise<void>>()
    private closed = false

    constructor(path: string) {
        if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
        this.db = new DatabaseSync(path)
        if (path !== ':memory:') chmodSync(path, 0o600)
        this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
            CREATE TABLE IF NOT EXISTS translations (request_id INTEGER PRIMARY KEY AUTOINCREMENT,
                scope TEXT NOT NULL, session_id TEXT NOT NULL, identity TEXT NOT NULL,
                request TEXT NOT NULL, result TEXT);
            CREATE INDEX IF NOT EXISTS translation_lookup ON translations(scope, session_id, identity);`)
    }

    owner(scope: string, sessionId: string, authorize: (signal: AbortSignal) => Promise<void>): TranslationStorageOwner {
        return { run: (identity, signal, operation) => this.run(scope, sessionId, identity, signal, authorize, operation) }
    }

    private async run(scope: string, sessionId: string, identity: TranslationIdentity, signal: AbortSignal,
        authorize: (signal: AbortSignal) => Promise<void>, operation: (log: TranslationLog) => Promise<string>): Promise<string> {
        const identityText = identityKey(identity), key = JSON.stringify([scope, sessionId, identityText])
        const current = async (): Promise<void> => {
            signal.throwIfAborted()
            if (this.closed) throw new Error('Translation storage is closed')
            await authorize(signal)
            signal.throwIfAborted()
            if (this.closed) throw new Error('Translation storage is closed')
        }
        const task = (this.pending.get(key) ?? Promise.resolve()).then(async () => {
            await current()
            const cached = this.db.prepare('SELECT result FROM translations WHERE scope=? AND session_id=? AND identity=? AND result IS NOT NULL ORDER BY request_id DESC LIMIT 1')
                .get(scope, sessionId, identityText)
            if (cached) return String(cached.result)
            const log: TranslationLog = {
                assertCurrent: current,
                request: async (record: TranslationRequestRecord) => {
                    await current()
                    if (identityKey(record) !== identityText) throw new Error('Translation request changed its admitted identity')
                    const result = this.db.prepare('INSERT INTO translations(scope,session_id,identity,request) VALUES (?,?,?,?)')
                        .run(scope, sessionId, identityText, JSON.stringify(record))
                    const seq = Number(result.lastInsertRowid)
                    if (!Number.isSafeInteger(seq)) throw new Error('Translation request sequence is unavailable')
                    return SessionSeq(seq)
                },
                result: async (requestSeq, text) => {
                    await current()
                    const result = this.db.prepare('UPDATE translations SET result=? WHERE request_id=? AND scope=? AND session_id=? AND identity=? AND result IS NULL')
                        .run(text, requestSeq, scope, sessionId, identityText)
                    if (result.changes !== 1) throw new Error('Translation result does not belong to this admitted request')
                },
            }
            const translated = await operation(log)
            await current()
            return translated
        })
        const settled = task.then(() => {}, () => {})
        this.pending.set(key, settled)
        void settled.then(() => { if (this.pending.get(key) === settled) this.pending.delete(key) })
        return task
    }

    async close(): Promise<void> {
        this.closed = true
        await Promise.all(this.pending.values())
        this.db.close()
    }
}

/** Register only HHPI IDs; an unknown, denied or removed source rejects before original DSH activation. */
export function installSourceTranslation(ctx: Context, gateway: SourceGateway, path: string): Fiber {
    return ctx.inject(['translator', 'remoteAccess'], owner => {
        const storage = new SourceTranslationStorage(path)
        owner.effect(() => () => storage.close(), 'hhpi: durable source translations')
        owner.translator.registerStorageProvider(async (id: SessionId, caller: Context, signal: AbortSignal) => {
            if (!isSourceSessionId(id)) return undefined
            const invocation = caller.invocation
            if (!invocation) throw new Error('Source translation requires an authenticated invocation')
            const access = caller.remoteAccess as unknown as RemoteAccessService
            const sourceAccess: SourceAccess = resource => access.allows(resource.kind === 'source'
                ? { kind: 'hhpiSource', id: resource.id } : { kind: 'session', id: resource.id as SessionId })
            const authorize = async (operationSignal: AbortSignal): Promise<void> => {
                operationSignal.throwIfAborted()
                const source = await gateway.resolve(id, sourceAccess, operationSignal)
                if (source.id !== id) throw new Error('The translation source identity changed')
            }
            await authorize(signal)
            return storage.owner(sourceStorageScope(path, principalOf(invocation)), id, authorize)
        })
    })
}
