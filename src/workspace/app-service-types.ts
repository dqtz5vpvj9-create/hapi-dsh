/** Application-owned contracts carried by the authenticated Host gateway, outside HHPI v1. */
import { z } from 'zod';
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import type { SourceRoute } from '../shared/source-capability.ts';
import { sourceSessionId } from '../remote/protocol.ts';

const id = z.string().min(1).max(2048).refine(value => !value.includes('\0'));
const sequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const APP_NOTIFICATIONS_WORKER_PATH = '/hapi-dsh/notifications-worker.js';
export const APP_NOTIFICATIONS_STREAM_PATH = '/hapi-dsh/notifications';

/** Origin is a partition, not a URL to fetch. HTTP is only available for local development. */
export const appOriginSchema = z.string().max(2048).refine(value => {
    try {
        const url = new URL(value);
        return value === url.origin && (url.protocol === 'https:' || (url.protocol === 'http:'
            && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)));
    } catch { return false; }
}, 'A canonical secure application origin is required');

/** The server derives this scope from its authenticated account and admitted application origin. */
export const appAccountScopeSchema = z.strictObject({ accountId: id, origin: appOriginSchema });
export type AppAccountScope = z.infer<typeof appAccountScopeSchema>;
export const appDeviceSchema = z.strictObject({ scope: appAccountScopeSchema, deviceId: id });
export type AppDevice = z.infer<typeof appDeviceSchema>;

const identity = z.strictObject({ machineId: id, sourceId: id, engine: id, nativeId: id });
/** These selectors require server authorization; a browser-supplied hostId grants no access. */
export const appSourceRouteSchema = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('local-dsh'), hostId: id, sessionId: id }),
    z.strictObject({ kind: z.literal('federated-dsh'), hostId: id, sessionId: id }),
    z.strictObject({ kind: z.literal('hhpi'), hostId: id, sessionId: id, identity }),
]).superRefine((route, ctx) => {
    if (route.kind === 'hhpi' && route.sessionId !== sourceSessionId(route.identity)) {
        ctx.addIssue({ code: 'custom', path: ['sessionId'], message: 'The source session must match its complete native identity' });
    }
    if (route.kind !== 'hhpi' && route.sessionId.startsWith('hhpi:')) {
        ctx.addIssue({ code: 'custom', path: ['sessionId'], message: 'An HHPI identity cannot use a DSH route' });
    }
});
export type AppSourceRoute = z.infer<typeof appSourceRouteSchema>;

/** Actual reader watermarks use committed original event coordinates. */
export const appReadPositionSchema = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('dsh'), seq: sequence, messageId: id.optional() }),
    z.strictObject({ kind: z.literal('hhpi'), epoch: id, seq: sequence, messageId: id.optional() }),
]);
export type AppReadPosition = z.infer<typeof appReadPositionSchema>;
/** Coordinates belong to the original source, never to a display projection or a focused pane. */
export const appEventPositionSchema = z.discriminatedUnion('kind', [
    ...appReadPositionSchema.options,
    /** A native notification can identify a turn before its reading projection exists. */
    z.strictObject({ kind: z.literal('native'), turnId: id, itemId: id.optional() }),
]);
export type AppEventPosition = z.infer<typeof appEventPositionSchema>;
const sessionTarget = z.strictObject({ kind: z.literal('session'), source: appSourceRouteSchema });
const readingTarget = z.strictObject({ kind: z.literal('reading'), source: appSourceRouteSchema, position: appEventPositionSchema });
const requestTarget = z.strictObject({ kind: z.literal('request'), source: appSourceRouteSchema, position: appEventPositionSchema, requestId: id });
function sourcePositionMatches(target: { source: AppSourceRoute; position?: AppEventPosition }, ctx: z.RefinementCtx): void {
    if (target.position && (target.source.kind === 'hhpi') !== (target.position.kind !== 'dsh')) {
        ctx.addIssue({ code: 'custom', path: ['position'], message: 'The position must use the original source coordinate system' });
    }
}
export const appTargetSchema = z.discriminatedUnion('kind', [sessionTarget, readingTarget, requestTarget]).superRefine(sourcePositionMatches);
export const appNotificationTargetSchema = z.discriminatedUnion('kind', [readingTarget, requestTarget]).superRefine(sourcePositionMatches);
export const appShareTargetSchema = z.discriminatedUnion('kind', [sessionTarget, readingTarget]).superRefine(sourcePositionMatches);
export type AppTarget = z.infer<typeof appTargetSchema>;
export type AppNotificationTarget = z.infer<typeof appNotificationTargetSchema>;
export type AppShareTarget = z.infer<typeof appShareTargetSchema>;

export const pushEndpointSchema = z.string().min(1).max(8192).superRefine((value, ctx) => {
    try {
        const url = new URL(value);
        if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('invalid');
    } catch { ctx.addIssue({ code: 'custom', message: 'A browser-issued HTTPS Push endpoint is required' }); }
});
/** Browser subscription capabilities and keys belong in server storage, never in settings responses. */
export const pushSubscriptionSchema = z.strictObject({ endpoint: pushEndpointSchema, keys: z.strictObject({
    p256dh: z.string().min(32).max(256).regex(/^[A-Za-z0-9_-]+=*$/u),
    auth: z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+=*$/u),
}) });
export const appPushSubscriptionSchema = pushSubscriptionSchema.extend({ expirationTime: timestamp.nullable().optional() });
export const appPushRegistrationSchema = z.strictObject({ scope: appAccountScopeSchema, deviceId: id,
    subscription: appPushSubscriptionSchema, updatedAt: timestamp });
export type AppPushRegistration = z.infer<typeof appPushRegistrationSchema>;

