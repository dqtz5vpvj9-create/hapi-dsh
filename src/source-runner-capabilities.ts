/** Original HAPI runner-capability contract, pinned at 0f8ef697 (AGPL-3.0-only). */
export const REQUIRED_MACHINE_CAPABILITIES = ['agent-availability', 'cursor-chat-store-status'] as const;

/** A version label alone cannot say whether the Runner implements the required RPCs. */
export function missingRequiredCapabilities(advertised: readonly string[] | null | undefined): string[] {
    const capabilities = new Set(advertised ?? []);
    return REQUIRED_MACHINE_CAPABILITIES.filter(capability => !capabilities.has(capability));
}

/** A different installed binary includes a rollback, not just a newer modification time. */
export function cliBinaryUpdatedOnDisk(metadata: {
    startedCliMtimeMs?: unknown; installedCliMtimeMs?: unknown;
} | null | undefined): boolean {
    const started = metadata?.startedCliMtimeMs, installed = metadata?.installedCliMtimeMs;
    return typeof started === 'number' && typeof installed === 'number'
        && Number.isFinite(started) && Number.isFinite(installed) && started !== installed;
}

export function listSkewedMachines<T extends { online: boolean; capabilities: readonly string[] }>(machines: readonly T[]): T[] {
    return machines.filter(machine => machine.online && missingRequiredCapabilities(machine.capabilities).length > 0);
}
