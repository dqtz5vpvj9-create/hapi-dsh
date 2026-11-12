/** X1 writes recovery data only. Nothing here imports an execution owner or dispatches an operation. */
import { z } from 'zod'
import { zstdDecompressSync } from 'node:zlib'
import { isDeepStrictEqual } from 'node:util'
import type { OfflineStage } from './index.ts'
import { ExactIdentityIndex, hubSessionNativeIdentity, type ExactIdentityMatch, type ExactTarget, type NativeLocator, type RecoveryObjectIndex } from './common.ts'
import { domainObject, domainReport, isRecord, jsonInput, originalKey } from './domain.ts'
import { appAccountScopeSchema, type AppAccountScope, type AppSourceRoute } from '../../../src/workspace/app-service-types.ts'
import { legacySourceReferenceSchema, sourceAliasDocumentSchema, type LegacySourceReference, type SourceAliasDocument } from '../../../src/workspace/source-aliases.ts'
import { parseSourceSessionId } from '../../../src/remote/protocol.ts'

const id = z.string().min(1), time = z.number().finite().nonnegative()
const identitySchema = z.strictObject({ machineId: id, engine: id, nativeId: id, sourceId: id.optional() })
const linksSchema = z.strictObject({ version: z.literal(1), records: z.array(z.strictObject({ legacy: legacySourceReferenceSchema, identity: identitySchema.nullable() })) })
const browserSchema = z.strictObject({ version: z.literal(1), entries: z.array(z.strictObject({ key: id, value: z.string().nullable() })) })
// The explicit Settings download retains its original origin and browser databases.
// Database Blobs/conflict baselines belong to X2; they are not composer inputs.
const browserDownloadSchema = z.object({ version: z.literal(1), origin: id, createdAt: time,
    localStorage: z.array(z.object({ key: id, value: z.string() })), databases: z.array(z.unknown()) })
const ledgerRecord = z.strictObject({ key: id, terminal: z.literal(true).optional(), value: z.string().optional() })
const ledgerSchema = z.strictObject({ version: z.literal(1), database: z.literal('hhpi-operations-v1'), store: z.literal('operations'), records: z.array(ledgerRecord) })
const inventorySchema = z.object({ sourceId: id, machineId: id, rows: z.array(z.object({ machineId: id, nativeId: id, ownerSession: id,
    active: z.boolean(), thinking: z.boolean(), execution: z.unknown(), requests: z.array(z.unknown()) })) })
const receiptSchema = z.object({ sessionId: id, operationId: id, status: z.enum(['accepted', 'rejected', 'indeterminate']), message: z.string(),
    observed: z.object({ epoch: id, seq: z.number().int().nonnegative() }).optional(),
    ownerAdmission: z.object({ localId: id, state: z.enum(['queued', 'dispatching', 'indeterminate', 'consumed']) }).optional() })
const operation = z.object({ sessionId: id, operationId: id, kind: z.enum(['send', 'steer', 'cancel', 'approve']) })
const deliverySchema = z.object({ version: z.literal(1), operation, createdAt: time, attempts: z.number().int().nonnegative(),
    state: z.enum(['queued', 'sending', 'confirming', 'accepted', 'rejected', 'owner-accepted']), receipt: receiptSchema.optional() })
const nativeActionSchema = z.object({ version: z.literal(1), sessionId: id, intent: id, kind: id,
    request: z.object({ sourceId: id, operationId: id, method: id, params: z.record(z.string(), z.unknown()).nullable() }),
    phase: z.enum(['prepared', 'dispatching', 'confirming', 'accepted', 'rejected']), createdAt: time, updatedAt: time,
    outcome: z.object({ status: z.enum(['accepted', 'rejected', 'indeterminate']), message: z.string() }).optional() })

