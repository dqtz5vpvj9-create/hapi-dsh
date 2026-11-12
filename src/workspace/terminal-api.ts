/** Source-owned terminals reuse the official terminal codecs without Agent resolution. */
import { TYPERT_REMOTE as TERMINAL_REMOTE } from '@deepseek-ai/dsh-api-terminal-controller/remote';
import type { InvocationDescriptor, TypertRemoteContribution, TypertRemoteNamespaceMap } from '@deepseek-ai/dsh-typert-protocol';

export type SourceTerminalApi = TypertRemoteNamespaceMap['terminal'];
declare module '@deepseek-ai/dsh-typert-protocol' {
    interface TypertRemoteNamespaceMap { sourceTerminal: SourceTerminalApi }
    interface TypertRemoteMap {
        'sourceTerminal/environment': SourceTerminalApi['environment'];
        'sourceTerminal/shells': SourceTerminalApi['shells'];
        'sourceTerminal/list': SourceTerminalApi['list'];
        'sourceTerminal/create': SourceTerminalApi['create'];
        'sourceTerminal/retain': SourceTerminalApi['retain'];
        'sourceTerminal/attach': SourceTerminalApi['attach'];
        'sourceTerminal/rename': SourceTerminalApi['rename'];
        'sourceTerminal/close': SourceTerminalApi['close'];
    }
}
export const SOURCE_TERMINAL_REMOTE: TypertRemoteContribution = {
    package: 'hapi-dsh', descriptors: TERMINAL_REMOTE.descriptors.map((value): InvocationDescriptor => {
        const { scope: _agentScope, ...direct } = value;
        return { ...direct, id: `hapi-dsh#sourceTerminal/${value.method}`, service: 'sourceTerminal', namespace: 'sourceTerminal',
        parameters: value.parameters.map((parameter, index) => index === 0
            ? { name: 'sessionId', wire: 'sessionId', source: 'json', codec: parameter.codec } : parameter),
        };
    }),
};
export const SOURCE_TERMINAL_HOST_CONTRACT = {
    invocations: SOURCE_TERMINAL_REMOTE.descriptors,
    services: [{ key: 'sourceTerminal', exportName: 'SourceTerminalService', tags: [], members: [], types: [], summary: 'Authorized source-owned user terminals.' }],
};
