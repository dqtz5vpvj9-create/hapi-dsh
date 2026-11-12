/** Browser-safe application notifications and the existing source-provider contracts. */
import { z } from 'zod';
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import { APP_NOTIFICATIONS_WORKER_PATH, APP_NOTIFICATIONS_STREAM_PATH, appAccountScopeSchema, appNotificationTargetSchema,
    pushEndpointSchema as endpointSchema, pushSubscriptionSchema as subscriptionSchema } from './workspace/app-service-types.ts';

export const NOTIFICATIONS_WORKER_PATH = APP_NOTIFICATIONS_WORKER_PATH;
export const NOTIFICATIONS_STREAM_PATH = APP_NOTIFICATIONS_STREAM_PATH;
export const NOTIFICATION_LEASE_MS = 30_000;
export const NOTIFICATION_HEARTBEAT_MS = 10_000;
export const APP_NOTIFICATION_TITLE_LIMIT = 256;
export const APP_NOTIFICATION_BODY_LIMIT = 1024;

/** New application notifications preserve exact native targets independently of any source provider. */
export const appNotificationSchema = z.strictObject({
    id: z.string().min(1).max(2048), scope: appAccountScopeSchema,
    kind: z.enum(['completed', 'failed', 'request']), target: appNotificationTargetSchema,
    title: z.string().max(APP_NOTIFICATION_TITLE_LIMIT), body: z.string().max(APP_NOTIFICATION_BODY_LIMIT), createdAt: z.number().int().nonnegative(),
}).refine(notification => (notification.kind === 'request') === (notification.target.kind === 'request'),
    'A request notification must preserve its exact original request target');
export type AppNotification = z.infer<typeof appNotificationSchema>;

/** Push and URL navigation carry only a server-stored notification reference. */
export const appNotificationReferenceSchema = z.strictObject({ type: z.literal('app-notification'),
    notificationId: z.string().min(1).max(2048), scope: appAccountScopeSchema, deviceId: z.string().min(1).max(2048) });
export type AppNotificationReference = z.infer<typeof appNotificationReferenceSchema>;
export const appNotificationFrameSchema = z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('ready'), scope: appAccountScopeSchema, deviceId: z.string().min(1).max(2048) }),
    z.strictObject({ type: z.literal('status'), connected: z.boolean(), syncState: z.enum(['connecting', 'watching', 'recovering', 'denied']).optional(), error: z.string().max(2048).optional() }),
    z.strictObject({ type: z.literal('notification'), notification: appNotificationSchema }),
]);
export type AppNotificationsApi = Pick<import('./workspace/app-service-types.ts').AppServiceApi,
    'appNotificationSettings' | 'appPushSubscribe' | 'appPushUnsubscribe' | 'appNotificationResolve'>;

export const notificationSettingsSchema = z.object({
    hubId: z.string().min(1).max(256), vapidPublicKey: z.string().min(1).max(512).nullable(), pushError: z.string().max(2048).optional(),
    workerPath: z.literal(NOTIFICATIONS_WORKER_PATH), streamPath: z.literal(NOTIFICATIONS_STREAM_PATH),
});
export const sourceNotificationSchema = z.object({
    id: z.string().min(1).max(256), hubId: z.string().min(1).max(256),
    title: z.string().max(2048), body: z.string().max(32_768),
    sessionId: z.string().min(1).max(256), createdAt: z.number().int().nonnegative(),
    messageId: z.string().min(1).max(256).optional(), requestId: z.string().min(1).max(256).optional(),
});
export const notificationPresenceSchema = z.object({ type: z.literal('presence'), visibility: z.enum(['visible', 'hidden']) }).strict();
export const notificationFrameSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('ready'), hubId: z.string().min(1).max(256), heartbeatMs: z.literal(NOTIFICATION_HEARTBEAT_MS), leaseMs: z.literal(NOTIFICATION_LEASE_MS) }),
    z.object({ type: z.literal('toast'), notification: sourceNotificationSchema }),
    z.object({ type: z.literal('status'), connected: z.boolean(), visibility: z.enum(['visible', 'hidden']), error: z.string().max(2048).optional() }),
]);
export type NotificationSettings = z.infer<typeof notificationSettingsSchema>;
export type SourceNotification = z.infer<typeof sourceNotificationSchema>;
export type SourceNotificationTarget = Pick<SourceNotification, 'hubId' | 'sessionId' | 'messageId' | 'requestId'>;
export type NotificationFrame = z.infer<typeof notificationFrameSchema>;
export type SourcePushSubscription = z.infer<typeof subscriptionSchema>;

export const notificationInputs = {
    sourceNotificationSettings: z.object({}).strict(),
    sourcePushSubscribe: subscriptionSchema,
    sourcePushUnsubscribe: z.object({ endpoint: endpointSchema }).strict(),
} as const;
export const notificationOutputs = {
    sourceNotificationSettings: notificationSettingsSchema,
    sourcePushSubscribe: z.object({ subscribed: z.literal(true) }),
    sourcePushUnsubscribe: z.object({ unsubscribed: z.literal(true) }),
} as const;
export type NotificationMethod = keyof typeof notificationInputs;
export type NotificationRequest<K extends NotificationMethod> = z.input<(typeof notificationInputs)[K]>;
export type NotificationResponse<K extends NotificationMethod> = z.output<(typeof notificationOutputs)[K]>;
export type SourceNotificationsApi = {
    [K in NotificationMethod]: (request: NotificationRequest<K>, signal?: AbortSignal) => Promise<RemoteResult<NotificationResponse<K>>>;
};
