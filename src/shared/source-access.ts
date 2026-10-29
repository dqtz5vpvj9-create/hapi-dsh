/** Source identities must never fall through to a central Host execution or filesystem. */
import type { Context } from '@deepseek-ai/cordis';
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol';
import type {} from '../index.ts';
import type {} from '../hhpi-api.ts';
import { isSourceSessionId } from '../remote/protocol.ts';
import { isSourceDisplayId } from './source-display-id.ts';

export function assertOrdinarySourceTarget(sessionId: string): void {
    if (isSourceSessionId(sessionId)) throw new RemoteError('hhpi/source', 'This operation must use the exact native source capability. No central Host execution or path was used.', { outcome: 'rejected', sourceCode: 'UNSUPPORTED' });
}
export function legacyWorkbenchSource(ctx: Context, sessionId: string): ReturnType<Context['hapi']['workbenchSource']> {
    assertOrdinarySourceTarget(sessionId);
    if (!isSourceDisplayId(sessionId)) return undefined;
    const legacy = ctx.get('hapi');
    if (!legacy) throw new RemoteError('hapi/request', 'The legacy source is not configured on this Host.', { outcome: 'rejected', sourceCode: 'source_unavailable' });
    return legacy.workbenchSource(sessionId);
}
