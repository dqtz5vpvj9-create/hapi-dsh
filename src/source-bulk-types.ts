import { z } from 'zod';
export const sourceBulkOperationSchema = z.strictObject({ operationId: z.string().uuid(), action: z.enum(['standard', 'pause']) });
export type SourceBulkOperation = z.infer<typeof sourceBulkOperationSchema>;
export const sourceBulkReceiptSchema = sourceBulkOperationSchema.extend({
    hubId: z.string(), createdAt: z.number(), updatedAt: z.number(), state: z.enum(['reading', 'running', 'finished', 'interrupted', 'failed']), error: z.string().nullable(),
    targets: z.array(z.object({ sourceSessionId: z.string(), machineId: z.string().nullable(), name: z.string(), namespace: z.string().nullable(),
        sourceCreatedAt: z.number().nullable(), status: z.enum(['prepared', 'dispatching', 'accepted', 'rejected', 'unknown', 'skipped']), error: z.string().nullable() })),
});
export type SourceBulkReceipt = z.infer<typeof sourceBulkReceiptSchema>;
export const sourceBulkReadSchema = z.strictObject({ operationId: z.string().uuid() });
