/** Native Codex commands and workspace references in the official input pipeline. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ClientSessionContext, CommandClaim, InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { HhpiRemoteApi } from '../hhpi-api.ts'
import type { SourceSession } from '../remote/protocol.ts'
import type { NativeActionKind } from './remote-operation-contracts.ts'
import { sourceIsOffline } from '../shared/source-connectivity.ts'
import type { RemoteSourceSession } from './remote-sessions.ts'
import { CODEX_SKILL_REFERENCE, CODEX_PLUGIN_REFERENCE, readNativeReferences, nativeReferencePart } from './remote-structured-input.ts'
import { SourceSessionReferences } from './source-session-references.ts'
import type { WorkspaceController } from './controller.ts'
import type {} from './workspace-ui.ts'
import type {} from './source-workspace-client.ts'

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const commands = {
  compact: ['压缩上下文', 'Compact context'], review: ['审查未提交更改', 'Review changes'],
  fork: ['分支会话', 'Fork conversation'], rename: ['重命名会话', 'Rename conversation'],
  plan: ['切换计划 / 执行模式', 'Switch plan / execution mode'],
  model: ['设置模型', 'Set model'], effort: ['设置推理强度', 'Set reasoning effort'],
} as const
export function codexInputSources(api: HhpiRemoteApi, sourceOf: (id: SessionId) => SourceSession | undefined, zh: () => boolean, ownerOf: (id: SessionId) => RemoteSourceSession | undefined = () => undefined, references?: SourceSessionReferences): InputTriggerSource[] {
  // A missing reply pins the original request. A repeated submit reads its receipt,
  // and a changed draft cannot silently replace that unresolved native operation.
  const metadataOf = (session: ClientSessionContext) => session.binding ? (session.binding.session as RemoteSourceSession).metadata?.getSnapshot() : sourceOf(session.sessionId)
  const ownerFor = (session: ClientSessionContext) => (session.binding?.session as RemoteSourceSession | undefined) ?? ownerOf(session.sessionId)
  const claimOf = (session: ClientSessionContext, name: string): CommandClaim | undefined => {
    const id = session.sessionId
    if (!(name in commands) || !metadataOf(session)?.codex) return undefined
    return { name, token: `/${name} `, attachments: false, hint: commands[name as keyof typeof commands][zh() ? 0 : 1],
      async submit(args, _ctx, attachments) {
        const source = metadataOf(session)
        if (!source?.codex || !api.nativeCall) return { kind: 'error', text: '原 Codex 会话不可用。草稿已保留。' }
        if (attachments.length) return { kind: 'error', text: '此命令不接受附件，请先移除附件。' }
        const sessionOwner = ownerFor(session), owner = sessionOwner?.nativeActions
        if (!owner || !sessionOwner) return { kind: 'error', text: '原生操作服务尚未接通，草稿已保留。' }
        if (sourceIsOffline(source)) return { kind: 'error', text: '来源离线，草稿已保留。' }
        const value = args.trim(); let method: string, params: Record<string, unknown>
        if (name === 'rename') { if (!value) return { kind: 'error', text: '请输入新的会话名称。' }; method = 'thread/name/set'; params = { name: value } }
        else if (name === 'model' || name === 'effort') {
          if (!value) return { kind: 'error', text: name === 'model' ? '请输入模型 ID，或使用输入框的模型选择器。' : '请输入推理强度，或使用输入框的推理强度选择器。' }
          method = 'thread/settings/update'; params = { [name === 'model' ? 'model' : 'effort']: value }
        } else if (name === 'plan') {
          const mode = record(source.codex.settings?.collaborationMode) ? source.codex.settings.collaborationMode.mode : undefined
          if (value && !['plan', 'default'].includes(value)) return { kind: 'error', text: '可选值为 plan 或 default。' }
          method = 'thread/settings/update'; params = { collaborationMode: { mode: value || (mode === 'plan' ? 'default' : 'plan'), settings: { model: source.codex.model, reasoning_effort: source.codex.reasoningEffort, developer_instructions: null } } }
        } else {
          if (value) return { kind: 'error', text: '此命令不接受额外文字。草稿已保留。' }
          method = name === 'compact' ? 'thread/compact/start' : name === 'review' ? 'review/start' : 'thread/fork'
          params = name === 'review' ? { target: { type: 'uncommittedChanges' }, delivery: 'inline' } : name === 'fork' ? { excludeTurns: true } : {}
        }
        const kind: NativeActionKind = name === 'model' || name === 'effort' ? 'settings' : name as NativeActionKind
        const intent = kind === 'plan' ? 'settings' : kind
        try {
          await owner.restore()
          const original = owner.get(id, intent)
          const directory = sessionOwner.sourceDirectory()
          const capabilities = await directory?.capabilities()
          if (capabilities?.methods[method] !== 'write') return { kind: 'error', text: capabilities?.unavailable[method] ?? '来源未提供此命令，草稿已保留。' }
          // An implicit /plan toggle must retain its original meaning after metadata changes.
          if (original?.kind === 'plan' && original.request.params && !value && !['accepted', 'rejected'].includes(original.phase)) params = original.request.params
          let result = await owner.submit({ sessionId: id, intent, kind, newAttempt: true,
            request: { sourceId: source.sourceId, method, params: { threadId: source.nativeId, ...params } } })
          if (original && !['accepted', 'rejected', 'prepared'].includes(original.phase)) result = await owner.recover(id, intent) ?? result
          return { kind: result.phase === 'accepted' ? 'success' : 'error', text: result.outcome?.message ?? '原请求已保留，等待源端确认。' }
        } catch (error) { return { kind: 'error', text: `${error instanceof Error ? error.message : String(error)}；草稿与原请求已保留。` } }
      },
    }
  }
  const referenceSource = (trigger: '/' | '@', name: string, namespace: string): InputTriggerSource => ({ trigger, name, order: -40,
    async candidates(session, request) {
      const metadata = metadataOf(session), directory = ownerFor(session)?.sourceDirectory()
      if (!metadata?.codex || !directory || sourceIsOffline(metadata)) return []
      const references = await readNativeReferences(directory, metadata, namespace, request.signal)
      const query = request.query.toLowerCase()
      return references.filter(row => `${row.name} ${row.label} ${row.description}`.toLowerCase().includes(query))
        .map(row => ({ name: row.name, label: row.label, value: row.ref, description: row.description }))
    },
    onPick: pick => pick.candidate.value ? { insert: { source: name, ref: pick.candidate.value, label: pick.candidate.label ?? pick.candidate.name,
      clipboardText: `${trigger}${pick.candidate.name}` } } : undefined,
    codec: { clipboardText: ref => `${trigger}${ref}`,
      async serialize(ref, signal, session) {
        if (!session) throw new Error('The exact reference Session is unavailable. Your draft has been kept.')
        const metadata = metadataOf(session), directory = ownerFor(session)?.sourceDirectory()
        if (!metadata?.codex || !directory) throw new Error('The native reference source is unavailable. Your draft has been kept.')
        const references = await readNativeReferences(directory, metadata, namespace, signal)
        const selected = references.find(row => row.ref === ref)
        if (!selected) throw new Error('The selected skill or plugin is no longer available. Your draft has been kept.')
        return nativeReferencePart(selected)
      },
    },
  })
  return [{ trigger: '/', name: 'codex-native', order: -50,
    candidates: async (session, request) => metadataOf(session)?.codex && request.position === 'leading'
      ? Object.entries(commands).filter(([name, labels]) => `${name} ${labels.join(' ')}`.toLowerCase().includes(request.query.toLowerCase())).map(([name, labels]) => ({ name, description: labels[zh() ? 0 : 1] })) : [],
    onPick: pick => { const claim = claimOf(pick.session, pick.candidate.name); return claim ? { claim } : undefined },
    matchSpace: (session, token) => { const claim = claimOf(session, token.slice(1)); return claim ? { claim } : undefined },
    matchEnter: async (session, line, signal) => { signal.throwIfAborted(); const claim = claimOf(session, /^\/([^\s]+)/u.exec(line)?.[1] ?? ''); return claim ? { claim } : undefined },
    matchClaim: async (session, token, signal) => { signal.throwIfAborted(); return claimOf(session, token.slice(1)) },
  }, { trigger: '@', name: 'codex-files', order: -50,
    async candidates(session, request) {
      const source = metadataOf(session)
      if (!source?.codex || !source.cwd || !api.nativeCall) return []
      const response = await api.nativeCall({ sourceId: source.sourceId,
        method: request.query ? 'fuzzyFileSearch' : 'fs/readDirectory',
        params: request.query ? { query: request.query, roots: [source.cwd] } : { path: source.cwd } }, request.signal)
      request.signal.throwIfAborted()
      if (!response.ok) throw new Error(response.error.message)
      if (response.value.status !== 'accepted') throw new Error(response.value.message)
      const data = response.value.result
      if (!record(data)) throw new Error('Invalid native file catalog')
      const rows = request.query ? data.files : data.entries
      if (!Array.isArray(rows)) throw new Error('Invalid native file catalog')
      return rows.slice(0, 80).flatMap(row => {
        if (!record(row)) return []
        const path = typeof row.path === 'string' ? row.path : typeof row.fileName === 'string' ? row.fileName : typeof row.name === 'string' ? row.name : undefined
        if (!path) return []
        const root = typeof row.root === 'string' ? row.root : source.cwd!
        const absolute = /^(?:[A-Za-z]:[\\/]|\/|\\\\)/u.test(path) ? path : `${root.replace(/[\\/]$/u, '')}/${path}`
        return [{ name: path, icon: 'file' as const, value: absolute, description: root }]
      })
    },
    onPick: pick => pick.candidate.value ? { insert: { source: 'codex-files', ref: pick.candidate.value, label: pick.candidate.name, appearance: 'file', clipboardText: `@${JSON.stringify(pick.candidate.value)}` } } : undefined,
    codec: { clipboardText: ref => `@${JSON.stringify(ref)}`, serialize: async (ref, signal) => { signal.throwIfAborted(); return `Referenced workspace path: ${JSON.stringify(ref)}` } },
  }, referenceSource('/', 'codex-skills', CODEX_SKILL_REFERENCE), referenceSource('@', 'codex-plugins', CODEX_PLUGIN_REFERENCE), {
    trigger: '@', name: 'source-sessions', order: -30, showGroupTitle: false,
    async candidates(session, request) {
      return metadataOf(session)?.codex && references ? references.candidates(session.sessionId, request.query, request.signal)
        .map(row => ({ ...row, section: zh() ? '会话' : 'Conversations', icon: 'session' as const })) : []
    },
    onPick: pick => pick.candidate.value ? { insert: { source: 'source-sessions', ref: pick.candidate.value,
      label: pick.candidate.label ?? pick.candidate.name, appearance: 'session', clipboardText: `@${JSON.stringify(pick.candidate.label ?? pick.candidate.name)}` } } : undefined,
    codec: { clipboardText: () => '@conversation', async serialize(ref, signal, session) {
      if (!references || !session || !metadataOf(session)?.codex) throw new Error('The original conversation reference service is unavailable. Your draft has been kept.')
      return references.serialize(session.sessionId, ref, signal)
    } },
  }]
}
export function installRemoteInputTriggers(ctx: Context, api: HhpiRemoteApi, workspace?: WorkspaceController, hostId?: string): () => void {
  const sessions = ctx.sessions, locale = ctx.locale
  const fiber = ctx.inject(['inputTriggers'], owner => {
    const authority = ctx.get('hhpiSessions'), ui = ctx.get('hapiWorkspaceUi')
    // The primary shell has no per-graph transport service. The navigation
    // owner supplies this graph's actual Host instead of inferring it here.
    const references = workspace && hostId && authority && ui ? new SourceSessionReferences({ hostId,
      workspace, application: ui.application, capture: id => authority.captureWorkspaceAccess(id) }) : undefined
    const sources = codexInputSources(api, id => (sessions.binding(id)?.session as RemoteSourceSession | undefined)?.metadata?.getSnapshot(), () => locale.getSnapshot().active.startsWith('zh'), id => sessions.binding(id)?.session as RemoteSourceSession | undefined, references)
    const stops = sources.map(source => owner.inputTriggers.registerSource(source))
    return () => { for (const stop of stops) stop() }
  })
  return () => { void fiber.dispose() }
}
