import type { Session } from '@deepseek-ai/dsh-session'
import { SUBAGENT_DESCRIPTOR_VERSION } from '@deepseek-ai/dsh-subagent'

/**
 * These are local observer Session capabilities. A one-shot observer cannot be
 * cold-resumed by DSH; its original source engine/mode remains in hapiObserved.
 * Only the DSH child bridge with a real source continuation API advertises
 * continuable. Source turn completion is deliberately not synthesized here.
 */
export function establishSourceChild(parent: Session, child: Session, label: string, continuable = false): void {
  child.append('subagent/descriptor', continuable
    ? { version: SUBAGENT_DESCRIPTOR_VERSION, mode: 'continuable', provider: 'hapi-source-dsh-child', label,
      agentProvider: 'hapi-observed', agentModel: 'dsh' }
    : { version: SUBAGENT_DESCRIPTOR_VERSION, mode: 'one-shot', provider: 'hapi-source-observer', label })
  parent.append('subagent/catalog', { version: 0, childId: child.id, childCreatedAt: child.header.createdAt,
    mode: continuable ? 'continuable' : 'one-shot', label })
}
