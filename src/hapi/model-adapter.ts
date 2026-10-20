import { LlmAdapter, LlmError, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm';

export const NATIVE_CODEX_PROVIDER = 'hapi-codex-native';

/**
 * Metadata only: lets official DSH attachment admission inspect a native model
 * without asking a local DSH LLM adapter to run Codex. Native execution and
 * capability validation remain with the source app-server.
 */
export class NativeModelMetadata extends LlmAdapter {
    override providerInfo(provider: string): { id: string; name: string } {
        return { id: provider, name: 'HAPI · Native Codex' };
    }
    override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
        // An absent modality is unknown, as defined by the upstream contract.
        // Do not manufacture a model capability from its name.
        return Promise.resolve({ provider, id: model, name: model });
    }
    override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
        throw new LlmError('Native Codex runs through its HAPI session; create or resume a native session in the workspace.', 'NATIVE_SESSION_REQUIRED');
    }
}
