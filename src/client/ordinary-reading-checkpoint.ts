/** One-shot controlled-update positions from each real mounted reader. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ChatScrollPosition } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { SessionSeq } from '@deepseek-ai/dsh-session/types'
import { z } from 'zod'
import { isSourceSessionId } from '../remote/protocol.ts'
import { isSourceDisplayId } from '../shared/source-display-id.ts'
import type { ComposerAuthenticatedIdentity } from './composer-autosave.ts'
import type { MountedChatControlV1 } from './mounted-chat-control.ts'
import type { WorkspaceUpdatePreparations } from './update-preparation.ts'
import { registerReadingMemoryProvider, type ReadingMemoryCapture } from './reading-memory-provider.ts'

const ARMED = 'hhpi:update-reading:armed:v1', STAGED = 'hhpi:update-reading:staged:v1'
const targetSchema = z.strictObject({ scope: z.string(), hostId: z.string(), sessionId: z.string(), paneId: z.string() })
const positionSchema = z.strictObject({ anchorKey: z.string(), anchorOwnerKey: z.string().optional(),
    anchorTop: z.number(), scrollTop: z.number() })
const ticketSchema = z.strictObject({ target: targetSchema, position: positionSchema.nullable(),
    node: z.strictObject({ key: z.string(), seq: z.number().int().nonnegative() }).nullable(), epoch: z.string().min(1).optional() })
const envelopeSchema = z.strictObject({ version: z.literal(1), tickets: z.array(ticketSchema) })
export type OrdinaryReadingTarget = Omit<z.infer<typeof targetSchema>, 'scope'>
type Ticket = z.infer<typeof ticketSchema>
type StoragePort = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
const registries = new WeakMap<WorkspaceUpdatePreparations, OrdinaryReadingUpdateTickets>()
const keyOf = (value: z.infer<typeof targetSchema>): string => JSON.stringify([value.scope, value.hostId, value.sessionId, value.paneId])
const occurrenceKey = (value: OrdinaryReadingTarget): string => JSON.stringify([value.hostId, value.sessionId, value.paneId])
const ordinary = (id: string): boolean => !isSourceSessionId(id) && !isSourceDisplayId(id)

/** A synchronous official save belongs to the explicit reader being sampled,
 * even when two ordinary Panes share one SessionBinding. Passive saves do not
 * create a durable bookmark, and ordinary new opens start at their latest window. */
export function installOrdinaryReadingMemory(ctx: Context): () => void {
    let active = true
    let sampling: { binding: SessionBinding; saved?: { position: ChatScrollPosition | null } } | undefined
    const memory: ReadingMemoryCapture = { current: () => active, capture(binding, reader) {
        if (!active) throw new Error('The original reading memory owner is closed.')
        if (!reader.checkpointReading || reader.read().busy) throw new Error('The official reader cannot capture its current position. The page remains open.')
        const before = sampling, capture = { binding } as NonNullable<typeof sampling>
        sampling = capture
        try {
            reader.checkpointReading()
            if (!capture.saved) throw new Error('The actual ordinary reader did not save its current position. The page remains open.')
            return capture.saved.position
        } finally { sampling = before }
    } }
    const stop = registerReadingMemoryProvider(ctx, 'ordinary', binding => {
        if (!ordinary(binding.sessionId)) return undefined
        let value: ChatScrollPosition | null = null
        return { read: () => value, save(position) {
            // The mounted reader needs its own live anchor facts. This handle
            // is transient; a new injected view starts without an old bookmark.
            value = position === null ? null : { ...position }
            if (sampling?.binding === binding) sampling.saved = { position: value }
        } }
    }, memory)
    return () => { active = false; stop() }
}

/** Stage during preparation; activate only at the final controlled-reload seam.
 * An armed envelope is consumed into memory once at the next reload, so a later
 * arbitrary reload/new open cannot resurrect an unconsumed old position. */
