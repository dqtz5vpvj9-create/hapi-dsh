/** Tests the plugin composition boundary; the ordinary service below is an explicit recording fixture. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-working-directory'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { MessageId, type ContentBlock, type MessageSource } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime, { type SubagentActivationSpec, type SubagentPromptRequest, type SubagentPromptRequestId,
  type SubagentProvider, type SubagentSendMessageOptions, type SubagentInterruptAuthority, type SubagentDelivery } from '@deepseek-ai/dsh-subagent'
import { deliverSubagentPrompt, queueHostSubagentPrompt, steerHostSubagentPrompt } from '@deepseek-ai/dsh-subagent/internal'
import { TYPERT } from '@deepseek-ai/dsh-subagent/typert'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access'
import { validateTypertManifest } from '@deepseek-ai/dsh-typert-loader'
import { TypertRemoteService, Remote, principalOf, type PeerId, type PeerScope, type Principal } from '@deepseek-ai/dsh-typert-protocol'
import plugin, { SourceAwareSubagentController } from '../src/hapi-agent/subagent-controller.ts'
import { officialDelegateFixture } from './official-provider-fixture.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap { 'source-subagent-fixture': { kind: 'source-subagent-fixture' } }
}
type Call = { name: string; args: unknown[]; principal: Principal | undefined }
class RecordingOrdinary extends TypertRemoteService {
  readonly calls: Call[] = []
  readonly accepted = MessageId('accepted-by-original')
  constructor(ctx: Context) { super(ctx, 'subagents') }
  private record(name: string, args: unknown[]) { this.calls.push({ name, args, principal: principalOf(this.ctx.invocation) }) }
  @Remote('prompt')
  async prompt(request: SubagentPromptRequest, signal: AbortSignal) { this.record('prompt', [request, signal]); return { messageId: this.accepted } }
  @Remote('interruptByParent')
  interruptByParent(childSessionId: SessionId, parentSessionId: SessionId, mode: 'continuable') { this.record('interruptByParent', [childSessionId, parentSessionId, mode]); return { accepted: true as const } }
  resolveMaxDepth(value?: number | 'provider-managed') { this.record('resolveMaxDepth', [value]); return value }
  startActivation(spec: SubagentActivationSpec) { this.record('startActivation', [spec]); return Promise.resolve({ marker: 'activation' }) }
  waitForChildren(parent: Agent) { this.record('waitForChildren', [parent]); return Promise.resolve(true) }
  sendMessage(parent: Agent, child: SessionId, content: ContentBlock[], options: SubagentSendMessageOptions) { this.record('sendMessage', [parent, child, content, options]); return Promise.resolve(this.accepted) }
  interrupt(child: SessionId, authority: SubagentInterruptAuthority) { this.record('interrupt', [child, authority]) }
  drainDescendants(parents: readonly Agent[]) { this.record('drainDescendants', [parents]); return Promise.resolve() }
  drainChildren(parent: Agent, children: readonly SessionId[]) { this.record('drainChildren', [parent, children]); return Promise.resolve() }
  listChildren(parent: SessionId, signal?: AbortSignal) { this.record('listChildren', [parent, signal]); return Promise.resolve([]) }
  listDescendants(parent: SessionId, signal?: AbortSignal) { this.record('listDescendants', [parent, signal]); return Promise.resolve([]) }
  registerProvider(provider: SubagentProvider) { this.record('registerProvider', [provider]); return () => { this.record('unregisterProvider', [provider]) } }
  getProvider(name: string) { this.record('getProvider', [name]); return undefined }
  list() { this.record('list', []); return ['original-provider'] }
  [deliverSubagentPrompt](parent: Agent, child: SessionId, content: ContentBlock[], source: MessageSource, signal: AbortSignal, delivery: SubagentDelivery) {
    this.record('hostAdapter', [parent, child, content, source, signal, delivery]); return Promise.resolve(this.accepted)
  }
}
async function mount() {
  const ctx = new Context(); await ctx.plugin(AgentRegistry); await ctx.plugin(TypertRegistry)
  new RemoteAccessService(ctx)
  ctx.provide('workingDirectory', {} as Context['workingDirectory'])
  const isolated = officialDelegateFixture(ctx, 'subagent', {}), entry = [...ctx.loader.entries()][0]!
  return { ctx, isolated, entry, async close() { await ctx.fiber.dispose() } }
}

test('routing provider waits for original module realm and service, and disappears when its delegate is unavailable', async () => {
  const app = await mount()
  try {
    let activeConsumers = 0, consumerStarts = 0
    const consumer = await app.ctx.plugin({ inject: ['subagents'], apply(ctx: Context) {
      activeConsumers++; consumerStarts++
      const disposeProvider = ctx.subagents.registerProvider({ name: 'early-source-fixture' } as SubagentProvider)
      return () => { activeConsumers--; disposeProvider() }
    } })
    assert.equal(activeConsumers, 0)
    const realm = app.entry.realm
    Reflect.deleteProperty(app.entry, 'realm')
    await app.ctx.plugin(plugin)
    assert.equal(app.ctx.get('subagents'), undefined)
    // Mirrors the Loader's public context-patch boundary after module import.
    app.entry.realm = realm
    app.ctx.waterfall('loader/patch-context', app.entry, () => {})
    assert.equal(app.ctx.get('subagents'), undefined)
    const originalFiber = await app.isolated.plugin(RecordingOrdinary)
    await app.ctx.fiber.await()
    await consumer.await()
    assert.ok(app.ctx.get('subagents') instanceof SourceAwareSubagentController)
    assert.ok(app.isolated.get('subagents') instanceof RecordingOrdinary)
    assert.equal(activeConsumers, 1, 'A public consumer installed before either provider must wake when the routing service activates')
    assert.equal(consumerStarts, 1)
    await originalFiber.dispose(); await app.ctx.fiber.await(); await consumer.await()
    assert.equal(app.ctx.get('subagents'), undefined)
    assert.equal(activeConsumers, 0)
    const replacement = await app.isolated.plugin(RecordingOrdinary)
    await consumer.await()
    assert.ok(app.ctx.get('subagents') instanceof SourceAwareSubagentController)
    assert.equal(activeConsumers, 1)
    assert.equal(consumerStarts, 2, 'The same waiting consumer resumes after the exact original provider returns')
    await replacement.dispose(); await consumer.await()
  } finally { await app.close() }
})

test('ordinary public methods and exported Team host adapters delegate unchanged to the single original provider', async () => {
  const app = await mount()
  try {
    await app.isolated.plugin(RecordingOrdinary); await app.ctx.plugin(plugin)
    const wrapper = app.ctx.get('subagents')!, original = app.isolated.get('subagents') as unknown as RecordingOrdinary
    const parent = { id: SessionId('ordinary-parent') } as Agent, child = SessionId('ordinary-child'), signal = new AbortController().signal
    const content: ContentBlock[] = [{ type: 'text', text: 'Ordinary protocol message' }], source: MessageSource = { kind: 'user' }
    const spec: SubagentActivationSpec = { provider: 'original-provider', label: 'Ordinary task', request: { parent, prompt: content }, signal, delivery: 'caller' }
    const provider = { name: 'original-provider' } as SubagentProvider, options = { signal }, authority = { kind: 'user' as const, parentSessionId: parent.id }
    assert.equal(wrapper.resolveMaxDepth(3), 3)
    await wrapper.startActivation(spec); await wrapper.waitForChildren(parent)
    assert.equal(await wrapper.sendMessage(parent, child, content, options), original.accepted)
    wrapper.interrupt(child, authority); await wrapper.drainDescendants([parent]); await wrapper.drainChildren(parent, [child])
    await wrapper.listChildren(parent.id, signal); await wrapper.listDescendants(parent.id, signal)
    const unregister = wrapper.registerProvider(provider); wrapper.getProvider(provider.name); assert.deepEqual(wrapper.list(), ['original-provider']); unregister()
    assert.equal(await queueHostSubagentPrompt(wrapper, parent, child, content, source, signal), original.accepted)
    assert.equal(await steerHostSubagentPrompt(wrapper, parent, child, content, source, signal), original.accepted)
    assert.deepEqual(original.calls.map(call => call.name), ['resolveMaxDepth', 'startActivation', 'waitForChildren', 'sendMessage', 'interrupt',
      'drainDescendants', 'drainChildren', 'listChildren', 'listDescendants', 'registerProvider', 'getProvider', 'list', 'unregisterProvider', 'hostAdapter', 'hostAdapter'])
    assert.equal(original.calls[1]!.args[0], spec); assert.equal(original.calls[3]!.args[0], parent); assert.equal(original.calls[3]!.args[2], content)
    assert.equal(original.calls[13]!.args[5], 'queue'); assert.equal(original.calls[14]!.args[5], 'steer')
    assert.equal(SourceAwareSubagentController.Config, SubagentRuntime.Config)
  } finally { await app.close() }
})

test('ordinary remote delegation keeps the actual current caller Invocation and original authorization manifest', async () => {
  const app = await mount()
  try {
    await app.isolated.plugin(RecordingOrdinary); await app.ctx.plugin(plugin)
    app.ctx.typert.register(validateTypertManifest('@deepseek-ai/dsh-subagent', TYPERT))
    const gateway = new TypertGatewayService(app.ctx, TypertGatewayService.Config({}))
    app.ctx.remoteAccess.registerPolicy('source-subagent-fixture', { bindings: () => [{
      role: { name: 'Fixture controls', resource: 'global', actions: ['subagents/prompt', 'subagents/interruptByParent'] }, resource: { kind: 'global' },
    }] })
    const principal: Principal = { kind: 'source-subagent-fixture' }, signal = new AbortController().signal
    const peer: PeerScope = { id: 'ordinary-subagent-gateway' as PeerId, ctx: app.ctx, principal, signal, interactions: 'answer', dispose: async () => {} }
    const request: SubagentPromptRequest = { requestId: 'ordinary-rpc' as SubagentPromptRequestId, childSessionId: SessionId('ordinary-child'), parentSessionId: SessionId('ordinary-parent'),
      mode: 'continuable', delivery: 'steer', content: [{ type: 'text', text: 'Original ordinary input' }] }
    assert.deepEqual(await gateway.invoke({ peer, namespace: 'subagents', method: 'prompt', args: { request } }), { messageId: 'accepted-by-original' })
    assert.deepEqual(await gateway.invoke({ peer, namespace: 'subagents', method: 'interruptByParent', args: {
      childSessionId: request.childSessionId, parentSessionId: request.parentSessionId, mode: request.mode,
    } }), { accepted: true })
    const original = app.isolated.get('subagents') as unknown as RecordingOrdinary
    assert.deepEqual(original.calls.map(call => [call.name, call.principal]), [['prompt', principal], ['interruptByParent', principal]])
    assert.deepEqual(original.calls[0]!.args[0], request)
  } finally { await app.close() }
})
