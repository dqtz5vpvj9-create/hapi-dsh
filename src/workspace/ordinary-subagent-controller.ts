import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, MessageId, MessageSource } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime, { type Config, type SubagentActivation, type SubagentActivationSpec,
  type SubagentCatalogEntry, type SubagentDescendantListEntry, type SubagentInterruptAuthority,
  type SubagentInterruptReceipt, type SubagentPromptReceipt, type SubagentPromptRequest,
  type SubagentProvider, type SubagentSendMessageOptions, type SubagentDelivery } from '@deepseek-ai/dsh-subagent'
import { deliverSubagentPrompt, queueHostSubagentPrompt, steerHostSubagentPrompt,
  type HostPromptDeliverer } from '@deepseek-ai/dsh-subagent/internal'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { officialProviderContext, officialProviderScope } from '../shared/official-provider.ts'
import { assertOrdinarySourceTarget } from '../shared/source-access.ts'

/** Keep the official manager, ownership and lifecycle in its original isolated service. */
export class OrdinarySubagentController extends TypertRemoteService implements HostPromptDeliverer {
  static inject = ['loader', 'agents', 'workingDirectory']
  static Config = SubagentRuntime.Config
  constructor(ctx: Context, _config: Config) { super(ctx, 'subagents') }
  private get ordinary(): SubagentRuntime {
    const original = officialProviderContext(this.ctx, 'subagent').get('subagents')
    if (!original) throw new Error('The isolated official subagent provider has not started')
    return original
  }
  @Remote('prompt')
  async prompt(request: SubagentPromptRequest, signal: AbortSignal): Promise<SubagentPromptReceipt> {
    assertOrdinarySourceTarget(request.childSessionId)
    assertOrdinarySourceTarget(request.parentSessionId)
    return this.ordinary.prompt(request, signal)
  }
  @Remote('interruptByParent')
  interruptByParent(childSessionId: SessionId, parentSessionId: SessionId, mode: 'continuable'): SubagentInterruptReceipt {
    assertOrdinarySourceTarget(childSessionId)
    assertOrdinarySourceTarget(parentSessionId)
    return this.ordinary.interruptByParent(childSessionId, parentSessionId, mode)
  }
  resolveMaxDepth(configured?: number | 'provider-managed'): number | undefined { return this.ordinary.resolveMaxDepth(configured) }
  startActivation(spec: SubagentActivationSpec & { readonly childId: SessionId }): Promise<SubagentActivation & { readonly messageId: MessageId }>
  startActivation(spec: SubagentActivationSpec): Promise<SubagentActivation>
  startActivation(spec: SubagentActivationSpec): Promise<SubagentActivation> {
    assertOrdinarySourceTarget(spec.request.parent.id)
    if (spec.childId !== undefined) assertOrdinarySourceTarget(spec.childId)
    return this.ordinary.startActivation(spec)
  }
  waitForChildren(parent: Agent): Promise<boolean> {
    assertOrdinarySourceTarget(parent.id)
    return this.ordinary.waitForChildren(parent)
  }
  sendMessage(sender: Agent, targetId: SessionId, content: ContentBlock[], options: SubagentSendMessageOptions): Promise<MessageId> {
    assertOrdinarySourceTarget(sender.id)
    assertOrdinarySourceTarget(targetId)
    return this.ordinary.sendMessage(sender, targetId, content, options)
  }
  /** The package-exported Team adapter keeps its own source and the exact live parent. */
  [deliverSubagentPrompt](parent: Agent, childId: SessionId, content: ContentBlock[], source: MessageSource,
    signal: AbortSignal, delivery: SubagentDelivery): Promise<MessageId> {
    assertOrdinarySourceTarget(parent.id)
    assertOrdinarySourceTarget(childId)
    const deliver = delivery === 'steer' ? steerHostSubagentPrompt : queueHostSubagentPrompt
    return deliver(this.ordinary, parent, childId, content, source, signal)
  }
  interrupt(targetSessionId: SessionId, authority: SubagentInterruptAuthority): void {
    assertOrdinarySourceTarget(targetSessionId)
    assertOrdinarySourceTarget(authority.kind === 'user' ? authority.parentSessionId : authority.agent.id)
    this.ordinary.interrupt(targetSessionId, authority)
  }
  drainDescendants(parents: readonly Agent[]): Promise<void> {
    for (const parent of parents) assertOrdinarySourceTarget(parent.id)
    return this.ordinary.drainDescendants(parents)
  }
  drainChildren(parent: Agent, childIds: readonly SessionId[]): Promise<void> {
    assertOrdinarySourceTarget(parent.id)
    for (const childId of childIds) assertOrdinarySourceTarget(childId)
    return this.ordinary.drainChildren(parent, childIds)
  }
  listChildren(parentSessionId: SessionId, signal?: AbortSignal): Promise<SubagentCatalogEntry[]> {
    assertOrdinarySourceTarget(parentSessionId)
    return this.ordinary.listChildren(parentSessionId, signal)
  }
  listDescendants(rootSessionId: SessionId, signal?: AbortSignal): Promise<SubagentDescendantListEntry[]> {
    assertOrdinarySourceTarget(rootSessionId)
    return this.ordinary.listDescendants(rootSessionId, signal)
  }
  registerProvider(provider: SubagentProvider): () => void { return this.ordinary.registerProvider(provider) }
  getProvider(name: string): SubagentProvider | undefined { return this.ordinary.getProvider(name) }
  list(): string[] { return this.ordinary.list() }
}
/**
 * Row order has no activation semantics in the official Loader. Publish the
 * routing service only after its exact original isolate is available, so
 * provider plugins can immediately register without a startup race. The
 * injection fiber also withdraws this service if the original goes away.
 */
export default {
  inject: OrdinarySubagentController.inject,
  Config: OrdinarySubagentController.Config,
  apply(ctx: Context, config: Config): void {
    let armed = false
    const arm = () => {
      if (armed) return
      const rows = [...ctx.loader.entries()].filter(entry => entry.options.id === 'subagent'
        && entry.options.name === '@deepseek-ai/dsh-subagent')
      const entry = rows[0]
      if (rows.length !== 1 || !entry || entry.disabled || entry.options.isolate?.subagents !== true) {
        throw new Error('The original subagent package root must remain enabled in its own service isolate')
      }
      // The Loader creates the entry-local realm only after its module import
      // finishes. Observe that public context-patch event instead of assuming
      // import order, manufacturing a realm, or polling private Loader state.
      if (!entry.realm) return
      armed = true
      officialProviderScope(ctx, 'subagent').inject(['subagents'], (ready: Context) => {
        const publicLabel = ctx[Context.isolate].subagents
        if (publicLabel === undefined) throw new Error('The public subagent service scope is unavailable')
        // The publishing fiber must itself carry the public isolate label.
        // Constructing a service directly on a derived private fiber would
        // notify only its private label and strand early public consumers.
        ready.isolate('subagents', publicLabel).plugin({
          inject: OrdinarySubagentController.inject,
          // The package-root Config has already resolved volatile values.
          // Preserve that exact object rather than validating it a second time.
          apply(publicCtx: Context) { new OrdinarySubagentController(publicCtx, config) },
        })
      })
    }
    ctx.on('loader/patch-context', (entry, next) => {
      next()
      if (entry.options.id === 'subagent') arm()
    }, { global: true })
    arm()
  },
}
