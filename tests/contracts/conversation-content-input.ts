/** One typed official factory boundary shared by simulated and real geometry. */
import type { ConversationContentProps } from '@deepseek-ai/dsh-client-ui-conversation/client'

export const ACTIVE_CONVERSATION_INPUT = Object.freeze({
  phase: 'active', hero: false, variant: 'embedded',
} as const satisfies Pick<ConversationContentProps, 'phase' | 'hero' | 'variant'>)