export const appReadIntentSchema = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('seen'), position: appReadPositionSchema, at: timestamp }),
    z.strictObject({ kind: z.literal('unread'), at: timestamp }),
]);
export type AppReadIntent = z.infer<typeof appReadIntentSchema>;
export const appReadStateSchema = z.strictObject({ scope: appAccountScopeSchema, source: appSourceRouteSchema,
    revision: sequence, seen: z.strictObject({ position: appReadPositionSchema, at: timestamp }).nullable(),
    manualUnreadAt: timestamp.nullable(), lastOperationId: id.nullable(),
}).superRefine((state, ctx) => sourcePositionMatches({ source: state.source, ...(state.seen ? { position: state.seen.position } : {}) }, ctx));
export type AppReadState = z.infer<typeof appReadStateSchema>;
const readWrite = z.strictObject({ deviceId: id, source: appSourceRouteSchema, expectedRevision: sequence, operationId: id,
    intent: appReadIntentSchema,
}).superRefine((request, ctx) => sourcePositionMatches({ source: request.source,
    ...(request.intent.kind === 'seen' ? { position: request.intent.position } : {}) }, ctx));

/** Sharing preserves an account-scoped target; it does not publish a public bearer URL. */
export const appShareRecordSchema = z.strictObject({ id, scope: appAccountScopeSchema, target: appShareTargetSchema,
    visibility: z.literal('account'), createdAt: timestamp });
export type AppShareRecord = z.infer<typeof appShareRecordSchema>;

export const appServiceInputs = {
    appNotificationSettings: z.strictObject({ deviceId: id }),
    appPushSubscribe: z.strictObject({ deviceId: id, subscription: appPushSubscriptionSchema }),
    appPushUnsubscribe: z.strictObject({ deviceId: id, endpoint: pushEndpointSchema }),
    /** The Host loads the stored target and rechecks source access; callers cannot replace it. */
    appNotificationResolve: z.strictObject({ deviceId: id, notificationId: id }),
    appReadState: z.strictObject({ source: appSourceRouteSchema }),
    appReadStates: z.strictObject({ sources: z.array(appSourceRouteSchema).max(200) }),
    /** A conflict returns current state; a stale write must not overwrite a newer user intent. */
    appReadStateWrite: readWrite,
    appShareCreate: z.strictObject({ deviceId: id, target: appShareTargetSchema }),
    appShareResolve: z.strictObject({ shareId: id }),
} as const;
export const appServiceOutputs = {
    appNotificationSettings: z.strictObject({ scope: appAccountScopeSchema, deviceId: id, vapidPublicKey: z.string().min(1).max(512).nullable(),
        pushError: z.string().max(2048).optional(), workerPath: z.literal(APP_NOTIFICATIONS_WORKER_PATH), streamPath: z.literal(APP_NOTIFICATIONS_STREAM_PATH) }),
    appPushSubscribe: z.strictObject({ subscribed: z.literal(true) }),
    appPushUnsubscribe: z.strictObject({ unsubscribed: z.literal(true) }),
    appNotificationResolve: z.strictObject({ target: appNotificationTargetSchema, requestState: z.enum(['pending', 'settled']).optional() })
        .refine(result => (result.target.kind === 'request') === (result.requestState !== undefined), 'An exact request target requires its current settlement state'),
    appReadState: appReadStateSchema.nullable(),
    appReadStates: z.array(appReadStateSchema.nullable()).max(200),
    appReadStateWrite: z.strictObject({ applied: z.boolean(), state: appReadStateSchema }),
    appShareCreate: appShareRecordSchema,
    appShareResolve: appShareRecordSchema,
} as const;
export type AppServiceMethod = keyof typeof appServiceInputs;
export type AppServiceRequest<K extends AppServiceMethod> = z.input<(typeof appServiceInputs)[K]>;
export type AppServiceResponse<K extends AppServiceMethod> = z.output<(typeof appServiceOutputs)[K]>;
export type AppServiceApi = {
    [K in AppServiceMethod]: (request: AppServiceRequest<K>, signal?: AbortSignal) => Promise<RemoteResult<AppServiceResponse<K>>>;
};

/** Exact tuple keys partition storage without hashes. Keys are not authorization evidence. */
export function appScopeKey(scope: AppAccountScope): string { return JSON.stringify([scope.accountId, scope.origin]); }
export function appDeviceKey(scope: AppAccountScope, deviceId: string): string { return JSON.stringify([scope.accountId, scope.origin, deviceId]); }
export function appSourceKey(scope: AppAccountScope, source: SourceRoute): string {
    return JSON.stringify([scope.accountId, scope.origin, source.hostId, source.kind, source.sessionId]);
}
export interface AppServiceContext {
    /** Obtained after the existing gateway/connection authorization, never parsed from request JSON. */
    scope: AppAccountScope;
    /** Resolve the exact original binding and enforce the existing Host/source ACL; reject by throwing. */
    authorizeSource(source: AppSourceRoute): void | Promise<void>;
}
export async function authorizeAppTarget(context: AppServiceContext, value: AppTarget): Promise<AppTarget> {
    const target = appTargetSchema.parse(value);
    await context.authorizeSource(target.source);
    return target;
}
/** Persisted targets must pass their account/origin boundary before accessing any source. */
export async function authorizeAppRecord<T extends { scope: AppAccountScope; target: AppTarget }>(context: AppServiceContext, record: T): Promise<T> {
    if (context.scope.accountId !== record.scope.accountId || context.scope.origin !== record.scope.origin) throw new Error('The application resource belongs to another account or origin');
    await authorizeAppTarget(context, record.target);
    return record;
}
