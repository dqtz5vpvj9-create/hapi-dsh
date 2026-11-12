import type { Context } from '@deepseek-ai/cordis';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type { RemoteAccessService } from '@deepseek-ai/dsh-api-remote-access';
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { SourceAccessDenied, SourceError } from '../remote/errors.ts';
import type {} from '../hhpi-api.ts';
import type { SourceGateway } from '../remote/gateway.ts';
import type { SourcePositionRequest } from './source-navigation-api.ts';
import type { SourceResumeRequest } from './source-navigation-api.ts';
import { parseSourceSessionId } from '../remote/protocol.ts';
export class SourceNavigationService extends TypertRemoteService {
    constructor(ctx: Context, private readonly gateway: SourceGateway) { super(ctx, 'sourceNavigation'); }
    @Remote({ name: 'locatePosition', resources: { session: (request: SourcePositionRequest) => [request.sessionId as SessionId] } })
    async locatePosition(request: SourcePositionRequest, signal?: AbortSignal) {
        const invocation = this.ctx.invocation;
        if (!invocation) throw new SourceAccessDenied();
        const access = this.ctx.remoteAccess as unknown as RemoteAccessService;
        try {
            return await this.gateway.locatePosition(request, resource => access.allows(resource.kind === 'source'
                ? { kind: 'hhpiSource', id: resource.id } : { kind: 'session', id: resource.id as SessionId }),
            AbortSignal.any([invocation.signal, invocation.peer.signal, ...(signal ? [signal] : [])]));
        } catch (error) {
            if (error instanceof SourceAccessDenied) throw new RemoteError('remote-access/denied', error.message, { action: 'sourceNavigation/locatePosition', reason: 'no-allow' });
            if (error instanceof SourceError) throw new RemoteError('hhpi/source', error.message, { sourceCode: error.code,
                outcome: error.code === 'OUTCOME_UNKNOWN' ? 'indeterminate' : 'rejected' });
            throw error;
        }
    }
    @Remote({ name: 'resumeContext', resources: { session: (request: SourceResumeRequest) => [request.sessionId as SessionId],
        hhpiSource: (request: SourceResumeRequest) => [parseSourceSessionId(request.sessionId).sourceId] } })
    resumeContext(request: SourceResumeRequest, signal?: AbortSignal) {
        const invocation = this.ctx.invocation;
        if (!invocation) throw new SourceAccessDenied();
        const access = this.ctx.remoteAccess as unknown as RemoteAccessService;
        return this.gateway.resumeContext(request, resource => access.allows(resource.kind === 'source'
            ? { kind: 'hhpiSource', id: resource.id } : { kind: 'session', id: resource.id as SessionId }),
        AbortSignal.any([invocation.signal, invocation.peer.signal, ...(signal ? [signal] : [])]));
    }
}
