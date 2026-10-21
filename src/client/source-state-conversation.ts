import type { ConversationNodeDefinition, ConversationViewBuilder, ConversationViewDefinition, ConversationViewNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { hapiProjectionSchema, type HapiProjection } from '../codex/projection-types.ts'
import { hapiObservedProjectionSchema, type HapiObservedProjection } from '../hapi-agent/projection-types.ts'

export const SOURCE_STATE_VIEW = 'hapi-source-state'
export type SourceStateRecord = { kind: 'codex'; value: NonNullable<HapiProjection> } | { kind: 'observed'; value: NonNullable<HapiObservedProjection> }
export interface SourceStateSnapshot { readonly seq: number; readonly time: number; readonly record: SourceStateRecord }
export interface SourceStateNode extends ConversationViewNode { readonly target: typeof SOURCE_STATE_VIEW; readonly data: SourceStateSnapshot }

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
    interface ConversationViewSnapshotMap { 'hapi-source-state': SourceStateSnapshot | null }
}

/** Match only the source adapter's existing, validated state records. No chat
 * event, synthetic turn, execution transition, or Session mutation is made. */
export function sourceStateRecord(event: { type: string; data: unknown }): SourceStateRecord | null {
    if (event.type === 'plugin:hapi-dsh/state') {
        const value = hapiProjectionSchema.safeParse(event.data)
        return value.success && value.data ? { kind: 'codex', value: value.data } : null
    }
    if (event.type === 'plugin:hapi-dsh-observed/state') {
        const value = hapiObservedProjectionSchema.safeParse(event.data)
        return value.success && value.data ? { kind: 'observed', value: value.data } : null
    }
    return null
}

export const sourceStateDefinition: ConversationNodeDefinition<SourceStateSnapshot> = {
    kind: SOURCE_STATE_VIEW,
    target: SOURCE_STATE_VIEW,
    match(event) { return sourceStateRecord(event) ? { id: 'source', role: 'start' } : null },
    start(_context, match) {
        const record = sourceStateRecord(match.event)
        if (!record) throw new Error('A source state view requires its actual validated source record')
        return { seq: match.event.seq, time: match.event.time, record }
    },
    update(context, match) {
        if (match.event.seq <= context.state.seq) return context.state
        const record = sourceStateRecord(match.event)
        return record ? { seq: match.event.seq, time: match.event.time, record } : context.state
    },
    buildViewNode(context): SourceStateNode | null {
        return context.state ? { key: context.key, kind: SOURCE_STATE_VIEW, id: context.id, target: SOURCE_STATE_VIEW, data: context.state } : null
    },
}

/** Latest real state in this Session's loaded event window, with no fabricated
 * activity for absent/invalid records. A source status page is UI content; its
 * presence does not claim that the native engine is currently running. */
export function createSourceStateBuilder(): ConversationViewBuilder<SourceStateNode, SourceStateSnapshot | null> {
    let snapshot: SourceStateSnapshot | null = null
    const accept = (nodes: readonly SourceStateNode[]): SourceStateSnapshot | null => {
        for (const node of nodes) if (node.target === SOURCE_STATE_VIEW && (!snapshot || node.data.seq > snapshot.seq)) snapshot = node.data
        return snapshot
    }
    return { empty: null, replace({ nodes }) { snapshot = null; return accept(nodes) }, apply({ upserts }) { return accept(upserts) } }
}

export const sourceStateViewDefinition: ConversationViewDefinition<SourceStateNode, SourceStateSnapshot | null> = {
    target: SOURCE_STATE_VIEW,
    create: createSourceStateBuilder,
    isActive: snapshot => snapshot != null,
}