export class OrdinaryReadingUpdateTickets {
    private readonly active = new Set<object>()
    private readonly staged = new Map<object, { ticket: Ticket; current(): boolean }>()
    private readonly loaded = new Map<string, Ticket>()
    private readonly occurrences = new Set<string>()
    constructor(private readonly storage: StoragePort, reload: boolean) {
        const serialized = storage.getItem(ARMED)
        if (serialized === null) return
        storage.removeItem(ARMED)
        if (!reload) return
        let value: unknown
        try { value = JSON.parse(serialized) } catch { return }
        const parsed = envelopeSchema.safeParse(value)
        if (parsed.success) for (const ticket of parsed.data.tickets) this.loaded.set(keyOf(ticket.target), ticket)
    }
    register(): { stage(ticket: Ticket, current: () => boolean): void; dispose(): void } {
        const owner = {}; this.active.add(owner)
        return { stage: (ticket, current) => {
            if (!this.active.has(owner) || !current()) throw new Error('The original reader or account changed.')
            const staged = new Map(this.staged).set(owner, { ticket, current })
            this.storage.setItem(STAGED, JSON.stringify({ version: 1, tickets: [...staged.values()].map(value => value.ticket) }))
            this.staged.set(owner, { ticket, current })
        }, dispose: () => { this.active.delete(owner); this.staged.delete(owner) } }
    }
    /** Each actual Pane binding gets at most one startup restore opportunity. */
    occurrence(target: OrdinaryReadingTarget): (scope: string) => Ticket | undefined {
        const key = occurrenceKey(target), available = !this.occurrences.has(key)
        this.occurrences.add(key)
        let claimed = false
        return scope => {
            if (!available || claimed) return undefined
            const id = keyOf({ ...target, scope }), ticket = this.loaded.get(id)
            if (ticket) { claimed = true; this.loaded.delete(id) }
            return ticket
        }
    }
    armForReload(): () => void {
        if (this.active.size !== this.staged.size || [...this.staged.values()].some(value => !value.current()))
            throw new Error('The open readers changed after saving. The page remains open.')
        const value = JSON.stringify({ version: 1, tickets: [...this.staged.values()].map(entry => entry.ticket) })
        this.storage.setItem(ARMED, value)
        return () => { if (this.storage.getItem(ARMED) === value) this.storage.removeItem(ARMED) }
    }
}

/** Call immediately before location.reload, after all saves and worker activation. */
export function armOrdinaryReadingForReload(updates: WorkspaceUpdatePreparations): () => void {
    return registries.get(updates)?.armForReload() ?? (() => {})
}

export interface OrdinaryReadingCheckpointOptions {
    updates: WorkspaceUpdatePreparations
    application: ComposerAuthenticatedIdentity
    target: OrdinaryReadingTarget
    storage: StoragePort
    /** True only for this document's reload navigation, never ordinary new opens. */
    reload: boolean
    reader(): MountedChatControlV1 | undefined
    current(): boolean
}

/** The host Pane owns installation and invokes restore only for its initial,
 * untargeted activation. Explicit message/latest navigation takes precedence. */
export function registerOrdinaryReadingCheckpoint(ctx: Context, binding: SessionBinding, options: OrdinaryReadingCheckpointOptions):
    { dispose(): void; restore(signal: AbortSignal): Promise<boolean> } {
    if (!ordinary(binding.sessionId) || binding.sessionId !== options.target.sessionId)
        throw new Error('An ordinary reading checkpoint needs its exact original DSH binding.')
    return registerUpdateReadingCheckpoint(ctx, binding, options, false)
}

/** HHPI keeps its latest-on-open policy. Only this explicitly armed update ticket may restore an old position. */
export function registerSourceUpdateReadingCheckpoint(ctx: Context, binding: SessionBinding, options: OrdinaryReadingCheckpointOptions):
    { dispose(): void; pending(): boolean | undefined; restore(signal: AbortSignal): Promise<boolean> } {
    if (!isSourceSessionId(binding.sessionId) || binding.sessionId !== options.target.sessionId)
        throw new Error('A source update reading checkpoint needs its exact original native binding.')
    return registerUpdateReadingCheckpoint(ctx, binding, options, true)
}

