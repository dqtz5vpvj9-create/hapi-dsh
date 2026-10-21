import { CommandDefinitionId, type CommandDefinition } from '@deepseek-ai/dsh-commands'
import { freezeMessage, MessageId } from '@deepseek-ai/dsh-llm'
import type { NativeCodexAgent } from './agent.js'
import type { HapiSlashCommand } from './contracts.js'

/** The pinned shared Codex owner handles these before native queue admission. */
const builtins: readonly HapiSlashCommand[] = [
  { name: 'clear', description: 'Start a new native Codex conversation through HAPI' },
  { name: 'new', description: 'Start a new native Codex conversation through HAPI' },
  { name: 'compact', description: 'Compact the current native Codex context' },
  { name: 'goal', description: 'View, set, pause, resume, or clear the native Codex goal' },
  { name: 'help', description: 'Show commands supported by the native HAPI Codex owner' },
  { name: 'plan', description: 'Set native Codex plan mode; /plan off returns to default' },
  { name: 'default', description: 'Return native Codex collaboration mode to default' },
  { name: 'execute', description: 'Return native Codex collaboration mode to default' },
  { name: 'status', description: 'Show the source-native Codex configuration' },
  { name: 'model', description: 'Show or set the source-native Codex model' },
  { name: 'reasoning', description: 'Show or set native Codex reasoning effort' },
  { name: 'effort', description: 'Alias for native Codex /reasoning' },
  { name: 'fast', description: 'Show or change the source-native Codex service tier' },
  { name: 'personality', description: 'Show or set native Codex response style' },
  { name: 'permissions', description: 'Show or set native Codex permissions' },
  { name: 'permission', description: 'Alias for native Codex /permissions' },
  { name: 'exit', description: 'Show native Codex session lifecycle guidance' },
]

/**
 * Public per-Agent command registration shadows only this native Session's
 * matching DSH commands. The source still parses every line and owns any
 * mutation; neither a DSH goal nor a DSH compaction driver is invoked.
 * Discovery is optional so an offline source retains its known command names.
 */
export function bindNativeCommands(agent: NativeCodexAgent): void {
  agent.ctx.inject(['commands'], ctx => {
    const entries = new Map<string, { fingerprint: string; dispose(): void }>()
    let disposed = false
    ctx.effect(() => () => { disposed = true }, 'native command discovery lifetime')
    const register = (command: HapiSlashCommand): void => {
      // DSH's documented command grammar does not accept ':'; native custom
      // names outside it still pass as ordinary input to the owning HAPI CLI.
      const name = command.name.toLowerCase()
      if (!/^[a-z][a-z0-9_-]*$/.test(name)) return
      const description = command.description.trim() || `Run /${name} through the native HAPI Codex owner`
      const fingerprint = JSON.stringify([name, description])
      if (entries.get(name)?.fingerprint === fingerprint) return
      entries.get(name)?.dispose()
      const definition: CommandDefinition = {
        definitionId: CommandDefinitionId(`hapi-dsh/native-codex/${name}`), name, description,
        input: { hint: `Native /${name} arguments`, attachments: true },
        handler: invocation => {
          if (invocation.agent !== agent) throw new Error('Native command scope does not match the owning Codex session')
          if (invocation.signal.aborted) throw new Error('Native command was cancelled before submission')
          const message = freezeMessage({
            id: MessageId(`hapi-command:${invocation.commandId}`), role: 'user',
            source: { kind: 'user', rpcId: `native-command:${invocation.commandId}` },
            content: [{ type: 'text', text: `/${name}${invocation.rawInput}` }, ...invocation.attachments],
          })
          // DeliveryJournal durably claims this identity before dispatch. Its
          // queue/source receipts, not this command lifecycle, prove execution.
          agent.followup(message)
          return { kind: 'success', text: 'Submitted to the HAPI native owner. Check native delivery and source feedback for the outcome.' }
        },
      }
      entries.set(name, { fingerprint, dispose: ctx.commands.register(definition) })
    }
    for (const command of builtins) register(command)
    if (agent.transport.listSlashCommands) {
      void agent.transport.listSlashCommands(agent.binding.hapiSessionId).then(commands => {
        if (!disposed) for (const command of commands) register(command)
      }).catch(() => {
        // Command discovery failure does not fabricate capabilities or make a
        // writable source read-only. The pinned builtins remain source-checked.
      })
    }
  })
}
