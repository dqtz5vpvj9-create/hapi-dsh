/** HAPI-owned notes, transcript navigation and export. Adapted from HAPI 0f8ef697 public schemas (AGPL-3.0-only). */
import { z } from 'zod';
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import { workbenchSourceSchema } from './workbench-types.ts';
import { sourceWorkEventSchema, sourceWorkLinkSchema } from './source-collaboration-types.ts';
const id = z.string().min(1).max(512);
const position = z.object({ at: z.number().finite(), seq: z.number().int().nonnegative() });
export const sourceAttachmentSchema = z.object({ id, filename: z.string().max(1024), mimeType: z.string().max(256), size: z.number().int().nonnegative(), path: z.string().max(8192) });
export type SourceAttachment = z.infer<typeof sourceAttachmentSchema>;
export const sourceNoteSchema = z.object({ entryId: id, text: z.string(), createdAt: z.number(), updatedAt: z.number(), attachments: z.array(sourceAttachmentSchema).default([]) });
export type SourceNote = z.infer<typeof sourceNoteSchema>;
export const sourceNoteLimitsSchema = z.object({ maxBytesPerFile: z.number().int().positive(), maxAttachmentsPerEntry: z.number().int().positive(),
    maxBytesPerEntry: z.number().int().positive(), maxBytesPerSession: z.number().int().positive(), allowedMimeTypes: z.array(z.string()) });
const source = { source: workbenchSourceSchema };
export const sourceNoteActionSchema = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('create'), entryId: z.string().min(1).max(128), text: z.string().max(10000), attachments: z.array(sourceAttachmentSchema), createdAt: z.number().int().nonnegative().optional() }),
    z.strictObject({ kind: z.literal('update'), entryId: id, text: z.string().max(10000), attachments: z.array(sourceAttachmentSchema) }),
    z.strictObject({ kind: z.literal('delete'), entryId: id }),
    z.strictObject({ kind: z.literal('delete-attachment'), attachmentId: id }),
]);
export type SourceNoteAction = z.infer<typeof sourceNoteActionSchema>;
export const sourceOutlineSchema = z.object({ entries: z.array(z.object({ messageId: id, label: z.string(), at: z.number(), seq: z.number(), createdAt: z.number() })),
    page: z.object({ epoch: z.number(), reset: z.boolean(), hasMore: z.boolean(), beforeCursor: position.nullable(), scannedThrough: z.number(), headSeq: z.number(), complete: z.boolean(), unreadable: z.boolean(), indexing: z.boolean() }) });
export type SourceOutline = z.infer<typeof sourceOutlineSchema>;
const rawMessage = z.object({ id, seq: z.number().nullable(), localId: z.string().nullable(), content: z.json(), createdAt: z.number(), invokedAt: z.number().nullish(), scheduledAt: z.number().nullish() }).passthrough();
export const sourceMessageContextSchema = z.object({ anchor: z.object({ messageId: id, position }), messages: z.array(rawMessage),
    page: z.object({ epoch: z.number(), reset: z.boolean(), beforeCursor: position, afterCursor: position, hasMoreBefore: z.boolean(), hasMoreAfter: z.boolean(), snapshotHead: position }) });
export type SourceMessageContext = z.infer<typeof sourceMessageContextSchema>;
export const sourceExportSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('ready'), fileName: z.string(), bytes: z.number(), url: z.string() }),
    z.object({ type: z.literal('warning'), count: z.number(), limit: z.number(), estimatedBytes: z.number() }),
]);
export type SourceExport = z.infer<typeof sourceExportSchema>;
const query = z.object({ limit: z.number().int().min(1).max(100).optional(), beforeAt: z.number().int().nonnegative().optional(), beforeSeq: z.number().int().positive().optional(), epoch: z.number().int().nonnegative().optional() })
    .strict().refine(value => (value.beforeAt === undefined) === (value.beforeSeq === undefined) && (value.beforeAt === undefined || value.epoch !== undefined));
export const sessionExtrasInputs = {
    sourceNotes: z.strictObject(source),
    sourceNoteWrite: z.strictObject({ ...source, action: sourceNoteActionSchema }),
    sourceNoteUpload: z.strictObject({ ...source, filename: z.string().min(1).max(1024), mimeType: z.string().min(1).max(256), content: z.string().max(90_000_000) }),
    sourceOutline: z.strictObject({ ...source, query }),
    sourceMessageContext: z.strictObject({ ...source, messageId: id, epoch: z.number().int().nonnegative().optional(), radius: z.number().int().min(1).max(99).optional() }),
    sourceExport: z.strictObject({ ...source, format: z.enum(['json', 'markdown']), force: z.boolean().optional() }),
    sourceSkills: z.strictObject(source),
    sourceTitleTools: z.strictObject(source),
    sourceTitleSuggestion: z.strictObject(source),
    sourceWorkGraph: z.strictObject({ ...source, limit: z.number().int().min(1).max(1000).optional() }),
    sourceWorkGraphLinks: z.strictObject({ ...source, eventId: id }),
};
export const sessionExtrasOutputs = {
    sourceNotes: z.object({ entries: z.array(sourceNoteSchema), limits: sourceNoteLimitsSchema, attachmentUrls: z.record(id, z.string()) }),
    sourceNoteWrite: z.object({ entry: sourceNoteSchema.optional(), ok: z.literal(true).optional() }),
    sourceNoteUpload: z.object({ attachment: sourceAttachmentSchema }),
    sourceOutline: sourceOutlineSchema,
    sourceMessageContext: sourceMessageContextSchema,
    sourceExport: sourceExportSchema,
    sourceSkills: z.object({ skills: z.array(z.object({ name: z.string(), description: z.string().optional(), path: z.string().optional(), content: z.string().optional(), source: z.string().optional() })) }),
    sourceTitleTools: z.object({ title: z.string(), suggestionAvailable: z.boolean() }),
    sourceTitleSuggestion: z.object({ title: z.string().trim().min(1).max(80) }),
    sourceWorkGraph: z.object({ available: z.boolean(), events: z.array(sourceWorkEventSchema), requestedLimit: z.number().int().positive() }),
    sourceWorkGraphLinks: z.object({ event: sourceWorkEventSchema, links: z.array(sourceWorkLinkSchema) }),
};
export type SessionExtrasMethod = keyof typeof sessionExtrasInputs;
export type SessionExtrasRequest<K extends SessionExtrasMethod> = z.infer<(typeof sessionExtrasInputs)[K]>;
export type SessionExtrasResponse<K extends SessionExtrasMethod> = z.infer<(typeof sessionExtrasOutputs)[K]>;
export type SessionExtrasApi = { [K in SessionExtrasMethod]: (request: SessionExtrasRequest<K>) => Promise<RemoteResult<SessionExtrasResponse<K>>> };
export const SOURCE_RESOURCE_PATH = '/hapi-dsh/session-resource';
