import { LlmAdapter, LlmError, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm';

export const NATIVE_CODEX_PROVIDER = 'hapi-codex-native';
export const HAPI_OBSERVED_PROVIDER = 'hapi-observed';

/**
 * Metadata only: lets official DSH attachment admission inspect a native model
 * without asking a local DSH LLM adapter to run Codex. Native execution and
 * capability validation remain with the source app-server.
 */
export class NativeModelMetadata extends LlmAdapter {
    override providerInfo(provider: string): { id: string; name: string } {
        return { id: provider, name: provider === HAPI_OBSERVED_PROVIDER ? 'HAPI · Runner session' : 'HAPI · Native Codex' };
    }
    override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
        // An absent modality is unknown, as defined by the upstream contract.
        // Do not manufacture a model capability from its name.
        return Promise.resolve({ provider, id: model, name: model });
    }
    override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
        throw new LlmError('HAPI runs this model through its original Runner session; create or resume that session in the workspace.', 'NATIVE_SESSION_REQUIRED');
    }
}
