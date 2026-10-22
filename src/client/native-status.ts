import type { DeliveryState, DeliveryView, HapiProjection } from '../codex/projection-types.ts'
import type { HapiObservedProjection } from '../hapi-agent/projection-types.ts'
import type { WorkspaceTranslate } from './locales.ts'
import { translate } from './diagnostics/localize.ts'

export type DeliveryStatus = 'unknown' | 'queued' | 'received' | 'sent' | 'failed' | 'cancelled' | 'discarded'
export function deliveryStatus(state: DeliveryState): DeliveryStatus {
    switch (state) {
        case 'accepted': return 'received'
        case 'queued': return 'queued'
        case 'invoked': return 'sent'
        case 'rejected': return 'failed'
        case 'cancelled': return 'cancelled'
        case 'discarded': return 'discarded'
        default: return 'unknown'
    }
}
export function deliveryStatusText(state: DeliveryState, t: WorkspaceTranslate): string {
    const labels: Record<DeliveryStatus, [string, string]> = {
        unknown: ['Unknown · awaiting confirmation', '结果未知 · 等待确认'], queued: ['Queued', '已排队'],
        received: ['Received by source', '源端已接收'], sent: ['Sent to execution', '已送入执行'],
        failed: ['Failed', '投递失败'], cancelled: ['Cancelled by source', '源端已取消'], discarded: ['Discarded', '已丢弃'],
    }
    const [en, zh] = labels[deliveryStatus(state)]
    return translate(t, en, zh)
}

/** Queue actions require the source queue, not merely an HTTP send receipt. */
export function deliveryActions(delivery: DeliveryView, steer: boolean, now = Date.now()) {
    const queued = delivery.state === 'queued'
    return {
        edit: queued && delivery.editable === true,
        cancel: queued && delivery.cancelable === true,
        steer: queued && delivery.cancelable === true && steer && !(delivery.scheduledAt && delivery.scheduledAt > now),
        recover: delivery.state === 'rejected', retryUnknown: delivery.state === 'indeterminate',
    }
}
/** A confirmed failed send can use the existing resume-before-send path. */
export function deliveryRecoveryDisabled(source: { readOnly: boolean; readOnlyReason?: string | null | undefined }): boolean {
    return source.readOnly && source.readOnlyReason !== 'unavailable' && source.readOnlyReason !== 'fault'
}

export type SourceExecutionStatus = 'idle' | 'running' | 'waiting-for-approval' | 'waiting-for-answer' | 'compacting' | 'unknown' | 'error'
export function nativeExecutionStatus(projection: HapiProjection): SourceExecutionStatus {
    const execution = projection?.execution
    if (!projection || projection.nativeConnection !== 'attached' || !execution) return 'unknown'
    if (execution.status === 'systemError') return 'error'
    if (execution.status === 'disconnected' || execution.status === 'notLoaded') return 'unknown'
    if (execution.waitingOn.includes('approval')) return 'waiting-for-approval'
    if (execution.waitingOn.includes('input')) return 'waiting-for-answer'
    if (execution.compacting) return 'compacting'
    return execution.status === 'active' ? 'running' : 'idle'
}
export function observedExecutionStatus(projection: HapiObservedProjection | undefined): SourceExecutionStatus {
    if (!projection || projection.connection !== 'connected' || !projection.active) return 'unknown'
    // Observed engines do not report native execution/compaction. Only their
    // current blocking requests and thinking flag authorize these labels.
    const blocking = projection.pendingRequests.filter(request => request.blocking && request.stage !== 'indeterminate')
    const input = (tool: string): boolean => /request.?user.?input|ask.?user.?question/i.test(tool)
    if (blocking.some(request => !input(request.tool))) return 'waiting-for-approval'
    if (blocking.some(request => input(request.tool))) return 'waiting-for-answer'
    return projection.thinking ? 'running' : 'idle'
}
export function executionStatusText(status: SourceExecutionStatus, t: WorkspaceTranslate): string {
    const key = { idle: 'idle', running: 'running', 'waiting-for-approval': 'waitingPermission',
        'waiting-for-answer': 'waitingInput', compacting: 'compacting', unknown: 'sourceUnreportedValue', error: 'activityError' } as const
    return t(key[status])
}
