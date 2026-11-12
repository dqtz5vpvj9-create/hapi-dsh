/** Private application notification state. SQLite owns uniqueness and atomic lifecycle changes. */
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { appNotificationSchema, type AppNotification } from '../notification-types.ts';
import { appPushRegistrationSchema, type AppAccountScope, type AppPushRegistration } from './app-service-types.ts';

export type NotificationDeliveryState = 'pending' | 'sending' | 'submitted' | 'failed' | 'cancelled';
export type NotificationDeliveryReason = 'revoked' | 'expired' | 'source-revoked' | 'scope-revoked' | 'rejected' | 'retry-exhausted' | 'payload-too-large';
export interface NotificationDelivery {
    notificationId: string; deviceId: string; state: NotificationDeliveryState; attempts: number;
    nextAttemptAt: number | null; submittedAt: number | null; reason: NotificationDeliveryReason | null;
}
export interface NotificationClaim {
    claimId: string; registrationId: string; notification: AppNotification; registration: AppPushRegistration;
    expiresAt: number; attempts: number;
}
type Row = Record<string, string | number | null>;

export class NotificationStore {
    private readonly db: DatabaseSync;
    constructor(path: string) {
        if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        this.db = new DatabaseSync(path);
        if (path !== ':memory:') chmodSync(path, 0o600);
        this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
            CREATE TABLE IF NOT EXISTS app_push_subscriptions (
                account_id TEXT NOT NULL, origin TEXT NOT NULL, device_id TEXT NOT NULL,
                registration_id TEXT UNIQUE NOT NULL, endpoint TEXT NOT NULL, payload TEXT NOT NULL, expires_at INTEGER,
                PRIMARY KEY(account_id,origin,device_id), UNIQUE(origin,endpoint));
            CREATE INDEX IF NOT EXISTS app_push_expiration ON app_push_subscriptions(expires_at);
            CREATE TABLE IF NOT EXISTS app_notifications (
                account_id TEXT NOT NULL, origin TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL,
                created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY(account_id,origin,id));
            CREATE INDEX IF NOT EXISTS app_notification_expiration ON app_notifications(expires_at);
            CREATE TABLE IF NOT EXISTS app_notification_deliveries (
                account_id TEXT NOT NULL, origin TEXT NOT NULL, notification_id TEXT NOT NULL, device_id TEXT NOT NULL,
                registration_id TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL,
                next_attempt_at INTEGER, submitted_at INTEGER, lease_until INTEGER, claim_id TEXT, reason TEXT,
                PRIMARY KEY(account_id,origin,notification_id,device_id),
                FOREIGN KEY(account_id,origin,notification_id) REFERENCES app_notifications(account_id,origin,id) ON DELETE CASCADE);
            CREATE TABLE IF NOT EXISTS app_notification_presentations (
                account_id TEXT NOT NULL, origin TEXT NOT NULL, notification_id TEXT NOT NULL, device_id TEXT NOT NULL,
                PRIMARY KEY(account_id,origin,notification_id,device_id),
                FOREIGN KEY(account_id,origin,notification_id) REFERENCES app_notifications(account_id,origin,id) ON DELETE CASCADE);
            CREATE INDEX IF NOT EXISTS app_notification_due ON app_notification_deliveries(state,next_attempt_at,lease_until);
            CREATE INDEX IF NOT EXISTS app_notification_registration ON app_notification_deliveries(registration_id);`);
    }
    private transaction<T>(action: () => T): T {
        this.db.exec('BEGIN IMMEDIATE');
        try { const result = action(); this.db.exec('COMMIT'); return result; }
        catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }
    private cancelRegistration(registrationId: string, reason: NotificationDeliveryReason): void {
        this.db.prepare(`UPDATE app_notification_deliveries SET state='cancelled',reason=?,next_attempt_at=NULL,lease_until=NULL,claim_id=NULL
            WHERE registration_id=? AND state IN ('pending','sending')`).run(reason, registrationId);
        this.db.prepare('DELETE FROM app_push_subscriptions WHERE registration_id=?').run(registrationId);
    }
    private clean(now: number): void {
        const expired = this.db.prepare('SELECT registration_id FROM app_push_subscriptions WHERE expires_at IS NOT NULL AND expires_at<=?').all(now);
        for (const row of expired) this.cancelRegistration(String(row.registration_id), 'expired');
        this.db.prepare('DELETE FROM app_notifications WHERE expires_at<=?').run(now);
    }
    cleanup(now: number): void { this.transaction(() => this.clean(now)); }

    /** A real browser endpoint cannot remain attached to a previous account at this origin. */
    subscribe(value: AppPushRegistration, maxSubscriptions: number): string[] {
        const registration = appPushRegistrationSchema.parse(value);
        return this.transaction(() => {
            this.clean(registration.updatedAt);
            const { accountId, origin } = registration.scope;
            const previous = this.db.prepare(`SELECT * FROM app_push_subscriptions WHERE origin=? AND
                (endpoint=? OR (account_id=? AND device_id=?))`).all(origin, registration.subscription.endpoint, accountId, registration.deviceId) as Row[];
            const same = previous.find(row => row.account_id === accountId && row.device_id === registration.deviceId
                && JSON.stringify((JSON.parse(String(row.payload)) as AppPushRegistration).subscription) === JSON.stringify(registration.subscription));
            if (same && previous.length === 1) {
                this.db.prepare('UPDATE app_push_subscriptions SET payload=? WHERE registration_id=?').run(JSON.stringify(registration), String(same.registration_id));
                return [];
            }
            const retired = previous.map(row => String(row.registration_id));
            for (const registrationId of retired) this.cancelRegistration(registrationId, 'revoked');
            const count = Number(this.db.prepare('SELECT COUNT(*) AS n FROM app_push_subscriptions WHERE account_id=? AND origin=?').get(accountId, origin)!.n);
            if (count >= maxSubscriptions) throw new Error('This account has reached its browser notification limit');
            this.db.prepare('INSERT INTO app_push_subscriptions VALUES(?,?,?,?,?,?,?)').run(accountId, origin, registration.deviceId,
                randomUUID(), registration.subscription.endpoint, JSON.stringify(registration), registration.subscription.expirationTime ?? null);
            return retired;
        });
    }
    unsubscribe(scope: AppAccountScope, deviceId: string, endpoint: string): string[] {
        return this.transaction(() => {
            const row = this.db.prepare('SELECT registration_id FROM app_push_subscriptions WHERE account_id=? AND origin=? AND device_id=? AND endpoint=?')
                .get(scope.accountId, scope.origin, deviceId, endpoint);
            if (!row) return [];
            const id = String(row.registration_id); this.cancelRegistration(id, 'revoked'); return [id];
        });
    }
    revokeScope(scope: AppAccountScope): string[] {
        return this.transaction(() => {
            const rows = this.db.prepare('SELECT registration_id FROM app_push_subscriptions WHERE account_id=? AND origin=?').all(scope.accountId, scope.origin);
            const ids = rows.map(row => String(row.registration_id));
            for (const id of ids) this.cancelRegistration(id, 'revoked');
            return ids;
        });
    }
    subscriptions(scope: AppAccountScope, now: number): AppPushRegistration[] {
        return this.db.prepare('SELECT payload FROM app_push_subscriptions WHERE account_id=? AND origin=? AND (expires_at IS NULL OR expires_at>?)')
            .all(scope.accountId, scope.origin, now).map(row => appPushRegistrationSchema.parse(JSON.parse(String(row.payload))));
    }

    enqueue(value: AppNotification, now: number, retentionMs: number, maxNotifications: number): { created: boolean; queued: number } {
        const notification = appNotificationSchema.parse(value);
        return this.transaction(() => {
            this.clean(now);
            const { accountId, origin } = notification.scope, payload = JSON.stringify(notification);
            const previous = this.db.prepare('SELECT payload FROM app_notifications WHERE account_id=? AND origin=? AND id=?').get(accountId, origin, notification.id);
            if (previous) {
                if (previous.payload !== payload) throw new Error('The notification identity already belongs to another event');
                return { created: false, queued: 0 };
            }
            const expiresAt = notification.createdAt + retentionMs;
            if (expiresAt <= now) return { created: false, queued: 0 };
            this.db.prepare('INSERT INTO app_notifications VALUES(?,?,?,?,?,?)').run(accountId, origin, notification.id, payload, notification.createdAt, expiresAt);
            const queued = this.db.prepare(`INSERT INTO app_notification_deliveries
                (account_id,origin,notification_id,device_id,registration_id,state,attempts,next_attempt_at)
                SELECT account_id,origin,?,device_id,registration_id,'pending',0,? FROM app_push_subscriptions
                WHERE account_id=? AND origin=? AND (expires_at IS NULL OR expires_at>?)`).run(notification.id, now, accountId, origin, now).changes;
            this.db.prepare(`DELETE FROM app_notifications WHERE account_id=? AND origin=? AND id IN
                (SELECT id FROM app_notifications WHERE account_id=? AND origin=? ORDER BY created_at DESC,id DESC LIMIT -1 OFFSET ?)`)
                .run(accountId, origin, accountId, origin, maxNotifications);
            return { created: true, queued: Number(queued) };
        });
    }
    /** A foreground browser need not subscribe to Push to open a notification it received. */
    presented(scope: AppAccountScope, id: string, deviceId: string): void {
        this.db.prepare(`INSERT OR IGNORE INTO app_notification_presentations
            SELECT account_id,origin,id,? FROM app_notifications WHERE account_id=? AND origin=? AND id=?`)
            .run(deviceId, scope.accountId, scope.origin, id);
    }
    notification(scope: AppAccountScope, id: string, deviceId?: string): AppNotification | null {
        const row = deviceId === undefined
            ? this.db.prepare('SELECT payload FROM app_notifications WHERE account_id=? AND origin=? AND id=?').get(scope.accountId, scope.origin, id)
            : this.db.prepare(`SELECT n.payload FROM app_notifications n
                WHERE n.account_id=? AND n.origin=? AND n.id=? AND (
                    EXISTS (SELECT 1 FROM app_notification_deliveries d WHERE d.account_id=n.account_id AND d.origin=n.origin AND d.notification_id=n.id AND d.device_id=?) OR
                    EXISTS (SELECT 1 FROM app_notification_presentations p WHERE p.account_id=n.account_id AND p.origin=n.origin AND p.notification_id=n.id AND p.device_id=?))`)
                .get(scope.accountId, scope.origin, id, deviceId, deviceId);
        return row ? appNotificationSchema.parse(JSON.parse(String(row.payload))) : null;
    }
    deliveries(scope: AppAccountScope, id: string): NotificationDelivery[] {
        return this.db.prepare('SELECT * FROM app_notification_deliveries WHERE account_id=? AND origin=? AND notification_id=? ORDER BY device_id')
            .all(scope.accountId, scope.origin, id).map(row => ({ notificationId: String(row.notification_id), deviceId: String(row.device_id),
                state: String(row.state) as NotificationDeliveryState, attempts: Number(row.attempts), nextAttemptAt: row.next_attempt_at as number | null,
                submittedAt: row.submitted_at as number | null, reason: row.reason as NotificationDeliveryReason | null }));
    }
    claimDue(now: number, limit: number, leaseMs: number, maxAttempts: number): NotificationClaim[] {
        return this.transaction(() => {
            this.clean(now);
            this.db.prepare(`UPDATE app_notification_deliveries SET state='failed',reason='retry-exhausted',next_attempt_at=NULL,lease_until=NULL,claim_id=NULL
                WHERE attempts>=? AND ((state='pending' AND next_attempt_at<=?) OR (state='sending' AND lease_until<=?))`).run(maxAttempts, now, now);
            const rows = this.db.prepare(`SELECT d.*,n.payload AS notification,n.expires_at AS notification_expires,s.payload AS registration
                FROM app_notification_deliveries d JOIN app_notifications n ON n.account_id=d.account_id AND n.origin=d.origin AND n.id=d.notification_id
                JOIN app_push_subscriptions s ON s.registration_id=d.registration_id
                WHERE (d.state='pending' AND d.next_attempt_at<=?) OR (d.state='sending' AND d.lease_until<=?)
                ORDER BY d.next_attempt_at,n.created_at LIMIT ?`).all(now, now, limit) as Row[];
            return rows.map(row => {
                const claimId = randomUUID(), attempts = Number(row.attempts) + 1;
                this.db.prepare(`UPDATE app_notification_deliveries SET state='sending',attempts=?,claim_id=?,lease_until=?,next_attempt_at=NULL
                    WHERE account_id=? AND origin=? AND notification_id=? AND device_id=?`).run(attempts, claimId, now + leaseMs,
                    String(row.account_id), String(row.origin), String(row.notification_id), String(row.device_id));
                return { claimId, registrationId: String(row.registration_id), notification: appNotificationSchema.parse(JSON.parse(String(row.notification))),
                    registration: appPushRegistrationSchema.parse(JSON.parse(String(row.registration))), expiresAt: Number(row.notification_expires), attempts };
            });
        });
    }
    isCurrent(claim: NotificationClaim, now: number): boolean {
        return this.db.prepare(`SELECT 1 FROM app_notification_deliveries d JOIN app_push_subscriptions s ON s.registration_id=d.registration_id
            WHERE d.claim_id=? AND d.state='sending' AND (s.expires_at IS NULL OR s.expires_at>?)`).get(claim.claimId, now) !== undefined;
    }
    settle(claim: NotificationClaim, state: NotificationDeliveryState, now: number,
        reason: NotificationDeliveryReason | null = null, nextAttemptAt: number | null = null): void {
        this.db.prepare(`UPDATE app_notification_deliveries SET state=?,reason=?,next_attempt_at=?,submitted_at=?,lease_until=NULL,claim_id=NULL
            WHERE claim_id=? AND registration_id=? AND state='sending'`).run(state, reason, nextAttemptAt, state === 'submitted' ? now : null, claim.claimId, claim.registrationId);
    }
    expireRegistration(claim: NotificationClaim): void { this.transaction(() => this.cancelRegistration(claim.registrationId, 'expired')); }
    close(): void { this.db.close(); }
}
