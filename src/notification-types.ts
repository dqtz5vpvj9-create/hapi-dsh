/** Browser-safe original HAPI Web Push contracts; no long-lived authentication is returned. */
import { z } from 'zod';
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol';

export const NOTIFICATIONS_WORKER_PATH = '/hapi-dsh/notifications-worker.js';
export const NOTIFICATIONS_STREAM_PATH = '/hapi-dsh/notifications';
export const NOTIFICATION_LEASE_MS = 30_000;
export const NOTIFICATION_HEARTBEAT_MS = 10_000;

const endpointSchema = z.string().min(1).max(8192).superRefine((value, ctx) => {
    try {
        const url = new URL(value);
        if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('invalid');
    } catch { ctx.addIssue({ code: 'custom', message: 'A browser-issued HTTPS Push endpoint is required' }); }
});
const subscriptionSchema = z.object({ endpoint: endpointSchema, keys: z.object({
    p256dh: z.string().min(32).max(256).regex(/^[A-Za-z0-9_-]+=*$/u),
    auth: z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+=*$/u),
}).strict() }).strict();

export const notificationSettingsSchema = z.object({
    hubId: z.string().min(1).max(256), vapidPublicKey: z.string().min(1).max(512).nullable(), pushError: z.string().max(2048).optional(),
    workerPath: z.literal(NOTIFICATIONS_WORKER_PATH), streamPath: z.literal(NOTIFICATIONS_STREAM_PATH),
});
export const sourceNotificationSchema = z.object({
    id: z.string().min(1).max(256), hubId: z.string().min(1).max(256),
    title: z.string().max(2048), body: z.string().max(32_768),
    sessionId: z.string().min(1).max(256), createdAt: z.number().int().nonnegative(),
});
export const notificationPresenceSchema = z.object({ type: z.literal('presence'), visibility: z.enum(['visible', 'hidden']) }).strict();
export const notificationFrameSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('ready'), hubId: z.string().min(1).max(256), heartbeatMs: z.literal(NOTIFICATION_HEARTBEAT_MS), leaseMs: z.literal(NOTIFICATION_LEASE_MS) }),
    z.object({ type: z.literal('toast'), notification: sourceNotificationSchema }),
    z.object({ type: z.literal('status'), connected: z.boolean(), visibility: z.enum(['visible', 'hidden']), error: z.string().max(2048).optional() }),
]);
export type NotificationSettings = z.infer<typeof notificationSettingsSchema>;
export type SourceNotification = z.infer<typeof sourceNotificationSchema>;
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
