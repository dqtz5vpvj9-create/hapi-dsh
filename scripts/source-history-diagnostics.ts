/** Offline, content-free diagnostics for the actual HAPI v2 JSON download.
 * Source: HAPI 0f8ef697 shared/src/sessionExport.ts and schemas.ts.
 * Nothing returned by this module is an input string, arbitrary key, ID,
 * timestamp, path, model selection, credential, or exception message. */
import { z } from 'zod'
import { messageSchema, sessionSchema } from '../src/hapi/schemas.ts'
import type { HapiMessage } from '../src/codex/contracts.ts'
import { compareNativeMessages, envelopeFor, nativeExecutionFor, parseNativeRow, record, type NativeBinding } from '../src/codex/native.ts'
import { parseNativeObservation } from '../src/codex/observations.ts'
import { parseObservedHistory, type ObservedItem } from '../src/hapi-agent/parser.ts'

export const MAX_DIAGNOSTIC_INPUT_BYTES = 100 * 1024 * 1024
export const DIAGNOSTIC_ERRORS = [
    'input-unreadable', 'input-too-large', 'input-invalid-json', 'unsupported-export-envelope',
    'unsupported-export-version', 'invalid-session-schema', 'diagnostic-unavailable', 'invalid-arguments',
    'unsupported-native-pages-envelope', 'invalid-native-page-schema', 'invalid-native-requests-schema',
] as const
export type DiagnosticErrorCode = typeof DIAGNOSTIC_ERRORS[number]
export class DiagnosticInputError extends Error {
    constructor(readonly code: DiagnosticErrorCode) { super(code) }
}

// The downloaded file is the payload itself, not {payload}, {data}, an API
// page, arbitrary JSONL, or an app-server thread/read response. Invalid rows
// are counted independently so a schema mismatch remains diagnosable.
const exportEnvelope = z.object({
    schemaVersion: z.literal(2), exportedAt: z.number().int().nonnegative(),
    session: z.unknown(), messages: z.array(z.unknown()), scratchlist: z.array(z.unknown()),
})
// The source's export schema explicitly accepts null/missing activeAt for
// legacy SQLite sessions. Keep that compatibility local to this offline
// reader; the live transport validator is outside this diagnostic's scope.
const exportedSession = sessionSchema.extend({
    id: z.string(), activeAt: z.number().nullish().transform(value => value ?? 0),
})
const FLAVORS = ['codex', 'claude', 'pi', 'dsh', 'cursor', 'qoder', 'grok', 'opencode', 'gemini', 'copilot', 'kimi', 'agy'] as const
const ROLES = ['user', 'agent'] as const
const CONTENT_TYPES = ['text', 'event', 'codex', 'output'] as const
const PAYLOAD_TYPES = [
    'message', 'reasoning', 'tool-call', 'tool-call-result', 'native-turn', 'error', 'ready', 'abort-restore',
    'compact-summary', 'compact', 'context_compacted', 'token_count', 'plan', 'plan_update', 'generated-image',
    'agent-run-start', 'agent-run-update', 'agent-run-trace', 'assistant', 'user', 'result', 'system', 'summary',
    'agy_message', 'agy_tool_action',
] as const
function counters<const T extends readonly string[]>(keys: T): Record<T[number] | 'other' | 'missing', number> {
    return Object.fromEntries([...keys, 'other', 'missing'].map(key => [key, 0])) as Record<T[number] | 'other' | 'missing', number>
}
function bucket<const T extends readonly string[]>(value: unknown, keys: T): T[number] | 'other' | 'missing' {
    return value === undefined || value === null ? 'missing'
        : typeof value === 'string' && keys.includes(value) ? value as T[number] : 'other'
}
function wrapper(value: unknown): 'direct' | 'message' | 'dataMessage' | 'payloadMessage' | 'unrecognized' {
    const v = record(value)
    if (!v) return 'unrecognized'
    if (typeof v.role === 'string') return 'direct'
    if (typeof record(v.message)?.role === 'string') return 'message'
    if (typeof record(record(v.data)?.message)?.role === 'string') return 'dataMessage'
    if (typeof record(record(v.payload)?.message)?.role === 'string') return 'payloadMessage'
    return 'unrecognized'
}
function candidates() {
    return { userDisplayable: 0, userPending: 0, assistantDurable: 0, assistantProvisional: 0,
        toolCall: 0, toolResult: 0, lifecycle: 0, notice: 0, usage: 0 }
}
function observedCandidate(item: ObservedItem, target: ReturnType<typeof candidates>): void {
    switch (item.kind) {
        case 'user': target[item.invoked ? 'userDisplayable' : 'userPending']++; break
        case 'assistant': target[item.live ? 'assistantProvisional' : 'assistantDurable']++; break
        case 'tool-call': target.toolCall++; break
        case 'tool-result': target.toolResult++; break
        case 'end': target.lifecycle++; break
        case 'notice': target.notice++; break
        case 'usage': target.usage++; break
    }
}

