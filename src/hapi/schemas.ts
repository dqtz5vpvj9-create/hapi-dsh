import { z } from 'zod';

const timestamp = z.number().finite();
const strings = z.array(z.string());
const runtime = z.object({
    owner: z.string(), generation: z.string(), sequence: z.number(),
    status: z.enum(['active', 'idle', 'notLoaded', 'systemError', 'disconnected']),
    waitingOn: z.array(z.enum(['approval', 'input'])), compacting: z.boolean().optional(),
    turnId: z.string().nullable(), startedAt: timestamp.nullable(), completedAt: timestamp.nullable(),
}).passthrough();
const metadata = z.object({
    path: z.string(), host: z.string().optional(), name: z.string().optional(),
    summary: z.object({ text: z.string(), updatedAt: timestamp.optional() }).optional(),
    machineId: z.string().optional(), flavor: z.string().nullish(),
    codexSessionId: z.string().optional(), codexStoreId: z.string().optional(),
    codexHome: z.string().optional(), codexHomeId: z.string().optional(),
    codexProvider: z.string().optional(), codexModel: z.string().optional(),
    codexNativeSession: z.boolean().optional(), codexNativeConnection: z.enum(['attached', 'history']).optional(),
}).passthrough();
const approval = z.object({
    tool: z.string(), arguments: z.unknown(), toolCallId: z.string().optional(),
    blocking: z.boolean().optional(), createdAt: timestamp.nullish(),
}).passthrough();
export const sessionSummarySchema = z.object({
    id: z.string().min(1), active: z.boolean(), thinking: z.boolean(), activeAt: timestamp, updatedAt: timestamp,
    metadata: metadata.nullable(), metadataVersion: z.number(), agentStateVersion: z.number(),
    model: z.string().nullish(), modelReasoningEffort: z.string().nullish(),
    execution: runtime.nullish(), executionVersion: z.number().optional(),
}).passthrough();
export const sessionSchema = sessionSummarySchema.extend({
    namespace: z.string(), seq: z.number(), createdAt: timestamp, thinkingAt: timestamp,
    activeTurnStartedAt: timestamp.nullish(),
    agentState: z.object({
        requests: z.record(z.string(), approval).nullish(),
        completedRequests: z.record(z.string(), approval.extend({
            status: z.enum(['canceled', 'denied', 'approved', 'resolved']), completedAt: timestamp.nullish(),
        })).nullish(),
    }).passthrough().nullable(),
});
export const messageSchema = z.object({
    id: z.string(), seq: z.number().nullable(), localId: z.string().nullable(), content: z.unknown(), createdAt: timestamp,
    invokedAt: timestamp.nullish(), scheduledAt: timestamp.nullish(),
    deliveryState: z.enum(['dispatching', 'indeterminate']).optional(), steered: z.boolean().optional(),
}).passthrough();
export const messagesSchema = z.object({
    messages: z.array(messageSchema),
    page: z.object({
        direction: z.enum(['latest', 'before', 'after']), limit: z.number(), epoch: z.number(), reset: z.boolean(),
        nextBeforeSeq: z.number().nullable(), nextBeforeAt: timestamp.nullable(),
        nextAfterSeq: z.number().nullable(), nextAfterAt: timestamp.nullable(),
        snapshotHeadSeq: z.number().nullable(), snapshotHeadAt: timestamp.nullable(), hasMore: z.boolean(),
    }),
});
export const queuedStateSchema = z.object({
    queuedLocalIds: strings, indeterminateLocalIds: strings.optional(), dispatchingLocalIds: strings.optional(),
    invokedLocalMessages: z.array(z.object({ localId: z.string(), invokedAt: timestamp })),
});
const invoked = z.object({ status: z.literal('invoked'), message: messageSchema });
export const cancelResultSchema = z.union([
    z.object({ status: z.literal('cancelled'), localId: z.string().nullable() }), invoked,
    z.object({ status: z.literal('busy'), localId: z.string() }),
]);
export const steerResultSchema = z.union([
    z.object({ status: z.literal('steered'), localId: z.string() }), invoked,
    z.object({ status: z.literal('failed'), error: z.string(), localId: z.string().nullable() }),
]);
export const retryResultSchema = z.union([
    z.object({ status: z.literal('retried'), localId: z.string() }), invoked,
    z.object({ status: z.literal('already-queued'), localId: z.string().nullable() }),
    z.object({ status: z.literal('retry-unavailable'), localId: z.string() }),
    z.object({ status: z.literal('not-found') }),
]);
export const eventSchema = z.discriminatedUnion('type', [
    z.object({ type: z.enum(['session-added', 'session-updated', 'session-removed', 'session-ended', 'message-updated', 'scheduled-matured']), sessionId: z.string() }),
    z.object({ type: z.literal('message-received'), sessionId: z.string(), message: messageSchema }),
    z.object({ type: z.literal('messages-invalidated'), sessionId: z.string(), reason: z.enum(['rewind', 'native-history']).optional(), truncateFromLocalId: z.string().optional() }),
    z.object({ type: z.literal('messages-consumed'), sessionId: z.string(), localIds: strings, invokedAt: timestamp, steered: z.boolean().optional() }),
    z.object({ type: z.enum(['messages-indeterminate', 'messages-dispatching', 'messages-requeued']), sessionId: z.string(), localIds: strings }),
    z.object({ type: z.literal('message-cancelled'), sessionId: z.string(), messageId: z.string(), localId: z.string().optional() }),
    z.object({ type: z.literal('connection-changed'), data: z.object({ status: z.string(), subscriptionId: z.string().optional(), resume: z.enum(['ok', 'gap']).optional() }).optional() }),
    z.object({ type: z.literal('toast'), data: z.object({ title: z.string().max(2048), body: z.string().max(32_768), sessionId: z.string().min(1).max(256), url: z.string().max(8192) }) }),
]);

export const machineSchema = z.object({
    id: z.string(), active: z.boolean(), activeAt: timestamp,
    metadata: z.object({ host: z.string().optional(), displayName: z.string().optional(), platform: z.string().optional() }).passthrough().nullable(),
}).passthrough();
export type HapiMachine = z.infer<typeof machineSchema>;