function registerUpdateReadingCheckpoint(ctx: Context, binding: SessionBinding, options: OrdinaryReadingCheckpointOptions, source: boolean):
    { dispose(): void; pending(): boolean | undefined; restore(signal: AbortSignal): Promise<boolean> } {
    const provider = ctx.get('sourceReadingMemory')
    const memory = source ? provider?.sourceCapture() : provider?.ordinaryCapture()
    if (!memory) throw new Error('The original reading memory is not installed on this graph.')
    const sourceEpoch = (): string | undefined => {
        if (!source) return undefined
        const epoch = (binding.session as { sourceEpoch?: unknown }).sourceEpoch
        if (typeof epoch !== 'string' || !epoch) throw new Error('The original source epoch is not ready. The page remains open.')
        return epoch
    }
    let registry = registries.get(options.updates)
    if (!registry) { registry = new OrdinaryReadingUpdateTickets(options.storage, options.reload); registries.set(options.updates, registry) }
    const registration = registry.register(), restoreTicket = registry.occurrence(options.target)
    let identity = options.application.getSnapshot(), captured: Ticket | undefined, sampled: MountedChatControlV1 | undefined
    let disposed = false, completed = false, ticket: Ticket | undefined
    const identities = new WeakMap<MountedChatControlV1, number>(); let sequence = 0
    const current = (): boolean => {
        identity ??= options.application.getSnapshot()
        const now = options.application.getSnapshot()
        return !disposed && memory.current() && !!identity && !identity.signal.aborted && now?.scope === identity.scope && now.signal === identity.signal && options.current() && !!options.reader()
    }
    const revision = (): string => {
        const control = options.reader(), state = control?.read()
        if (control && !identities.has(control)) identities.set(control, ++sequence)
        return JSON.stringify([control ? identities.get(control) : 0, state?.revision, state?.renderRevision, ...(source ? [sourceEpoch()] : [])])
    }
    const stop = options.updates.registerCheckpoint({ kind: 'reading', label: source ? 'Source conversation reading position' : 'Ordinary conversation reading position', current, revision,
        capture(signal) {
            captured = undefined; sampled = undefined; signal.throwIfAborted()
            const control = options.reader()!
            const position = memory.capture(binding, control)
            if (!current() || options.reader() !== control) throw new Error('The original reader or account changed while sampling.')
            const node = position === null ? undefined : ctx.uiConversation.binding(binding).target('chat').getSnapshot()?.nodes.get(position.anchorOwnerKey ?? position.anchorKey)
            const seq = node ? Math.floor(node.anchorSeq) : undefined
            if (position !== null && (!node || seq === undefined || !Number.isSafeInteger(seq) || seq < 0))
                throw new Error('The actual reading position has no durable source event. The page remains open.')
            sampled = control
            const epoch = sourceEpoch()
            captured = { target: { ...options.target, scope: identity!.scope }, position, ...(epoch === undefined ? {} : { epoch }),
                node: node && seq !== undefined ? { key: node.key, seq } : null }
        },
        save(signal) {
            signal.throwIfAborted()
            if (!captured || options.reader() !== sampled) throw new Error('The original reader changed while saving.')
            const savedRevision = revision()
            registration.stage(captured, () => current() && revision() === savedRevision)
            signal.throwIfAborted()
        },
    })
    const pending = (): boolean | undefined => {
        if (completed) return false
        identity ??= options.application.getSnapshot()
        if (!identity) return undefined
        ticket ??= restoreTicket(identity.scope)
        if (!ticket) completed = true
        return !!ticket
    }
    return { dispose() { disposed = true; stop(); registration.dispose() }, pending, async restore(signal) {
        signal.throwIfAborted()
        if (pending() === false) return false
        if (!current()) throw new Error('The original reader or account is not ready for update restoration.')
        if (!ticket) throw new Error('The original update reading ticket is not ready.')
        const assertEpoch = () => { if (source && ticket!.epoch !== sourceEpoch()) throw new Error('The original source replaced this reading position. Its update ticket is retained for review.') }
        assertEpoch()
        if (ticket.node !== null) {
            const reading = ctx.uiConversation.binding(binding).readingView
            if (!reading) throw new Error('The official conversation reading window is unavailable.')
            await reading.read({ kind: 'around', target: { key: ticket.node.key, seq: ticket.node.seq as SessionSeq } }, signal)
            signal.throwIfAborted()
            if (!current()) throw new Error('The original reader or account changed during update restoration.')
            assertEpoch()
            const control = options.reader()!
            await control.reveal(ticket.node, signal)
            signal.throwIfAborted()
            if (!current() || options.reader() !== control) throw new Error('The original reader changed during update restoration.')
            assertEpoch()
        }
        completed = true
        return true
    } }
}