export function readDiagnosticJson(json: string): unknown {
    const jsonBytes = Buffer.byteLength(json)
    if (jsonBytes > MAX_DIAGNOSTIC_INPUT_BYTES) throw new DiagnosticInputError('input-too-large')
    try { return JSON.parse(json) } catch { throw new DiagnosticInputError('input-invalid-json') }
}

export function readDiagnosticSession(value: unknown) {
    const result = exportedSession.safeParse(value)
    if (!result.success) throw new DiagnosticInputError('invalid-session-schema')
    return result.data
}

/** Only numeric statistics and fixed protocol vocabulary leave this function. */
export function diagnoseSourceHistory(json: string) {
    const value = readDiagnosticJson(json)
    const outer = record(value)
    if (outer && 'schemaVersion' in outer && outer.schemaVersion !== 2) throw new DiagnosticInputError('unsupported-export-version')
    const envelope = exportEnvelope.safeParse(value)
    if (!envelope.success) throw new DiagnosticInputError('unsupported-export-envelope')
    const session = readDiagnosticSession(envelope.data.session)
    const statistics = diagnoseMessageRows(session, envelope.data.messages, json)
    return {
        diagnosticVersion: 1 as const, inputSchema: 'hapi-session-export-v2' as const,
        coverage: 'hub-export-store-snapshot' as const,
        limitations: [
            'export-filters-uninvoked-and-some-internal-source-rows',
            'parser-candidates-are-not-live-renderer-verification',
            ...(session.metadata?.codexNativeSession === true ? ['native-rpc-history-completeness-unproven'] : []),
        ],
        ...statistics,
        rows: { ...statistics.rows, exported: envelope.data.messages.length, scratchlist: envelope.data.scratchlist.length },
    }
}

/** Shared parser evidence. Rows are received occurrences, not invented or
 * reconstructed transcript messages. Never output any source scalar/key. */
