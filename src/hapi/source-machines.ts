import type { CatalogMachine } from '../client-api.ts'
import { sourceMachineHealthSchema, type SourceMachineHealth } from '../source-machine-types.ts'
import type { HapiMachine } from './schemas.ts'

/** Keep only advertised source metrics; a missing/invalid sample is not zero. */
export function sourceMachineHealth(value: unknown): SourceMachineHealth | null {
    const result = sourceMachineHealthSchema.safeParse(value)
    return result.success ? result.data : null
}

export function catalogSourceMachine(machine: HapiMachine, connected: boolean): CatalogMachine {
    const metadata = machine.metadata
    return { id: machine.id, label: metadata?.displayName?.trim() || metadata?.host || machine.id,
        online: connected && machine.active, lastSeenAt: machine.activeAt,
        health: sourceMachineHealth(machine.health),
        ...(typeof metadata?.host === 'string' ? { host: metadata.host } : {}),
        ...(typeof metadata?.platform === 'string' ? { platform: metadata.platform } : {}),
        ...(typeof metadata?.happyCliVersion === 'string' ? { version: metadata.happyCliVersion } : {}),
        ...(typeof metadata?.homeDir === 'string' ? { homeDir: metadata.homeDir } : {}),
        ...(Array.isArray(metadata?.workspaceRoots) && metadata.workspaceRoots.every(path => typeof path === 'string') ? { workspaceRoots: metadata.workspaceRoots as string[] } : {}),
    }
}
