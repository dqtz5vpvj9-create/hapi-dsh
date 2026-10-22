import { z } from 'zod'
export const deliveryRecoveryRequestSchema = z.strictObject({ sessionId: z.string().min(1), localId: z.string().min(1),
    operationId: z.string().uuid(), action: z.enum(['retry', 'discard']) })
export type DeliveryRecoveryRequest = z.infer<typeof deliveryRecoveryRequestSchema>