type HubInput = { hubId: string; namespace?: string }
export type SessionMigrationInput =
    | ({ inputId: string; kind: 'hub-sessions' } & HubInput)
    | { inputId: string; kind: 'hub-backup'; hubId: string; userVersion: number }
    | ({ inputId: string; kind: 'dsh-owner-inventory' } & HubInput)
    | { inputId: string; kind: 'recorded-links' }
    | { inputId: string; kind: 'browser-storage' | 'operation-ledger'; hostId: string; storageScope: string }
export interface SessionMigrationOptions { scope: AppAccountScope; targets: readonly ExactTarget[] }
export const SESSION_ALIASES_OBJECT_ID = originalKey('aliases', 'sessions')
export const SESSION_HANDOFF_OBJECT_ID = originalKey('owner-handoff', 'sessions')

function parsedJson(value: unknown): unknown { if (typeof value !== 'string') return value; try { return JSON.parse(value) } catch { return undefined } }
function legacySession(input: HubInput, row: Record<string, unknown>): LegacySourceReference | null {
    const namespace = typeof row.namespace === 'string' ? row.namespace : input.namespace
    if (input.namespace !== undefined && namespace !== input.namespace) return null
    return typeof row.id === 'string' && row.id ? { kind: 'hapi-session', hubId: input.hubId, sessionId: row.id,
        ...(namespace === undefined ? {} : { namespace }) } : null
}
const legacyKey = (value: LegacySourceReference) => value.kind === 'hapi-session'
    ? originalKey(value.kind, value.hubId, value.namespace ?? null, value.sessionId) : originalKey(value.kind, value.hostId, value.displayId)
const routeKey = (value: AppSourceRoute) => originalKey(value.kind, value.hostId, value.sessionId)
function decodeContent(value: unknown): unknown {
    // Frozen HAPI contentCodec contract: TEXT is JSON, BLOB is zstd(JSON). Original bytes stay in the backup.
    if (value instanceof Uint8Array) { try { return JSON.parse(zstdDecompressSync(value).toString('utf8')) } catch { return undefined } }
    return parsedJson(value)
}
function jsonRow(row: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value instanceof Uint8Array ? { encoding: 'base64', content: Buffer.from(value).toString('base64') } : value]))
}

