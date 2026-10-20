import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { withFileLock } from '@deepseek-ai/dsh-atomic-write';
import { readPrivateJson, writePrivateJson } from '../cli/config.ts';
import { validMachineId } from '../runner/protocol.ts';

export interface PairedMachine { id: string; name: string; tokenHash: string; createdAt: number }
export interface PairingStore { version: 1; machines: PairedMachine[] }

export async function readPairingStore(path: string): Promise<PairingStore> {
    let value: unknown;
    try { value = await readPrivateJson(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, machines: [] }; throw error; }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid Runner pairing store');
    const store = value as Partial<PairingStore>;
    if (store.version !== 1 || !Array.isArray(store.machines) || store.machines.length > 256) throw new Error('Invalid Runner pairing store');
    const seen = new Set<string>();
    for (const machine of store.machines) {
        if (!machine || !validMachineId(machine.id) || seen.has(machine.id) || typeof machine.name !== 'string'
            || machine.name.length === 0 || machine.name.length > 128 || !/^[a-f0-9]{64}$/.test(machine.tokenHash)
            || !Number.isSafeInteger(machine.createdAt)) throw new Error('Invalid Runner pairing entry');
        seen.add(machine.id);
    }
    return store as PairingStore;
}

export function hashPairingToken(token: string): string { return createHash('sha256').update(token).digest('hex'); }

export function matchesPairingToken(token: string, hash: string): boolean {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token) || !/^[a-f0-9]{64}$/.test(hash)) return false;
    return timingSafeEqual(Buffer.from(hashPairingToken(token), 'hex'), Buffer.from(hash, 'hex'));
}

/** Tokens leave this function only for writing the recipient's private Runner config. */
export async function addPairing(path: string, id: string, name: string): Promise<string> {
    return withPairingLock(path, async () => {
        const store = await readPairingStore(path);
        if (!validMachineId(id) || name.length === 0 || name.length > 128) throw new Error('Invalid machine identity or name');
        if (store.machines.some((machine) => machine.id === id)) throw new Error('Machine is already paired; revoke it before replacing its credential');
        if (store.machines.length >= 256) throw new Error('Pairing store has reached its machine limit');
        const token = randomBytes(32).toString('base64url');
        store.machines.push({ id, name, tokenHash: hashPairingToken(token), createdAt: Date.now() });
        await writePrivateJson(path, store, true);
        return token;
    });
}

export async function revokePairing(path: string, id: string): Promise<void> {
    await withPairingLock(path, async () => {
        const store = await readPairingStore(path);
        if (!store.machines.some((machine) => machine.id === id)) throw new Error('Machine is not paired');
        store.machines = store.machines.filter((machine) => machine.id !== id);
        await writePrivateJson(path, store, true);
    });
}

async function withPairingLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    return withFileLock(path, operation);
}
