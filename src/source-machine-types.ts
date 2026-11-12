import { z } from 'zod';

/** Source-reported machine metrics; never inferred from the display Host. */
export const sourceMachineHealthSchema = z.object({
    collectedAt: z.number().finite().nonnegative().max(8_640_000_000_000_000), cpuCount: z.number().int().positive().optional(),
    load1m: z.number().finite().nonnegative().optional(), cpuPercent: z.number().min(0).max(100).optional(),
    memoryPercent: z.number().min(0).max(100).optional(), uptimeSeconds: z.number().finite().nonnegative().optional(),
});
export type SourceMachineHealth = z.infer<typeof sourceMachineHealthSchema>;
