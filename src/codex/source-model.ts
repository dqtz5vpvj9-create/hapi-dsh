/** Expose the observed source selection without giving the display a second model owner. */
import type { AgentOptions, Model } from '@deepseek-ai/dsh-agent'
export function sourceModel(options: () => AgentOptions): Model {
  return {
    current() {
      const value = options()
      if (!value.provider || !value.model) return undefined
      return { provider: value.provider, model: value.model,
        ...(value.reasoningEffort === undefined ? {} : { reasoningEffort: value.reasoningEffort }) }
    },
    select() { throw new Error('Change the model through the original source settings.') },
  }
}
