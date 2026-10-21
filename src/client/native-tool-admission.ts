import type { NativeSessionTools, NativeSourceAction } from '../client-api.ts'

/** The source remains the final authority. The UI only enables an action once
 * the current selection has actually supplied its corresponding capability. */
export function nativeToolAllowed(data: NativeSessionTools | null, sessionId: string, action: NativeSourceAction): boolean {
    if (!data || data.sessionId !== sessionId) return false
    switch (action.kind) {
        case 'archive': case 'restart': return data.active
        case 'delete': case 'reopen': case 'resume': return !data.active
        case 'clear': return data.canClear
        case 'goal': return !data.readOnly
        case 'rewind': return data.canRewind && !data.readOnly
        default: return true
    }
}
