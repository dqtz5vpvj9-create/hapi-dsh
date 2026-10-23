/** Both workspace and remote panes must expose the same source-owned actions. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { remoteValue, type HapiRemoteApi } from '../client-api.ts'
import type { NativeActionsApi } from './native-actions.tsx'
import type { NativeActionLedger } from './native-state.ts'
import type { NativeControlLedger } from './native-control-state.ts'
import type { ObservedControlLedger } from './observed-controls.tsx'
import { setDiagnosticIdentity } from './diagnostics/index.ts'
import { randomId } from './random-id.ts'

export function createNativeActions(ctx: Context, api: HapiRemoteApi, ledger: NativeActionLedger,
    controls: NativeControlLedger, observedControls: ObservedControlLedger): NativeActionsApi {
    return {
        ledger, controls, observedControls, branchLabel: () => ctx.locale.bind('chat')('message.branch'),
        stop: async sessionId => {
            const binding = ctx.sessions.binding(sessionId as SessionId)
            if (!binding) throw new Error('The source conversation is no longer open.')
            return remoteValue(await binding.session.cancel())
        },
        cancel: async (sessionId, localId) => remoteValue(await api.nativeCancel({ sessionId, localId })),
        steer: async (sessionId, localId) => remoteValue(await api.nativeSteer({ sessionId, localId })),
        retry: async (sessionId, localId) => remoteValue(await api.nativeRetry({ sessionId, localId })),
        check: async (sessionId, localId) => remoteValue(await api.nativeDeliveryCheck({ sessionId, localId })),
        recover: async (sessionId, localId, action) => {
            const key = 'hapi-dsh:delivery-recovery:' + JSON.stringify([sessionId, localId, action]);
            const operationId = localStorage.getItem(key) ?? randomId();
            localStorage.setItem(key, operationId);
            const receipt = remoteValue(await api.nativeDeliveryRecover({ sessionId, localId, action, operationId }));
            localStorage.removeItem(key);
            return receipt;
        },
        answer: async (sessionId, requestId, answer, deny) => remoteValue(await api.nativeAnswer({ sessionId, requestId, answer, ...(deny === undefined ? {} : { deny }) })),
        resume: async sessionId => remoteValue(await api.resumeSession({ sessionId })),
        // One Host API can serve several panes; diagnostics retain each
        // session identity and capture the request's own identity at dispatch.
        identify: identity => setDiagnosticIdentity(api, identity),
    }
}
