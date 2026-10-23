import { rename } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';

/** Windows can briefly hold the destination while the running Host reads pairing policy. */
export async function replacePrivateFile(source: string, destination: string,
    move: typeof rename = rename, platform: NodeJS.Platform = process.platform): Promise<void> {
    for (let attempt = 0; ; attempt++) {
        try { await move(source, destination); return; }
        catch (error) {
            if (platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '') || attempt >= 8) throw error;
        }
        // Keep the complete, fsynced temporary file as the atomic rename source.
        // Never unlink the existing credential file to work around a sharing violation.
        await setTimeout(Math.min(20 * 2 ** attempt, 200));
    }
}
