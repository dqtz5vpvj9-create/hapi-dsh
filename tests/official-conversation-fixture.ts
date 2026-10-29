/** Unchanged installed DSH registries, Chat definitions/builder, and history reader.
 * Only unused Host services and browser primitives are protocol test seats. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { type Session, type SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access'
import { SessionController } from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-client-file-upload'

const require = createRequire(import.meta.url)
interface Registry { entries(): readonly unknown[]; register(value: unknown): () => void }
interface EventRegistry extends Registry { registerFallback(value: unknown): () => void; fallbackEntry(): unknown }
interface BrowserModule {
    ConversationEventRegistry: new (ctx: Context) => EventRegistry
    ConversationViewRegistry: new (ctx: Context) => Registry
    ConversationNodeAssembler: new (events: EventRegistry, views: Registry, groups: { forTarget(target: string): unknown }) => OfficialChatAssembler
}
export interface OfficialChatNode {
    key: string; kind: string; anchorSeq: number
    data: { content?: readonly { type: string; text?: string }[]; blocks?: readonly { kind: string; text?: string }[] }
}
export interface OfficialChatSnapshot {
    order: readonly string[]
    nodes: { get(key: string): OfficialChatNode | undefined }
    timeline: { turnOrder: readonly number[]; turns: ReadonlyMap<number, { status: string }> }
}
export interface OfficialChatAssembler {
    replaceWindow(entries: readonly { type: 'event'; event: SessionEvent }[], hasMore: boolean): unknown
    append(entry: { type: 'event'; event: SessionEvent }): unknown
    prepend(entries: readonly { type: 'event'; event: SessionEvent }[], hasMore: boolean): unknown
    flush(): boolean
    activateTarget(target: string): unknown
    snapshot(target: string): OfficialChatSnapshot
    grouped(target: string): { entries: readonly { kind: 'node' | 'group'; key: string; groupPart?: string }[] } | undefined
}

function browserModule(name: string): Record<string, unknown> {
    assert.equal((require(`${name}/package.json`) as { version: string }).version, '0.2.1-rc.3')
    let registration: { id: string; factory(resolve: (id: string) => unknown): Record<string, unknown> } | undefined
    new Function('window', readFileSync(require.resolve(`${name}/client`), 'utf8'))({
        __ModuleLoader__: { load(value: typeof registration) { registration = value } },
    })
    assert.equal(registration?.id, name)
    const unusedBrowserPrimitive = new Proxy({}, { get(_target, key) {
        return () => { throw new Error(`Conversation assembly unexpectedly rendered browser primitive ${String(key)}`) }
    } })
    return registration!.factory(id => id === '@deepseek-ai/dsh-client-ui-primitives' ? unusedBrowserPrimitive : require(id))
}

/** Register the real Chat business definitions through its public plugin entry.
 * Stop only when it reaches the unrelated React session-hook installation. */
export function officialChat(options: { trajectory?: boolean } = {}): { assembler: OfficialChatAssembler; close(): Promise<void> } {
    const core = browserModule('@deepseek-ai/dsh-client-ui-conversation') as unknown as BrowserModule
    const chat = browserModule('@deepseek-ai/dsh-client-ui-chat') as { apply(ctx: unknown): void }
    const ctx = new Context(), events = new core.ConversationEventRegistry(ctx), views = new core.ConversationViewRegistry(ctx)
    const groups: Array<{ target: string }> = [], registered = Symbol('all official Conversation definitions registered')
    assert.throws(() => chat.apply({ effect: () => () => {}, uiConversation: { events, views,
        groups: { register(value: { target: string }) { groups.push(value) } } },
        uiSession: { provide() { throw registered } },
    }), error => error === registered)
    if (options.trajectory) {
        const trajectory = browserModule('@deepseek-ai/dsh-client-ui-trajectory') as { apply(ctx: unknown): void }
        assert.throws(() => trajectory.apply({ effect: () => () => {}, locale: { bind: () => () => '' },
            uiConversation: { events, views, groups: { register(value: { target: string }) { groups.push(value) } } },
            uiSession: { provide() { throw registered } },
        }), error => error === registered)
    }
    assert.ok(events.entries().length >= 15)
    const assembler = new core.ConversationNodeAssembler(events, views, { forTarget: target => groups.find(value => value.target === target) })
    return { assembler, close: () => ctx.fiber.dispose() }
}

class FixtureQuery extends SessionQueryEngine {
    override searchSessions(): Promise<never> { throw new Error('Search is outside this history fixture') }
    override searchEvents(): Promise<never> { throw new Error('Search is outside this history fixture') }
}

/** The same public history/page implementation and options used by the Web client. */
export async function officialHistoryPage(session: Session) {
    const ctx = new Context()
    try {
        await ctx.plugin(SessionStore); await ctx.plugin(AgentRegistry); await ctx.plugin(SessionProjectionRegistry); await ctx.plugin(TypertRegistry)
        new FixtureQuery(ctx); new RemoteAccessService(ctx)
        ctx.provide('fileUploads', { registerAgentResolver: () => () => {} } as unknown as Context['fileUploads'])
        const controller = new SessionController(ctx, { nativeOpen: false })
        // Re-prepare the detached source log through the official store; a cwd
        // is required by the public cold-safe history route.
        // Client tests also augment Context.sessions with its browser face.
        // This fixture installed the Host store above, whose public methods
        // prepare the detached log for the actual controller.
        const store = ctx.sessions as unknown as SessionStore
        const attached = store.prepare(session.id, { seed: session.snapshotEvents(), meta: { cwd: '/synthetic/source' } })
        store.enter(attached)
        const page = await controller.page({ address: { kind: 'session', sessionId: attached.id },
            throughSeq: SessionSeq(attached.seq - 1), maxMessages: 500, turnWindow: { minMessages: 50, minTurns: 2 } }, new AbortController().signal)
        return { hasMore: page.hasMore, entries: page.records.map(value => {
            assert.equal(value.type, 'event')
            return { type: 'event' as const, event: value.event as unknown as SessionEvent }
        }) }
    } finally { await ctx.fiber.dispose() }
}
