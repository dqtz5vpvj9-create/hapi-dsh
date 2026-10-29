import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { freezeMessage, MessageId, type ContentBlock, type MessageSource } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime, { type Config, type SubagentActivation, type SubagentActivationSpec,
  type SubagentCatalogEntry, type SubagentDescendantListEntry, type SubagentInterruptAuthority,
  type SubagentInterruptReceipt, type SubagentPromptReceipt, type SubagentPromptRequest,
  type SubagentProvider, type SubagentSendMessageOptions, type SubagentDelivery } from '@deepseek-ai/dsh-subagent'
import { deliverSubagentPrompt, queueHostSubagentPrompt, steerHostSubagentPrompt,
  type HostPromptDeliverer } from '@deepseek-ai/dsh-subagent/internal'
import { canonicalClientTimeZone } from '@deepseek-ai/dsh-util-time'
import { Remote, RemoteError, TypertRemoteService, principalOf } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import { officialProviderContext, officialProviderScope } from '../shared/official-provider.ts'
import { canonicalJson } from '../codex/native.ts'
import { isSourceChildDisplayId } from '../codex/session-controller.ts'
import { isHapiDshChildAgent, type HapiDshChildAgent } from './dsh-children.ts'
import { assertOrdinarySourceTarget } from '../shared/source-access.ts'
import { sourceDshChildCommandIdSchema } from './dsh-child-types.ts'

const addressSchema = z.object({ childSessionId: z.string().min(1), parentSessionId: z.string().min(1), mode: z.literal('continuable') })
const promptSchema = addressSchema.extend({ requestId: z.string().min(1).max(128), delivery: z.enum(['queue', 'steer']),
  content: z.array(z.object({ type: z.literal('text'), text: z.string() })).min(1), clientTimeZone: z.string().optional() })
const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex')

/**
 * Public service composition over the original isolated package-root provider.
 * Only exact registered source-child identities have different execution
 * ownership. Ordinary delegation, lifecycle, discovery and prompt operations
 * retain the original service and current Invocation without a second manager.
 */
export class SourceAwareSubagentController extends TypertRemoteService implements HostPromptDeliverer {
  static inject = ['loader', 'agents', 'workingDirectory']
  static Config = SubagentRuntime.Config
  constructor(ctx: Context, _config: Config) { super(ctx, 'subagents') }
  private get ordinary(): SubagentRuntime {
    const original = officialProviderContext(this.ctx, 'subagent').get('subagents')
    if (!original) throw new Error('The isolated official subagent provider has not started')
    return original
  }
  private sourceChild(childId: SessionId, parentId: SessionId): HapiDshChildAgent {
    const child = this.ctx.agents.get(childId)
    if (!isHapiDshChildAgent(child) || !child.owner.isCurrent()) throw new RemoteError('subagent/not-resumable',
      'This source child is unavailable or is a read-only original transcript. It must never resume as a local DSH Agent.', { childSessionId: childId })
    if (child.parentSessionId !== parentId || this.ctx.agents.get(parentId) !== child.owner.agent
      || !this.ctx.agents.isOwnedBy(childId, child.owner.agent)) throw new RemoteError('subagent/unauthorized',
      'The original source child does not belong to this exact live parent', { childSessionId: childId })
    if (child.state.descriptor.mode !== 'continuable') throw new RemoteError('subagent/not-resumable',
      'The original DSH source reports that this child cannot be continued', { childSessionId: childId })
    return child
  }

  @Remote('prompt')
  async prompt(request: SubagentPromptRequest, signal: AbortSignal): Promise<SubagentPromptReceipt> {
    assertOrdinarySourceTarget(request.childSessionId); assertOrdinarySourceTarget(request.parentSessionId)
    if (!isSourceChildDisplayId(request.childSessionId)) return this.ordinary.prompt(request, signal)
    signal.throwIfAborted()
    const parsed = promptSchema.safeParse(request)
    if (!parsed.success) {
      if (request.content.some(part => part.type !== 'text')) throw new RemoteError('subagent/attachment-invalid',
        'The original HAPI DSH-child protocol accepts text only. The attachment has not been sent or discarded.', { reason: 'SOURCE_CHILD_TEXT_ONLY' })
      throw new RemoteError('gateway/bad-request', 'Invalid original DSH child prompt', { issues: parsed.error.issues })
    }
    const zone = request.clientTimeZone === undefined ? undefined : canonicalClientTimeZone(request.clientTimeZone)
    if (request.clientTimeZone !== undefined && zone === undefined) throw new RemoteError('subagent/invalid-time-zone',
      'clientTimeZone must be UTC or a valid IANA Area/Location name', { value: request.clientTimeZone })
    const child = this.sourceChild(request.childSessionId, request.parentSessionId), principal = principalOf(this.ctx.invocation)
    if (!sourceDshChildCommandIdSchema.safeParse(request.requestId).success) throw new RemoteError('subagent/delivery-unavailable',
      'Use the visible /child command to continue this original DSH child. Its source history omits prompt correlation, so the ordinary Send path cannot settle its own message echo. Your draft has not been sent.',
      { childSessionId: child.id })
    // This local delivery identity is deterministic across duplicate RPCs and
    // restarts. It is never substituted for the source transcript's ordinal id.
    const id = MessageId(`hapi-dsh-child-request:${hash([child.binding, request.requestId, principal ?? null]).slice(0, 48)}`)
    const message = freezeMessage({ id, role: 'user', content: parsed.data.content,
      source: { kind: 'user', rpcId: request.requestId, ...(zone === undefined ? {} : { clientTimeZone: zone }),
        ...(principal === undefined ? {} : { principal }) } })
    signal.throwIfAborted()
    try { child.send(message, request.delivery === 'steer' ? 'next-step' : 'next-turn', true) }
    catch (error) { throw new RemoteError('subagent/delivery-unavailable', error instanceof Error ? error.message : 'The source child did not admit the message',
      { childSessionId: child.id }, { cause: error }) }
    // Acceptance is the durable local intent. The original source receipt and
    // any unknown outcome remain separately visible in hapiObserved.dshChild.
    return { messageId: id }
  }

