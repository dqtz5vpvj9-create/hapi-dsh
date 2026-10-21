import type { Context } from '@deepseek-ai/cordis';
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type { HapiRemoteApi } from '../../client-api.ts';
import { remoteValue } from '../../client-api.ts';
import type { SourceVoiceContext } from '../../voice-types.ts';
import type { WorkbenchSource } from '../../workbench-types.ts';
import { truncateUtf8ByteLength } from '../../voice/protocol/voicePersonality.ts';
import { isObject } from '../../voice/messages.ts';

export type VoiceContext = Omit<SourceVoiceContext, 'source'> & { source?: WorkbenchSource };
export function assertVoiceBinding(ctx: Context, binding: SessionBinding): void {
    if (ctx.sessions.binding(binding.sessionId) !== binding || binding.session.getSnapshot().removed) throw new Error('The original voice conversation is no longer open');
}
function textParts(content: unknown): string {
    if (!Array.isArray(content)) return '';
    return content.flatMap(part => isObject(part) && part.type === 'text' && typeof part.text === 'string' ? [part.text] : []).join('\n');
}
/** Only committed public Session events, never transient reasoning or a different graph's catalog. */
export function ordinaryVoiceContext(ctx: Context, binding: SessionBinding): VoiceContext {
    assertVoiceBinding(ctx, binding);
    const window = binding.eventSource.getSnapshot(), lifecycle = binding.session.getSnapshot();
    const summary = ctx.sessions.list.getSnapshot().byId[binding.sessionId];
    const messages = window.entries.flatMap(entry => {
        if (entry.type !== 'event') return [];
        const event = entry.event; let content: unknown; let label: string;
        if (event.type === 'user/message') { content = event.data.content; label = 'User'; }
        else if (event.type === 'assistant/message') { content = event.data.message.content; label = 'Coding agent'; }
        else return [];
        const text = textParts(content); return text ? [{ id: `dsh-event:${event.seq}`, seq: Number(event.seq), text: truncateUtf8ByteLength(`${label}:\n<text>${text}</text>`, 8000) }] : [];
    }).slice(-50);
    const title = summary?.displayTitle ?? binding.sessionId;
    const header = `THIS IS AN ACTIVE SESSION.\n\n# Session ID: ${binding.sessionId}\n\n# Session summary:\n${title}${summary?.cwd ? `\n\n# Project path: ${summary.cwd}` : ''}`;
    const recent = messages.slice(-2), older = messages.slice(0, Math.max(0, messages.length - 2));
    const full = header + (recent.length ? `\n\n## Recent messages\n\n${recent.map(row => row.text).join('\n\n')}` : '');
    const bootstrap = truncateUtf8ByteLength(full, 4000), streamChunks = older.map(row => truncateUtf8ByteLength(`[Session history]\n${row.text}`, 8000));
    const pending = ctx.uiSession.sessionStatus.getSnapshot().get(binding.sessionId)?.pendingInteraction;
    const approval = pending?.kind === 'approval' && 'toolName' in pending && typeof pending.toolName === 'string' && 'answerable' in pending
        ? { id: pending.key, tool: pending.toolName,
            context: `Coding agent requests permission to use ${pending.toolName}. Request ID: ${pending.key}${'reason' in pending && typeof pending.reason === 'string' ? `\n${pending.reason}` : ''}`,
            answerable: pending.answerable === true } : null;
    return { sessionId: binding.sessionId, title, agentLabel: 'Coding agent', active: lifecycle.openState === 'open', thinking: lifecycle.running,
        epoch: 0, hasEarlier: window.hasMore, messages, approvals: approval ? [approval] : [],
        plan: { bootstrap, streamChunks, truncated: bootstrap !== full, totalMessages: messages.length, messagesInBootstrap: recent.length,
            messagesStreamed: older.length, notice: window.hasMore ? 'Voice receives the currently loaded conversation window; earlier history is not loaded.' : null } };
}
export function voiceContextReader(ctx: Context, api: Pick<HapiRemoteApi, 'sourceVoiceContext'>, binding: SessionBinding, source: WorkbenchSource | null) {
    return async (signal: AbortSignal): Promise<VoiceContext> => {
        assertVoiceBinding(ctx, binding); signal.throwIfAborted();
        if (!source) {
            if (/^hapi-(?:codex|observed)-/u.test(binding.sessionId)) throw new Error('The native source identity is unavailable; voice will not use another source context');
            return ordinaryVoiceContext(ctx, binding);
        }
        const context = remoteValue(await api.sourceVoiceContext({ source }, signal));
        assertVoiceBinding(ctx, binding); signal.throwIfAborted();
        if (context.sessionId !== source.sourceSessionId || source.sourceHubId && context.source.sourceHubId !== source.sourceHubId) throw new Error('The source voice context changed identity');
        return context;
    };
}
export function publicApproval(ctx: Context, sessionId: SessionId) {
    const pending = ctx.uiSession.sessionStatus.getSnapshot().get(sessionId)?.pendingInteraction;
    if (!pending || pending.kind !== 'approval' || !('answerable' in pending) || !('answer' in pending) || typeof pending.answer !== 'function') return null;
    return pending as typeof pending & { answerable: boolean; answer(decision: 'allowed-once' | 'rejected'): Promise<void> };
}
