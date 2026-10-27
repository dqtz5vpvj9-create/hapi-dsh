import { createHash } from 'node:crypto'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { HapiSession } from '../codex/contracts.js'
import { record } from '../codex/native.js'

export interface ObservedBinding {
  hubId: string; hapiSessionId: string; flavor: string; nativeId: string | null; machineId: string | null
}

export function observedSessionId(hubId: string, sourceId: string): SessionId {
  return SessionId(`hapi-observed-${createHash('sha256').update(JSON.stringify([hubId, sourceId])).digest('hex').slice(0, 32)}`)
}

export function observedBinding(hubId: string, source: HapiSession): ObservedBinding {
  const m = source.metadata
  if (m?.codexNativeSession === true) throw new Error('Native Codex belongs to the native Codex service')
  const flavor = m?.flavor || 'claude'
  return { hubId, hapiSessionId: source.id, flavor, nativeId: observedNativeId(flavor, m), machineId: m?.machineId ?? null }
}

export function observedNativeId(flavor: string, metadata: unknown): string | null {
  const fields: Record<string, string> = { claude: 'claudeSessionId', codex: 'codexSessionId', pi: 'piSessionId', dsh: 'dshSessionId',
    qoder: 'qoderSessionId', gemini: 'geminiSessionId', opencode: 'opencodeSessionId', grok: 'grokSessionId',
    agy: 'agySessionId', cursor: 'cursorSessionId', kimi: 'kimiSessionId', copilot: 'copilotSessionId' }
  const key = fields[flavor], value = key ? record(metadata)?.[key] : undefined
  return typeof value === 'string' && value.length ? value : null
}

/** Null→identified native locator is launch readiness, not a replacement thread. */
export function sameObservedIdentity(previous: ObservedBinding, next: ObservedBinding): boolean {
  return previous.hubId === next.hubId && previous.hapiSessionId === next.hapiSessionId
    && previous.flavor === next.flavor && previous.machineId === next.machineId
    && (previous.nativeId === null || previous.nativeId === next.nativeId)
}

export function observedCapabilities(source: HapiSession) {
  const m = source.metadata
  const flavor = m?.flavor || 'claude'
  const known = ['claude', 'codex', 'pi', 'dsh', 'qoder', 'gemini', 'opencode', 'grok', 'agy', 'cursor', 'kimi', 'copilot'].includes(flavor)
  const history = m?.capabilities?.conversationHistory
  const controlled = source.agentState?.controlledByUser === true && m?.capabilities?.concurrentClients !== true
  return {
    steer: flavor === 'codex' || flavor === 'pi'
      || flavor === 'cursor' && m?.cursorSessionProtocol !== 'stream-json' && (!m?.cursorSessionId || m.cursorSessionProtocol === 'acp')
      || flavor === 'dsh' && m?.dshCapabilities?.steering === true,
    switchToRemote: controlled,
    images: m?.acpPromptCapabilities?.image ?? (flavor === 'dsh' ? m?.dshCapabilities?.images === true : known),
    forkCurrent: history?.forkCurrent === true,
    forkAtMessage: history?.forkAtMessage === true && m?.conversationHistoryDiverged !== true,
    rewindToMessage: history?.rewindToMessage === true && m?.conversationHistoryDiverged !== true,
    model: known && !(controlled && ['codex', 'cursor', 'grok'].includes(flavor)),
    effort: ['claude', 'grok', 'dsh', 'pi', 'qoder', 'codex', 'opencode'].includes(flavor)
      && !(controlled && ['codex', 'grok', 'opencode'].includes(flavor)),
    permissions: known && flavor !== 'pi',
  }
}

/** The revision-free display id; a display successor keeps the logical id. */
export function logicalDisplayId(displayId: string): SessionId {
  return SessionId(displayId.replace(/-r\d+$/, ''))
}