  @Remote('interruptByParent')
  interruptByParent(childSessionId: SessionId, parentSessionId: SessionId, mode: 'continuable'): SubagentInterruptReceipt {
    assertOrdinarySourceTarget(childSessionId); assertOrdinarySourceTarget(parentSessionId)
    if (!isSourceChildDisplayId(childSessionId)) return this.ordinary.interruptByParent(childSessionId, parentSessionId, mode)
    const parsed = addressSchema.safeParse({ childSessionId, parentSessionId, mode })
    if (!parsed.success) throw new RemoteError('gateway/bad-request', 'Invalid source child interrupt address', { issues: parsed.error.issues })
    const child = this.sourceChild(childSessionId, parentSessionId)
    try { child.cancel({ kind: 'user' }) }
    catch (error) { throw new RemoteError('subagent/delivery-unavailable', error instanceof Error ? error.message : 'The source child did not admit the interrupt',
      { childSessionId }, { cause: error }) }
    return { accepted: true }
  }

  resolveMaxDepth(configured?: number | 'provider-managed'): number | undefined { return this.ordinary.resolveMaxDepth(configured) }
  startActivation(spec: SubagentActivationSpec & { readonly childId: SessionId }): Promise<SubagentActivation & { readonly messageId: MessageId }>
  startActivation(spec: SubagentActivationSpec): Promise<SubagentActivation>
  startActivation(spec: SubagentActivationSpec): Promise<SubagentActivation> { return this.ordinary.startActivation(spec) }
  waitForChildren(parent: Agent): Promise<boolean> { return this.ordinary.waitForChildren(parent) }
  sendMessage(sender: Agent, targetId: SessionId, content: ContentBlock[], options: SubagentSendMessageOptions): Promise<MessageId> {
    assertOrdinarySourceTarget(sender.id); assertOrdinarySourceTarget(targetId)
    if (isSourceChildDisplayId(targetId)) return Promise.reject(new RemoteError('subagent/not-resumable',
      'This original source child accepts its source browser prompt protocol; local model delivery cannot impersonate its native parent.', { childSessionId: targetId }))
    return this.ordinary.sendMessage(sender, targetId, content, options)
  }
  /** Preserve the package-exported host adapter used by the official Agent Team plugin. */
  [deliverSubagentPrompt](parent: Agent, childId: SessionId, content: ContentBlock[], source: MessageSource,
    signal: AbortSignal, delivery: SubagentDelivery): Promise<MessageId> {
    assertOrdinarySourceTarget(parent.id); assertOrdinarySourceTarget(childId)
    if (isSourceChildDisplayId(childId)) return Promise.reject(new RemoteError('subagent/not-resumable',
      'The original source child cannot receive a local host protocol message as its native parent.', { childSessionId: childId }))
    const deliver = delivery === 'steer' ? steerHostSubagentPrompt : queueHostSubagentPrompt
    return deliver(this.ordinary, parent, childId, content, source, signal)
  }
  interrupt(targetSessionId: SessionId, authority: SubagentInterruptAuthority): void {
    assertOrdinarySourceTarget(targetSessionId)
    if (!isSourceChildDisplayId(targetSessionId)) { this.ordinary.interrupt(targetSessionId, authority); return }
    if (authority.kind !== 'user') throw new RemoteError('subagent/unauthorized',
      'The original source child requires its exact parent address for a user interrupt', { childSessionId: targetSessionId })
    this.interruptByParent(targetSessionId, authority.parentSessionId, 'continuable')
  }
  drainDescendants(parents: readonly Agent[]): Promise<void> { return this.ordinary.drainDescendants(parents) }
  drainChildren(parent: Agent, childIds: readonly SessionId[]): Promise<void> { return this.ordinary.drainChildren(parent, childIds) }
  listChildren(parentSessionId: SessionId, signal?: AbortSignal): Promise<SubagentCatalogEntry[]> { assertOrdinarySourceTarget(parentSessionId); return this.ordinary.listChildren(parentSessionId, signal) }
  listDescendants(rootSessionId: SessionId, signal?: AbortSignal): Promise<SubagentDescendantListEntry[]> { assertOrdinarySourceTarget(rootSessionId); return this.ordinary.listDescendants(rootSessionId, signal) }
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
  inject: SourceAwareSubagentController.inject,
  Config: SourceAwareSubagentController.Config,
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
          inject: SourceAwareSubagentController.inject,
          // The package-root Config has already resolved volatile values.
          // Preserve that exact object rather than validating it a second time.
          apply(publicCtx: Context) { new SourceAwareSubagentController(publicCtx, config) },
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
