/** One public service registration per graph; source owners keep separate slots. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ChatScrollMemoryV1 } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ChatScrollPosition } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { MountedChatControlV1 } from './mounted-chat-control.ts'
import { isSourceSessionId } from '../remote/protocol.ts'

type Kind = 'hhpi' | 'ordinary'
type Factory = ChatScrollMemoryV1['forBinding']
export interface ReadingMemoryCapture {
    current(): boolean
    capture(binding: SessionBinding, reader: MountedChatControlV1): ChatScrollPosition | null
}
/** Source-provider and workspace are separate browser modules. The graph,
 * rather than either module's JS instance, owns their shared registration. */
export interface SourceReadingMemory {
    readonly memory: ChatScrollMemoryV1
    register(kind: Kind, factory: Factory, capture?: ReadingMemoryCapture): () => void
    ordinaryCapture(): ReadingMemoryCapture | undefined
    sourceCapture(): ReadingMemoryCapture | undefined
}
declare module '@deepseek-ai/cordis' { interface Context { sourceReadingMemory: SourceReadingMemory } }

export function registerReadingMemoryProvider(ctx: Context, kind: Kind, factory: Factory, capture?: ReadingMemoryCapture): () => void {
    // Registration can run while the providing plugin's apply is still loading.
    let registry = ctx.get('sourceReadingMemory', false)
    if (!registry) {
        if (ctx.get('chatScrollMemory', false)) throw new Error('Another plugin already owns this graph\'s reading memory service.')
        const slots = new Map<Kind, { factory: Factory; capture?: ReadingMemoryCapture }>()
        const memory: ChatScrollMemoryV1 = { forBinding(binding: SessionBinding) {
            return slots.get(isSourceSessionId(binding.sessionId) ? 'hhpi' : 'ordinary')?.factory(binding)
        } }
        registry = { memory, register(ownerKind, ownerFactory, ownerCapture) {
            if (slots.has(ownerKind)) throw new Error(`The ${ownerKind} reading memory owner is already installed on this graph.`)
            const owner = { factory: ownerFactory, ...(ownerCapture ? { capture: ownerCapture } : {}) }
            slots.set(ownerKind, owner)
            return () => { if (slots.get(ownerKind) === owner) slots.delete(ownerKind) }
        }, ordinaryCapture: () => slots.get('ordinary')?.capture, sourceCapture: () => slots.get('hhpi')?.capture }
        ctx.reflect.provide('sourceReadingMemory', registry)
        ctx.reflect.provide('chatScrollMemory', memory)
    }
    return registry.register(kind, factory, capture)
}