/** Explicit input roles and target candidates are persisted by L1; changing them requires another recovery package. */
export function createSessionsStage(inputs: readonly SessionMigrationInput[], options: SessionMigrationOptions): OfflineStage {
    if (!inputs.length) throw new Error('Select at least one explicit session migration input.')
    const scope = appAccountScopeSchema.parse(options.scope)
    if (options.targets.some(value => value.identity.engine === 'dsh' && value.target.kind === 'hhpi')) {
        throw new Error('Native DSH must migrate to its original official local/federated session, not another HHPI DSH writer.')
    }
    const identities = new ExactIdentityIndex(options.targets)
    return { id: 'sessions', version: '1', configuration: { inputs, scope, targets: options.targets }, async run({ snapshot, recovery }) {
        const outputs: RecoveryObjectIndex[] = [], blockers: string[] = [], entries: SourceAliasDocument['entries'] = []
        const owners: unknown[] = [], sources = new Map<string, AppSourceRoute[]>()
        const ledgers = new Map<string, Array<z.infer<typeof ledgerRecord>>>()
        const put = async (inputId: string, key: string, original: unknown, converted: unknown, target?: AppSourceRoute, unresolved = false, reason?: string) => {
            const row = await domainObject(recovery, 'sessions', { key, inputId, original, converted, disposition: unresolved ? 'offline-recovery' : 'migrate',
                ...(target ? { target } : {}), unresolved, ...(reason ? { reason } : {}) }); outputs.push(row); return row
        }
        const unknown = (inputId: string, original: unknown, reason: string, key = originalKey(inputId, 'unsupported')) => put(inputId, key, original, { automaticDispatch: false }, undefined, true, reason)
        const alias = async (inputId: string, key: string, legacy: LegacySourceReference, identity: NativeLocator | null, original: unknown) => {
            const match = identities.match(identity), candidates = match.status === 'matched' ? [match.target] : match.status === 'ambiguous' ? [...match.candidates] : []
            const target = match.status === 'matched' ? match.target : undefined
            const reason = match.status === 'matched' ? undefined : match.status === 'ambiguous' ? 'Several current routes match this exact native identity. Select the original Host explicitly.' : 'No exact current native route was selected. The original object remains available.'
            const row = await put(inputId, key, original, { version: 1, legacy, identity, match: match.status, candidates,
                oldReadingPosition: 'preserved-without-sequence-translation', newWriterAllowed: false }, target, !target, reason)
            for (const candidate of candidates.length ? candidates : [null]) entries.push({ legacy, target: candidate, recovery: [{ packageId: recovery.request.packageId, family: 'sessions', objectId: row.id }] })
            const previous = sources.get(legacyKey(legacy)) ?? []
            sources.set(legacyKey(legacy), [...new Map([...previous, ...candidates].map(value => [routeKey(value), value])).values()])
            return match
        }
        const forLegacy = (legacy: LegacySourceReference | null) => { const values = legacy ? sources.get(legacyKey(legacy)) ?? [] : []; return values.length === 1 ? values[0] : undefined }
        const fromDisplay = (hostId: string, displayId: string): { legacy: LegacySourceReference; identity: NativeLocator | null; match: ExactIdentityMatch } => {
            let identity: NativeLocator | null = null; try { identity = parseSourceSessionId(displayId) } catch { /* No hash/revision/title inference. */ }
            return { legacy: { kind: 'hapi-display', hostId, displayId }, identity, match: identities.match(identity) }
        }
        const session = async (input: SessionMigrationInput & HubInput, raw: unknown, position: number) => {
            const value = isRecord(raw) ? raw : {}, legacy = legacySession(input, value)
            if (!legacy) { await unknown(input.inputId, raw, 'The original Hub/session/namespace identity is missing or conflicts with the selected namespace.', originalKey(input.inputId, 'session', position)); return }
            const identity = hubSessionNativeIdentity(value)
            await alias(input.inputId, originalKey(input.inputId, legacyKey(legacy)), legacy, identity, raw)
            const agent = parsedJson(value.agent_state ?? value.agentState), requests = isRecord(agent) && isRecord(agent.requests) ? agent.requests : null
            owners.push({ legacy, identity, originalActive: value.active ?? null, pendingRequestIds: requests ? Object.keys(requests) : null,
                ownerState: 'unsettled', oldAdmission: 'unknown', newWriterAllowed: false })
        }
        // Canonical transaction rows are read first, irrespective of input order. A mirror cannot resurrect a tombstone.
        for (const input of inputs.filter((value): value is Extract<SessionMigrationInput, { kind: 'browser-storage' | 'operation-ledger' }> => value.kind === 'operation-ledger')) {
            const raw = await jsonInput(snapshot, input.inputId), parsed = ledgerSchema.safeParse(raw.value)
            if (!parsed.success) { await unknown(input.inputId, raw.value, raw.error ?? 'Unsupported operation ledger export.'); continue }
            for (const [position, record] of parsed.data.records.entries()) {
                const key = parsedJson(record.key)
                if (!Array.isArray(key) || key.length !== 2 || key[0] !== input.storageScope || typeof key[1] !== 'string') {
                    await unknown(input.inputId, record, 'The transactional record is outside the explicitly selected authenticated storage scope.', originalKey(input.inputId, position)); continue
                }
                const tuple = originalKey(input.hostId, input.storageScope, key[1]), previous = ledgers.get(tuple) ?? []
                previous.push(record); ledgers.set(tuple, previous)
            }
        }
        const payload = async (input: Extract<SessionMigrationInput, { kind: 'browser-storage' | 'operation-ledger' }>, key: string, raw: unknown, value: unknown, expectedId?: string) => {
            const delivery = deliverySchema.safeParse(value), action = nativeActionSchema.safeParse(value)
            const sessionId = delivery.success ? delivery.data.operation.sessionId : action.success ? action.data.sessionId : null
            if (!sessionId) { await unknown(input.inputId, raw, 'The complete original operation payload is unavailable or uses an unsupported schema.', key); return }
            const display = fromDisplay(input.hostId, sessionId), match = display.match, target = match.status === 'matched' ? match.target : undefined
            const operationId = delivery.success ? delivery.data.operation.operationId : action.success ? action.data.request.operationId : ''
            if (expectedId !== undefined && expectedId !== (delivery.success ? operationId : originalKey('native-action', sessionId, action.success ? action.data.intent : ''))) {
                await unknown(input.inputId, raw, 'The original transaction/index ID does not match its immutable operation.', key); return
            }
            let state: 'unsent-draft' | 'original-receipt-required' | 'confirmed-history' = 'original-receipt-required'
            let invalid = false, ownerAdmission: unknown = null
            if (delivery.success) {
                const item = delivery.data, receipt = item.receipt
                invalid = !!receipt && (receipt.sessionId !== sessionId || receipt.operationId !== operationId || !!receipt.ownerAdmission && receipt.ownerAdmission.localId !== operationId)
                ownerAdmission = receipt?.ownerAdmission ?? null
                if (receipt && !invalid && (receipt.status === 'rejected' || receipt.status === 'accepted' && (!receipt.ownerAdmission || receipt.observed))) state = 'confirmed-history'
                else if (!receipt && item.state === 'queued' && item.attempts === 0 && ['send', 'steer'].includes(item.operation.kind)) state = 'unsent-draft'
            } else if (action.success) {
                const item = action.data, identity = display.identity
                invalid = !identity || item.request.sourceId !== identity.sourceId || item.request.params?.threadId !== identity.nativeId
                if (!invalid && (item.phase === 'accepted' || item.phase === 'rejected') && item.outcome?.status === item.phase) state = 'confirmed-history'
            }
            if (invalid) { await unknown(input.inputId, raw, 'The saved receipt/native request belongs to another immutable operation or source conversation.', key); return }
            const row = await put(input.inputId, key, raw, { version: 1, operationId, sessionId, state, ownerAdmission,
                automaticDispatch: false, nextAction: state === 'original-receipt-required' ? 'query-original-operation' : state === 'unsent-draft' ? 'explicit-user-review' : 'history-only',
                nativeExecutionCompleted: false }, target, !target || state === 'original-receipt-required', !target ? 'No unique current route exists for this exact original source.' : state === 'original-receipt-required' ? 'Keep the original operation ID and query its original owner; do not resubmit or synthesize another ID.' : undefined)
            entries.push({ legacy: display.legacy, target: target ?? null, recovery: [{ packageId: recovery.request.packageId, family: 'sessions', objectId: row.id }] })
        }
        for (const input of inputs) {
            if (input.kind === 'hub-backup') {
                const data = await snapshot.sqlite(input.inputId, db => {
                    const schema = db.schema(), tables = new Map(schema.tables.map(table => [table.name, new Set(table.columns.map(column => String(column.name)))]))
                    if (schema.userVersion !== input.userVersion || !['id', 'namespace', 'metadata'].every(column => tables.get('sessions')?.has(column))) throw new Error('The selected Hub backup schema/user_version is unsupported.')
                    const check = (table: string, columns: string[]) => { if (tables.has(table) && !columns.every(column => tables.get(table)?.has(column))) throw new Error(`Unsupported selected ${table} schema.`) }
                    check('messages', ['id', 'session_id', 'content', 'local_id', 'invoked_at', 'scheduled_at', 'delivery_state'])
                    check('session_scratchlist', ['session_id', 'entry_id', 'text', 'attachments'])
                    return { sessions: [...db.rows('SELECT * FROM sessions ORDER BY id')], messages: tables.has('messages') ? [...db.rows('SELECT * FROM messages WHERE local_id IS NOT NULL ORDER BY session_id, seq, id')] : [],
                        drafts: tables.has('session_scratchlist') ? [...db.rows('SELECT * FROM session_scratchlist ORDER BY session_id, entry_id')] : [] }
                }).catch(async error => { await unknown(input.inputId, { rawInputId: input.inputId }, error instanceof Error ? error.message : 'The selected Hub backup could not be read.'); return null })
                if (!data) continue
                for (const [position, row] of data.sessions.entries()) await session(input, row, position)
                const byId = new Map(data.sessions.map(row => [String(row.id), row]))
                for (const row of data.messages) {
                    const oldSession = byId.get(String(row.session_id)), legacy = oldSession ? legacySession(input, oldSession) : null
                    const target = forLegacy(legacy), content = decodeContent(row.content), body = isRecord(content) ? content : {}, meta = isRecord(body.meta) ? body.meta : {}
                    const native = body.role === 'user' && meta.sentFrom === 'cli' && meta.isNativeQueuedMessage === true
                    const uncertain = row.delivery_state === 'dispatching' || row.delivery_state === 'indeterminate'
                    const state = uncertain ? 'original-receipt-required' : native ? 'native-queue-reference' : row.invoked_at !== null ? 'dispatch-history' : row.delivery_state === 'queued' && body.role === 'user' ? 'unsent-draft' : 'original-receipt-required'
                    await put(input.inputId, originalKey(input.inputId, 'message', row.session_id as string, row.id as string), jsonRow(row), { version: 1, legacy, localId: row.local_id,
                        state, content: content ?? null, scheduledAt: row.scheduled_at, automaticDispatch: false, nativeExecutionCompleted: false,
                        nextAction: state === 'native-queue-reference' ? 'read-original-native-queue-id' : state === 'original-receipt-required' ? 'query-original-operation' : state === 'unsent-draft' ? 'explicit-user-review' : 'history-only' }, target,
                    !target || content === undefined || state === 'original-receipt-required', !target ? 'The exact original session has no unique native route.' : content === undefined ? 'Original content could not be decoded; its bytes remain in the selected backup.' : state === 'original-receipt-required' ? 'The original dispatch outcome is unknown; never replay it during migration.' : undefined)
                }
                for (const row of data.drafts) {
                    const oldSession = byId.get(String(row.session_id)), legacy = oldSession ? legacySession(input, oldSession) : null, target = forLegacy(legacy)
                    await put(input.inputId, originalKey(input.inputId, 'scratchlist', row.session_id as string, row.entry_id as string), jsonRow(row),
                        { version: 1, legacy, entryId: row.entry_id, state: 'unsent-draft', text: row.text, attachments: parsedJson(row.attachments) ?? null, automaticDispatch: false }, target,
                        !target || row.attachments !== null, row.attachments !== null ? 'Retain original attachment metadata and bytes through the files recovery stage before restoring this draft.' : !target ? 'The original draft has no exact current route.' : undefined)
                }
                continue
            }
            const raw = await jsonInput(snapshot, input.inputId)
            if (input.kind === 'hub-sessions') {
                if (raw.error || !isRecord(raw.value) || raw.value.version !== 1 || !Array.isArray(raw.value.sessions)) { await unknown(input.inputId, raw.value, raw.error ?? 'Expected a version 1 explicit sessions export.'); continue }
                for (const [position, row] of raw.value.sessions.entries()) await session(input, row, position)
            } else if (input.kind === 'recorded-links') {
                const parsed = linksSchema.safeParse(raw.value)
                if (!parsed.success) { await unknown(input.inputId, raw.value, raw.error ?? 'Unsupported explicit original-link export.'); continue }
                for (const [position, row] of parsed.data.records.entries()) await alias(input.inputId, originalKey(input.inputId, position), row.legacy,
                    row.identity ? { machineId: row.identity.machineId, engine: row.identity.engine, nativeId: row.identity.nativeId, ...(row.identity.sourceId === undefined ? {} : { sourceId: row.identity.sourceId }) } : null, row)
            } else if (input.kind === 'dsh-owner-inventory') {
                const parsed = inventorySchema.safeParse(raw.value)
                if (!parsed.success) { await unknown(input.inputId, raw.value, raw.error ?? 'Unsupported exact DSH owner inventory.'); continue }
                for (const [position, row] of parsed.data.rows.entries()) {
                    const identity = { machineId: row.machineId, sourceId: parsed.data.sourceId, engine: 'dsh', nativeId: row.nativeId }
                    const legacy: LegacySourceReference = { kind: 'hapi-session', hubId: input.hubId, sessionId: row.ownerSession, ...(input.namespace ? { namespace: input.namespace } : {}) }
                    if (row.machineId !== parsed.data.machineId) { await unknown(input.inputId, row, 'The observed owner machine conflicts with its selected inventory.', originalKey(input.inputId, position)); continue }
                    await alias(input.inputId, originalKey(input.inputId, legacyKey(legacy)), legacy, identity, row)
                    owners.push({ legacy, identity, originalOwnerSession: row.ownerSession, active: row.active, thinking: row.thinking,
                        execution: row.execution, pendingRequests: row.requests, ownerState: 'unsettled', oldAdmission: 'unknown', newWriterAllowed: false })
                }
            } else if (input.kind === 'operation-ledger') {
                const parsed = ledgerSchema.safeParse(raw.value); if (!parsed.success) continue // The first pass already preserved its failure.
                for (const record of parsed.data.records) {
                    const tuple = parsedJson(record.key)
                    if (!Array.isArray(tuple) || tuple[0] !== input.storageScope || typeof tuple[1] !== 'string' || tuple.length !== 2) continue
                    const key = originalKey(input.inputId, record.key), matches = ledgers.get(originalKey(input.hostId, input.storageScope, tuple[1]))!
                    if (!matches.every(value => isDeepStrictEqual(value, record)) || record.terminal && record.value !== undefined) { await unknown(input.inputId, record, 'Conflicting canonical transaction records require original-owner review.', key); continue }
                    if (record.terminal) await put(input.inputId, key, record, { version: 1, state: 'retired', automaticDispatch: false })
                    else await payload(input, key, record, parsedJson(record.value), tuple[1])
                }
            } else if (input.kind === 'browser-storage') {
                const parsed = browserSchema.safeParse(raw.value), downloaded = browserDownloadSchema.safeParse(raw.value)
                if (!parsed.success && !downloaded.success) { await unknown(input.inputId, raw.value, raw.error ?? 'Unsupported selected browser storage export.'); continue }
                if (downloaded.success && downloaded.data.origin !== scope.origin) {
                    await unknown(input.inputId, raw.value, 'The downloaded browser origin differs from the selected application. No account or source is inferred.'); continue
                }
                if (downloaded.success && downloaded.data.databases.length) await unknown(input.inputId,
                    { origin: downloaded.data.origin, databases: downloaded.data.databases },
                    'Retain the original browser databases for the files recovery stage; attachment bytes and editor baselines cannot become composer requests.', originalKey(input.inputId, 'databases'))
                const entries = parsed.success ? parsed.data.entries : downloaded.success ? downloaded.data.localStorage : []
                for (const [position, entry] of entries.entries()) {
                    const key = originalKey(input.inputId, entry.key), value = parsedJson(entry.value)
                    const outboxPrefix = `hhpi:outbox:v1:${input.storageScope}:`, actionPrefix = `hhpi:native-actions:v1:${input.storageScope}:`
                    if (entry.key.startsWith(outboxPrefix) || entry.key.startsWith(actionPrefix)) {
                        let originalId: string; try { originalId = decodeURIComponent(entry.key.slice(entry.key.startsWith(outboxPrefix) ? outboxPrefix.length : actionPrefix.length)) } catch { await unknown(input.inputId, entry, 'The original operation index ID cannot be decoded.', key); continue }
                        const records = ledgers.get(originalKey(input.hostId, input.storageScope, originalId))
                        if (records?.length) {
                            const consistent = records.every(value => isDeepStrictEqual(value, records[0]))
                            await put(input.inputId, key, entry, { version: 1, state: consistent ? records[0]!.terminal ? 'retired-mirror' : 'canonical-record-preserved' : 'conflicting-canonical-records', originalId, automaticDispatch: false }, undefined, !consistent,
                                !consistent ? 'The canonical operation records conflict. No mirror may replace them.' : undefined)
                        } else if (entry.key.startsWith(outboxPrefix)) await payload(input, key, entry, value, originalId)
                        else await unknown(input.inputId, entry, 'The native action index has no complete canonical transaction record; do not reconstruct a request.', key)
                    } else if (entry.key.startsWith('hapi-dsh:composer-draft:v1:') || entry.key.startsWith('hhpi:composer-draft:v2:') || entry.key.startsWith('dsh.conversation.')
                        || /^hapi-dsh:host:[^:]+:pane:[^:]+:dsh\.conversation\./u.test(entry.key)) {
                        const draft = isRecord(value) ? value.draft : undefined
                        const supported = typeof draft === 'string' || isRecord(draft) && typeof draft.text === 'string'
                        let target: AppSourceRoute | undefined
                        if (entry.key.startsWith('hhpi:composer-draft:v2:')) {
                            const tuple = parsedJson(entry.key.slice('hhpi:composer-draft:v2:'.length))
                            if (Array.isArray(tuple) && tuple.length === 3 && tuple[0] === input.storageScope && tuple[1] === input.hostId && typeof tuple[2] === 'string') {
                                const display = fromDisplay(input.hostId, tuple[2])
                                const candidates = display.identity ? display.match.status === 'matched' ? [display.match.target] : []
                                    : options.targets.filter(value => value.target.kind !== 'hhpi' && value.target.hostId === input.hostId && value.target.sessionId === tuple[2]).map(value => value.target)
                                if (new Set(candidates.map(routeKey)).size === 1) target = candidates[0]
                            }
                        }
                        await put(input.inputId, key, entry, { version: 1, state: 'unsent-draft', draft: draft ?? null, automaticDispatch: false, automaticInstall: false }, target, !target || !supported,
                            !supported ? 'The complete original composer draft needs manual recovery.' : !target ? 'Keep this complete original draft for explicit account/source restoration; an unscoped or mismatched key cannot assign an authenticated owner.' : undefined)
                    } else await unknown(input.inputId, entry, 'This browser key is not part of the selected session migration contract. Original bytes remain available.', originalKey(input.inputId, position, entry.key))
                }
            }
        }
        if (!owners.length) blockers.push('No original execution-owner inventory was selected. Session mappings alone cannot satisfy G_OWNER.')
        else blockers.push('Every recorded source still needs original-owner settlement and current authorization before enabling its sole writable native route. Idle, inactive and empty execution metadata do not prove owner exit.')
        await put(inputs[0]!.inputId, SESSION_ALIASES_OBJECT_ID, { version: 1, selectedScope: scope }, sourceAliasDocumentSchema.parse({ version: 1, scope, entries }))
        await put(inputs[0]!.inputId, SESSION_HANDOFF_OBJECT_ID, { version: 1 }, { version: 1, sources: owners, gate: 'G_OWNER', gateSatisfied: false,
            productionCutoverPerformed: false, nextSteps: ['close-original-admission', 'reconcile-original-operation-and-request-ids', 'verify-supported-original-owner-exit-or-same-owner-handoff', 'authorize-and-enable-one-native-route'] }, undefined, true, blockers.join(' '))
        await domainReport(recovery, 'sessions', inputs, outputs, blockers)
    } }
}
