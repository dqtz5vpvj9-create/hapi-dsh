/** Native coordinates are resolved by their owner, outside HHPI v1. */
import { z } from 'zod';
import type { RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol';
export const sourcePositionRequest = z.strictObject({ sessionId: z.string().min(1),
    position: z.strictObject({ turnId: z.string().min(1), itemId: z.string().min(1).optional() }) });
export const sourcePositionResult = z.strictObject({ epoch: z.string().min(1), seq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) });
export type SourcePositionRequest = z.infer<typeof sourcePositionRequest>;
export type SourcePositionResult = z.infer<typeof sourcePositionResult>;
const sourceText = z.string().min(1).max(8192).refine(value => !/[\x00-\x1f\x7f]/.test(value));
export const sourceResumeRequest = z.strictObject({ sessionId: sourceText });
export const sourceResumeContext = z.strictObject({ sessionId: sourceText, machineId: sourceText, sourceId: sourceText,
    engine: z.literal('codex'), nativeId: sourceText, cwd: sourceText, codexHome: sourceText, platformOs: sourceText, platformFamily: sourceText });
export type SourceResumeRequest = z.infer<typeof sourceResumeRequest>;
export type SourceResumeContext = z.infer<typeof sourceResumeContext>;
export interface SourceNavigationApi {
    locatePosition(request: SourcePositionRequest, signal?: AbortSignal): Promise<RemoteResult<SourcePositionResult>>;
    resumeContext(request: SourceResumeRequest, signal?: AbortSignal): Promise<RemoteResult<SourceResumeContext>>;
}
declare module '@deepseek-ai/dsh-typert-protocol' {
    interface TypertRemoteNamespaceMap { sourceNavigation: SourceNavigationApi }
    interface TypertRemoteMap {
        'sourceNavigation/locatePosition': SourceNavigationApi['locatePosition'];
        'sourceNavigation/resumeContext': SourceNavigationApi['resumeContext'];
    }
}
export const SOURCE_NAVIGATION_REMOTE: TypertRemoteContribution = { package: 'hapi-dsh', descriptors: [{
    id: 'hapi-dsh#sourceNavigation/locatePosition', service: 'sourceNavigation', namespace: 'sourceNavigation', method: 'locatePosition',
    invocation: { kind: 'direct' }, cancellation: { parameter: 'signal' },
    parameters: [{ name: 'request', wire: 'request', source: 'json', codec: {
        mode: 'strict', typeSymbol: 'hapi-dsh#SourcePositionRequest', create: () => sourcePositionRequest,
    } }],
    result: { mode: 'strict', typeSymbol: 'hapi-dsh#SourcePositionResult', create: () => sourcePositionResult },
}, {
    id: 'hapi-dsh#sourceNavigation/resumeContext', service: 'sourceNavigation', namespace: 'sourceNavigation', method: 'resumeContext',
    invocation: { kind: 'direct' }, cancellation: { parameter: 'signal' },
    parameters: [{ name: 'request', wire: 'request', source: 'json', codec: {
        mode: 'strict', typeSymbol: 'hapi-dsh#SourceResumeRequest', create: () => sourceResumeRequest,
    } }],
    result: { mode: 'strict', typeSymbol: 'hapi-dsh#SourceResumeContext', create: () => sourceResumeContext },
}] };
export const SOURCE_NAVIGATION_HOST_CONTRACT = { invocations: SOURCE_NAVIGATION_REMOTE.descriptors,
    services: [{ key: 'sourceNavigation', exportName: 'SourceNavigationService', tags: [], members: [], types: [], summary: 'Resolve exact native reading coordinates.' }],
};
