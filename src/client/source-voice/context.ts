import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
/** A transcript belongs to this exact live binding, never another session or a successor. */
export function assertVoiceBinding(ctx: Context, binding: SessionBinding): void {
    if ((ctx.sessions.binding(binding.sessionId) !== binding && ctx.sessions.ownsBinding?.(binding) !== true)
        || binding.session.getSnapshot().removed) throw new Error('The dictation conversation is no longer open')
}
