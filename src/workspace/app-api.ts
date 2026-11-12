/** Application services share the authenticated Host carrier; HHPI v1 is unchanged. */
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol';
import { appServiceInputs, appServiceOutputs, type AppServiceApi, type AppServiceMethod } from './app-service-types.ts';
declare module '@deepseek-ai/dsh-typert-protocol' {
    interface TypertRemoteNamespaceMap { appServices: AppServiceApi }
    interface TypertRemoteMap {
        'appServices/appNotificationSettings': AppServiceApi['appNotificationSettings'];
        'appServices/appPushSubscribe': AppServiceApi['appPushSubscribe'];
        'appServices/appPushUnsubscribe': AppServiceApi['appPushUnsubscribe'];
        'appServices/appNotificationResolve': AppServiceApi['appNotificationResolve'];
        'appServices/appReadState': AppServiceApi['appReadState'];
        'appServices/appReadStates': AppServiceApi['appReadStates'];
        'appServices/appReadStateWrite': AppServiceApi['appReadStateWrite'];
        'appServices/appShareCreate': AppServiceApi['appShareCreate'];
        'appServices/appShareResolve': AppServiceApi['appShareResolve'];
    }
}
export const APP_SERVICES_REMOTE: TypertRemoteContribution = {
    package: 'hapi-dsh', descriptors: (Object.keys(appServiceInputs) as AppServiceMethod[]).map(method => ({
        id: `hapi-dsh#appServices/${method}`, namespace: 'appServices', service: 'appServices', method,
        invocation: { kind: 'direct' }, cancellation: { parameter: 'signal' },
        parameters: [{ name: 'request', wire: 'request', source: 'json', codec: {
            mode: 'strict', typeSymbol: `hapi-dsh#appServices/${method}Input`, create: () => appServiceInputs[method],
        } }],
        result: { mode: 'strict', typeSymbol: `hapi-dsh#appServices/${method}Result`, create: () => appServiceOutputs[method] },
    })),
};
export const APP_SERVICES_HOST_CONTRACT = {
    invocations: APP_SERVICES_REMOTE.descriptors,
    services: [{ key: 'appServices', exportName: 'AppServicesController', tags: [], members: [], types: [], summary: 'Account-scoped application notifications, reading and sharing.' }],
};
