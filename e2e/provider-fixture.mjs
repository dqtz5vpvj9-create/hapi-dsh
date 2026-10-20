/** Scripted model fixture: tests the real DSH AgentLoop without a paid provider. Never shipped in the runtime. */
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
class FixtureModel extends LlmAdapter {
    providerInfo(provider) { return { id: provider, name: 'E2E scripted provider' }; }
    async listModels(provider) { return [{ provider, id: 'fixture-model', name: 'E2E fixture model' }]; }
    async resolveModel(provider, model) { return { provider, id: model, name: 'E2E fixture model', inputModalities: ['text'] }; }
    async *stream() {
        const text = 'DSH fixture response through the official AgentLoop.';
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text };
        yield { type: 'block-end', index: 0, block: { type: 'text', text } };
        yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 9 } };
        yield { type: 'finish', reason: { kind: 'stop' } };
    }
}
export const inject = ['llm'];
export function apply(ctx) { ctx.effect(() => ctx.llm.registerAdapter(['fixture'], new FixtureModel())); }
