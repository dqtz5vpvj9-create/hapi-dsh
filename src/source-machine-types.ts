import { z } from 'zod';
import { SOURCE_CREATION_FLAVORS } from './hapi-agent/creation-types.ts';

/** Original HAPI MachineHealth wire fields (0f8ef697); never host-local metrics. */
export const sourceMachineHealthSchema = z.object({
    collectedAt: z.number().finite().nonnegative().max(8_640_000_000_000_000), cpuCount: z.number().int().positive().optional(),
    load1m: z.number().finite().nonnegative().optional(), cpuPercent: z.number().min(0).max(100).optional(),
    memoryPercent: z.number().min(0).max(100).optional(), uptimeSeconds: z.number().finite().nonnegative().optional(),
});
export type SourceMachineHealth = z.infer<typeof sourceMachineHealthSchema>;

export const sourceMachineOptionsRequestSchema = z.strictObject({
    machineId: z.string().min(1).max(512), agent: z.enum(SOURCE_CREATION_FLAVORS),
    cwd: z.string().trim().min(1).max(4096).optional(), refresh: z.boolean().optional(),
});
export type SourceMachineOptionsRequest = z.infer<typeof sourceMachineOptionsRequestSchema>;
export const sourceMachineOptionsSchema = z.object({
    agent: z.enum(SOURCE_CREATION_FLAVORS),
    availability: z.object({ available: z.boolean().nullable(), reason: z.string().nullable() }),
    models: z.array(z.object({ id: z.string().min(1), name: z.string(), reasoningEfforts: z.array(z.string()),
        origin: z.enum(['runner', 'hapi-presets']) })),
    // Cursor CLI SKUs are exact launch IDs, distinct from ACP base/wire rows.
    cliModelSkus: z.array(z.object({ modelId: z.string().min(1), name: z.string().optional() })).optional(),
    efforts: z.array(z.string()), currentModelId: z.string().nullable(), warnings: z.array(z.string()),
});
export type SourceMachineOptions = z.infer<typeof sourceMachineOptionsSchema>;