export function diagnoseMessageRows(session: ReturnType<typeof readDiagnosticSession>, rawRows: readonly unknown[], json: string) {
    const metadata = session.metadata
    const threadId = metadata?.flavor === 'codex' && metadata.codexSessionId ? metadata.codexSessionId : undefined
    const binding: NativeBinding | undefined = threadId ? {
        hubId: 'offline-diagnostic', hapiSessionId: 'offline-diagnostic', threadId,
        machineId: null, home: null, homeId: null,
    } : undefined
    const roles = counters(ROLES), contentTypes = counters(CONTENT_TYPES), payloadTypes = counters(PAYLOAD_TYPES)
    const wrappers = { direct: 0, message: 0, dataMessage: 0, payloadMessage: 0, unrecognized: 0 }
    const execution = { absent: 0, valid: 0, invalid: 0, outer: 0, inner: 0, sourceThreadMatches: 0,
        sourceThreadDiffers: 0, withItem: 0, withTurnLifecycle: 0, terminalTurn: 0 }
    const identities = { bodyIdMissing: 0, localIdMissing: 0, localIdEqualsBodyId: 0, localIdDiffersFromBodyId: 0 }
    const native = { applicable: metadata?.flavor === 'codex' && metadata.codexNativeSession === true,
        bindingAvailable: binding !== undefined, candidates: candidates(), unhandledRows: 0, excludedChildRows: 0, rejectedRows: 0 }
    const observed = { completed: false, root: candidates(), children: candidates(), rejectedHistory: 0 }
    const reasons = {
        invalidMessageSchema: 0, unrecognizedEnvelope: 0, unrecognizedRole: 0, unrecognizedContentType: 0,
        unrecognizedPayloadType: 0, nativeBindingUnavailable: 0, nativeThreadMismatch: 0,
        nativeContentWithoutTurn: 0, nativeUninvokedUser: 0, nativeAssistantWithoutDurableIdentity: 0,
        nativeAssistantExplicitlyLive: 0,
        nativeUnsupportedRow: 0, nativeParserRejected: 0, observedParserRejected: 0,
    }
    let largestMessageBytes = 0, totalMessageBytes = 0
    const rows: HapiMessage[] = []
    for (const raw of rawRows) {
        const size = Buffer.byteLength(JSON.stringify(raw)); largestMessageBytes = Math.max(largestMessageBytes, size); totalMessageBytes += size
        const parsed = messageSchema.safeParse(raw)
        if (!parsed.success) { reasons.invalidMessageSchema++; continue }
        const source = parsed.data
        const row: HapiMessage = { id: source.id, seq: source.seq, localId: source.localId, content: source.content, createdAt: source.createdAt,
            ...(source.invokedAt === undefined ? {} : { invokedAt: source.invokedAt }),
            ...(source.scheduledAt === undefined ? {} : { scheduledAt: source.scheduledAt }),
            ...(source.deliveryState === undefined ? {} : { deliveryState: source.deliveryState }),
            ...(source.steered === undefined ? {} : { steered: source.steered }) }
        rows.push(row)
        const kind = wrapper(row.content); wrappers[kind]++
        const body = envelopeFor(row.content), content = record(body?.content), data = record(content?.data)
        const role = bucket(body?.role, ROLES), contentType = bucket(content?.type, CONTENT_TYPES), payloadType = bucket(data?.type, PAYLOAD_TYPES)
        roles[role]++; contentTypes[contentType]++; payloadTypes[payloadType]++
        if (kind === 'unrecognized') reasons.unrecognizedEnvelope++
        if (role === 'other' || role === 'missing') reasons.unrecognizedRole++
        if (contentType === 'other' || contentType === 'missing') reasons.unrecognizedContentType++
        if (payloadType === 'other') reasons.unrecognizedPayloadType++
        const outerExecution = record(body?.meta)?.nativeExecution, rawExecution = outerExecution ?? data?.nativeExecution
        const facts = nativeExecutionFor(rawExecution)
        if (rawExecution === undefined || rawExecution === null) execution.absent++
        else if (!facts) execution.invalid++
        else {
            execution.valid++; if (outerExecution != null) execution.outer++; else execution.inner++
            if (facts.itemId !== undefined) execution.withItem++
            if (facts.turn) execution.withTurnLifecycle++
            if (facts.turn?.ended && facts.turn.status !== 'inProgress') execution.terminalTurn++
            if (binding) execution[facts.threadId === binding.threadId ? 'sourceThreadMatches' : 'sourceThreadDiffers']++
        }
        const bodyId = typeof data?.id === 'string' ? data.id : undefined
        if (bodyId === undefined) identities.bodyIdMissing++
        if (row.localId === null) identities.localIdMissing++
        if (bodyId !== undefined && row.localId !== null) identities[row.localId === bodyId ? 'localIdEqualsBodyId' : 'localIdDiffersFromBodyId']++
        if (!binding) { reasons.nativeBindingUnavailable++; continue }
        if (data?.type === 'agent-run-start' || data?.type === 'agent-run-update' || data?.type === 'agent-run-trace') { native.excludedChildRows++; continue }
        if (facts && facts.threadId !== binding.threadId) { native.rejectedRows++; reasons.nativeThreadMismatch++; continue }
        try {
            const parsedRow = parseNativeRow(row, binding)
            if (!parsedRow) {
                const observation = parseNativeObservation(row, binding)
                if (observation) native.candidates[observation.kind]++
                else { native.unhandledRows++; reasons.nativeUnsupportedRow++ }
                continue
            }
            if (parsedRow.kind === 'notice') { native.candidates.notice++; continue }
            if (parsedRow.kind === 'turn') { native.candidates.lifecycle++; continue }
            if (parsedRow.kind === 'user' && !parsedRow.invoked) {
                native.candidates.userPending++; reasons.nativeUninvokedUser++; continue
            }
            if (!parsedRow.execution?.turnId) { reasons.nativeContentWithoutTurn++; continue }
            if (parsedRow.kind === 'user') {
                native.candidates.userDisplayable++
            } else if (parsedRow.kind === 'assistant') {
                native.candidates[parsedRow.final ? 'assistantDurable' : 'assistantProvisional']++
                if (parsedRow.localId === null || parsedRow.localId !== parsedRow.key) reasons.nativeAssistantWithoutDurableIdentity++
                if (data?.live === true) reasons.nativeAssistantExplicitlyLive++
            } else if (parsedRow.kind === 'tool-call') native.candidates.toolCall++
            else native.candidates.toolResult++
        } catch { native.rejectedRows++; reasons.nativeParserRejected++ }
    }
    try {
        for (const item of parseObservedHistory([...rows].sort(compareNativeMessages))) observedCandidate(item, item.scopeId === null ? observed.root : observed.children)
        observed.completed = true
    } catch { observed.rejectedHistory++; reasons.observedParserRejected++ }
    let largestPhysicalLineBytes = 0
    for (let start = 0; start < json.length;) {
        const end = json.indexOf('\n', start), limit = end < 0 ? json.length : end
        largestPhysicalLineBytes = Math.max(largestPhysicalLineBytes, Buffer.byteLength(json.slice(start, limit)))
        start = limit + 1
    }
    return {
        source: { flavor: bucket(metadata?.flavor, FLAVORS), nativeFlag: metadata?.codexNativeSession === true },
        bytes: { json: Buffer.byteLength(json), largestPhysicalLine: largestPhysicalLineBytes, messagesTotal: totalMessageBytes, largestMessage: largestMessageBytes },
        rows: { supplied: rawRows.length, valid: rows.length, invalid: reasons.invalidMessageSchema },
        wrappers, roles, contentTypes, payloadTypes, execution, identities, native, observed, reasons,
    }
}

export type SourceHistoryDiagnostic = ReturnType<typeof diagnoseSourceHistory>
