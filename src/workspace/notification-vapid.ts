/** Private application-owned Push keys; no HAPI key or browser credential is reused. */
import { mkdir, readFile, open, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { withFileLock } from '@deepseek-ai/dsh-atomic-write';
import webPush from 'web-push';
import { z } from 'zod';
import { replacePrivateFile } from '../shared/atomic-rename.ts';
import { createWebPushTransport, type AppPushTransport } from './notification-service.ts';
const keys = z.strictObject({ publicKey: z.string().min(1), privateKey: z.string().min(1) });
export async function applicationPushTransport(directory: string, origin: string): Promise<AppPushTransport | undefined> {
    if (!origin.startsWith('https://')) return;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, 'vapid.json');
    const value = await withFileLock(path, async () => {
        try { return keys.parse(JSON.parse(await readFile(path, 'utf8'))); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            const generated = webPush.generateVAPIDKeys();
            const temporary = join(directory, `vapid-${randomUUID()}.json`);
            try {
                const file = await open(temporary, 'wx', 0o600);
                try { await file.writeFile(JSON.stringify(generated)); await file.sync(); }
                finally { await file.close(); }
                await replacePrivateFile(temporary, path);
            }
            finally { await rm(temporary, { force: true }); }
            return generated;
        }
    });
    return createWebPushTransport((subscription, payload, options) => webPush.sendNotification(
        { endpoint: subscription.endpoint, keys: subscription.keys }, payload, options), { subject: origin, ...value });
}
