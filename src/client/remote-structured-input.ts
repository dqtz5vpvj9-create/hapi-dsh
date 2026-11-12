/** Typed composer references are resolved under their exact source Session before native admission. */
import type { PromptReferencePart, SessionPromptContentPart } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SourceSession } from '../remote/protocol.ts'
import type { NativeActionOwner } from './remote-native-actions.ts'
import type { SourceDirectory } from './source-capabilities.ts'
import { sourceIsOffline } from '../shared/source-connectivity.ts'

export const CODEX_SKILL_REFERENCE = 'hhpi:codex:skill'
export const CODEX_PLUGIN_REFERENCE = 'hhpi:codex:plugin'
export const supportsCodexReference = (source: string): boolean => source === CODEX_SKILL_REFERENCE || source === CODEX_PLUGIN_REFERENCE
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
export interface NativeReference { source: string; ref: string; name: string; label: string; description: string }
export type NativeComposerInput = { type: 'text'; text: string; text_elements: never[] }
  | { type: 'skill' | 'mention'; name: string; path: string }
  | { type: 'image'; url: string } | { type: 'localImage'; path: string }
export function skillReferences(value: unknown): NativeReference[] {
  if (!record(value) || !Array.isArray(value.data)) throw new Error('Invalid native skill catalog.')
  return value.data.flatMap(group => record(group) && Array.isArray(group.skills) ? group.skills.flatMap(skill => {
    if (!record(skill) || skill.enabled !== true || typeof skill.name !== 'string' || typeof skill.path !== 'string') return []
    const ui = record(skill.interface) ? skill.interface : undefined
    return [{ source: CODEX_SKILL_REFERENCE, ref: skill.path, name: skill.name, label: typeof ui?.displayName === 'string' ? ui.displayName : skill.name,
      description: typeof ui?.shortDescription === 'string' ? ui.shortDescription : typeof skill.description === 'string' ? skill.description : '' }]
  }) : [])
}
export function pluginReferences(value: unknown): NativeReference[] {
  if (!record(value) || !Array.isArray(value.marketplaces)) throw new Error('Invalid native plugin catalog.')
  return value.marketplaces.flatMap(marketplace => record(marketplace) && typeof marketplace.name === 'string' && Array.isArray(marketplace.plugins)
    ? marketplace.plugins.flatMap(plugin => {
      if (!record(plugin) || plugin.installed !== true || plugin.enabled !== true || plugin.availability !== 'AVAILABLE' || plugin.disabledReason
        || typeof plugin.name !== 'string') return []
      const ui = record(plugin.interface) ? plugin.interface : undefined
      return [{ source: CODEX_PLUGIN_REFERENCE, ref: `plugin://${plugin.name}@${marketplace.name}`, name: plugin.name,
        label: typeof ui?.displayName === 'string' ? ui.displayName : plugin.name,
        description: typeof ui?.shortDescription === 'string' ? ui.shortDescription : '' }]
    }) : [])
}
export async function readNativeReferences(directory: SourceDirectory, metadata: SourceSession, source: string, signal?: AbortSignal): Promise<NativeReference[]> {
  if (!metadata.codex || !supportsCodexReference(source)) throw new Error('This source does not support the selected reference.')
  const method = source === CODEX_SKILL_REFERENCE ? 'skills/list' : 'plugin/installed'
  const value = await directory.read(method, { cwds: [metadata.cwd] }, signal)
  return source === CODEX_SKILL_REFERENCE ? skillReferences(value) : pluginReferences(value)
}
/** The payload matched the saved original write, but its native receipt is still uncertain. */
export class NativeSubmissionPending extends Error {
  constructor(message: string, readonly clientUserMessageId: string) { super(message) }
}
export interface StructuredInputOwner {
  readonly nativeActions?: NativeActionOwner | undefined
  sourceDirectory(): SourceDirectory | undefined
}
export async function submitRemoteStructuredInput(owner: StructuredInputOwner, metadata: SourceSession, content: readonly SessionPromptContentPart[], mode: 'queue' | 'steer', requestId: string,
  resolveUploads: (receiptIds: readonly string[], signal?: AbortSignal, clientUserMessageId?: string) => Promise<NativeComposerInput[]>, signal?: AbortSignal): Promise<string> {
  const actions = owner.nativeActions, directory = owner.sourceDirectory()
  if (!actions || !directory || !metadata.codex) throw new Error('The native structured input service is unavailable. Your draft has been kept.')
  if (sourceIsOffline(metadata)) throw new Error('The source is offline. Your draft has been kept.')
  const assertCurrent = actions.captureAuthorization(metadata.id)
  await actions.restore()
  assertCurrent()
  const intent = 'composer'
  const original = actions.get(metadata.id, intent)
  // Rechecking the same confirmed ID must validate its immutable payload and
  // return that result. It is never a new attempt or a different carrier.
  const retained = original && (original.request.operationId === requestId || !['accepted', 'rejected'].includes(original.phase)) ? original : undefined
  const method = retained?.request.method ?? (mode === 'steer' ? 'turn/steer' : 'thread/queue/add')
  if (method !== (mode === 'steer' ? 'turn/steer' : 'thread/queue/add')) throw new Error('The original composer operation has a different delivery mode. Check its original result first.')
  const capabilities = await directory.capabilities(signal)
  assertCurrent()
  if (capabilities.methods[method] !== 'write') throw new Error(capabilities.unavailable[method] ?? 'This source does not support structured composer input.')
  const catalogs = new Map<string, NativeReference[]>()
  const inputs: NativeComposerInput[] = []
  // Resolve every receipt through the source service, which checks the exact Session.
  // The browser never guesses a source path or embeds private receipt objects in Codex input.
  const clientUserMessageId = retained?.request.params?.clientUserMessageId ?? requestId
  const receipts = content.flatMap(part => part.type === 'file' ? [part.receiptId] : [])
  const uploaded = await resolveUploads(receipts, signal, String(clientUserMessageId))
  assertCurrent()
  let uploadIndex = 0
  for (const part of content) {
    signal?.throwIfAborted()
    if (part.type === 'reference') {
      if (!supportsCodexReference(part.source)) throw new Error('The selected reference belongs to an unsupported provider.')
      let rows = catalogs.get(part.source)
      if (!rows) { rows = await readNativeReferences(directory, metadata, part.source, signal); assertCurrent(); catalogs.set(part.source, rows) }
      const selected = rows.find(row => row.ref === part.ref)
      if (!selected) throw new Error('The selected skill or plugin is no longer available in this source. Your draft has been kept.')
      inputs.push({ type: part.source === CODEX_SKILL_REFERENCE ? 'skill' : 'mention', name: selected.name, path: selected.ref })
    } else if (part.type === 'text') inputs.push({ type: 'text', text: part.text, text_elements: [] })
    else if (part.type === 'image') inputs.push({ type: 'image', url: `data:${part.mediaType};base64,${part.data}` })
    else {
      const input = uploaded[uploadIndex++]
      if (!input) throw new Error('The source did not resolve every uploaded attachment. Your draft has been kept.')
      inputs.push(input)
    }
  }
  if (uploaded.length !== receipts.length) throw new Error('The source returned unrelated upload inputs. Your draft has been kept.')
  signal?.throwIfAborted()
  assertCurrent()

  const expectedTurnId = retained?.request.params?.expectedTurnId ?? metadata.activeTurnId
  if (mode === 'steer' && typeof expectedTurnId !== 'string') throw new Error('There is no exact active native turn to steer.')
  const params = { threadId: metadata.nativeId, clientUserMessageId, input: inputs, ...(mode === 'steer' ? { expectedTurnId } : {}) }
  let result = await actions.submit({ sessionId: metadata.id, intent, kind: 'queue', newAttempt: !retained,
    request: { sourceId: metadata.sourceId, operationId: retained?.request.operationId ?? requestId, method, params } })
  if (retained && !['accepted', 'rejected', 'prepared'].includes(retained.phase)) result = await actions.recover(metadata.id, intent) ?? result
  if (result.phase === 'rejected') throw new Error(result.outcome?.message ?? 'The native submission was rejected. Your draft has been kept.')
  if (result.phase !== 'accepted') throw new NativeSubmissionPending(result.outcome?.message ?? 'The original native submission is waiting for confirmation. Your draft has been kept.', String(clientUserMessageId))
  return String(clientUserMessageId)
}
export function nativeReferencePart(reference: NativeReference): PromptReferencePart {
  return { type: 'reference', source: reference.source, ref: reference.ref, label: reference.label }
}
