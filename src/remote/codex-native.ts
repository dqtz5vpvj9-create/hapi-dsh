/** Minimal, validated native boundaries for Codex app-server 0.165.0 (v2). */
import { z } from 'zod';
const id = z.string().min(1).max(2048);
export const nativeItemSchema = z.object({ id, type: z.string().min(1) }).passthrough();
export type NativeItem = z.infer<typeof nativeItemSchema>;
export const nativeTurnSchema = z.object({ id, status: z.enum(['completed', 'interrupted', 'failed', 'inProgress']),
    items: z.array(nativeItemSchema).optional(), startedAt: z.number().finite().nullable().optional(), completedAt: z.number().finite().nullable().optional(), error: z.unknown().optional() }).passthrough();
export type NativeTurn = z.infer<typeof nativeTurnSchema>;
export const nativeThreadSchema = z.object({ id, cwd: z.string(), preview: z.string().optional(), name: z.string().nullable().optional(),
    createdAt: z.number().finite(), updatedAt: z.number().finite(), status: z.object({ type: z.string() }).passthrough(),
    model: z.string().nullable().optional(), modelProvider: z.string().optional(), turns: z.array(nativeTurnSchema).optional() }).passthrough();
export type NativeThread = z.infer<typeof nativeThreadSchema>;
export const threadResponseSchema = z.object({ thread: nativeThreadSchema }).passthrough();
export const threadListSchema = z.object({ data: z.array(nativeThreadSchema), nextCursor: z.string().nullable() }).passthrough();
export const loadedListSchema = z.object({ data: z.array(id), nextCursor: z.string().nullable() }).passthrough();
export const turnListSchema = z.object({ data: z.array(nativeTurnSchema), nextCursor: z.string().nullable() }).passthrough();
export const itemEntrySchema = z.object({ turnId: id, item: nativeItemSchema,
    startedAtMs: z.number().finite().nullable().optional(), completedAtMs: z.number().finite().nullable().optional() });
export type NativeItemEntry = z.infer<typeof itemEntrySchema>;
export const itemListSchema = z.object({ data: z.array(itemEntrySchema), nextCursor: z.string().nullable() }).passthrough();
export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
export const nativeText = (value: unknown): string => typeof value === 'string' ? value : '';
