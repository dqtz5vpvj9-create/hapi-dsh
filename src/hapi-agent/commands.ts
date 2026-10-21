import { CommandDefinitionId } from '@deepseek-ai/dsh-commands'
import { freezeMessage, MessageId } from '@deepseek-ai/dsh-llm'
import type { HapiObservedAgent } from './agent.js'

/** Source commands shadow matching official commands in this Agent scope only. */
export function bindObservedCommands(agent: HapiObservedAgent): void {
  agent.ctx.inject(['commands'], ctx => {
    const registered = new Set<string>()
    let disposed = false
    ctx.effect(() => () => { disposed = true }, 'observed source command lifetime')
    const register = (name: string, description: string): void => {
      if (registered.has(name) || !/^[a-z][a-z0-9_-]*$/.test(name)) return
      // Mark before register: public commands/change is emitted synchronously.
      registered.add(name)
      ctx.commands.register({ definitionId: CommandDefinitionId(`hapi-dsh/observed/${name}`), name,
        description: description || `Send /${name} to the original HAPI ${agent.binding.flavor} owner`,
        input: { hint: `Source /${name} arguments`, attachments: true },
        handler: input => {
          if (input.agent !== agent) throw new Error('The source command belongs to a different Session')
          if (input.signal.aborted) throw new Error('The source command was cancelled before admission')
          agent.followup(freezeMessage({ id: MessageId(`hapi-command:${input.commandId}`), role: 'user',
            source: { kind: 'user', rpcId: `source-command:${input.commandId}` },
            content: [{ type: 'text', text: `/${name}${input.rawInput}` }, ...input.attachments] }))
          return { kind: 'success', text: 'Submitted to the original HAPI owner. Source delivery and feedback determine the outcome.' }
        },
      })
    }
    const shadow = (): void => {
      for (const entry of ctx.commands.list(agent)) register(entry.name, `Original HAPI ${agent.binding.flavor} /${entry.name}`)
    }
    ctx.on('commands/change', shadow)
    shadow()
    void agent.transport.listSlashCommands?.(agent.binding.hapiSessionId).then(entries => {
      if (!disposed) for (const entry of entries) register(entry.name.toLowerCase(), entry.description)
    }).catch(() => { /* The source owns unavailable/unknown command feedback. */ })
  })
}
