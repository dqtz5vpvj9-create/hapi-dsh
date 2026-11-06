/** Native Codex commands and workspace references in the official input pipeline. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ClientSessionContext, CommandClaim, InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { HhpiRemoteApi } from '../hhpi-api.ts'
import type { SourceSession } from '../remote/protocol.ts'
import type { CodexCall } from '../remote/codex-access.ts'
import type { RemoteSourceSession } from './remote-sessions.ts'

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const commands = {
  compact: ['压缩上下文', 'Compact context'], review: ['审查未提交更改', 'Review changes'],
  fork: ['分支会话', 'Fork conversation'], rename: ['重命名会话', 'Rename conversation'],
  plan: ['切换计划 / 执行模式', 'Switch plan / execution mode'],
  model: ['设置模型', 'Set model'], effort: ['设置推理强度', 'Set reasoning effort'],
} as const
export function codexInputSources(api: HhpiRemoteApi, sourceOf: (id: SessionId) => SourceSession | undefined, zh: () => boolean): InputTriggerSource[] {
  // A missing reply pins the original request. A repeated submit reads its receipt,
  // and a changed draft cannot silently replace that unresolved native operation.
  const metadataOf = (session: ClientSessionContext) => (session.binding?.session as RemoteSourceSession | undefined)?.metadata?.getSnapshot() ?? sourceOf(session.sessionId)
  const pending = new Map<string, { text: string; request: CodexCall; busy: boolean }>()
  const claimOf = (session: ClientSessionContext, name: string): CommandClaim | undefined => {
    const id = session.sessionId
    if (!(name in commands) || !metadataOf(session)?.codex) return undefined
    return { name, token: `/${name} `, attachments: false, hint: commands[name as keyof typeof commands][zh() ? 0 : 1],
      async submit(args, _ctx, attachments) {
        const source = metadataOf(session)
        if (!source?.codex || !api.nativeCall) return { kind: 'error', text: '原 Codex 会话不可用。草稿已保留。' }
        if (attachments.length) return { kind: 'error', text: '此命令不接受附件，请先移除附件。' }
        const text = JSON.stringify([name, args]), saved = pending.get(id)
        if (saved && (saved.busy || saved.text !== text)) return { kind: 'error', text: '上一条命令仍待确认，请保留原命令并检查其结果。' }
        const value = args.trim(); let method: string, params: Record<string, unknown>
        if (name === 'rename') { if (!value) return { kind: 'error', text: '请输入新的会话名称。' }; method = 'thread/name/set'; params = { name: value } }
        else if (name === 'model' || name === 'effort') {
          if (!value) return { kind: 'error', text: name === 'model' ? '请输入模型 ID，或使用输入框的模型选择器。' : '请输入推理强度，或使用输入框的推理强度选择器。' }
          method = 'thread/settings/update'; params = { [name === 'model' ? 'model' : 'reasoningEffort']: value }
        } else if (name === 'plan') {
          const mode = record(source.codex.settings?.collaborationMode) ? source.codex.settings.collaborationMode.mode : undefined
          if (value && !['plan', 'default'].includes(value)) return { kind: 'error', text: '可选值为 plan 或 default。' }
          method = 'thread/settings/update'; params = { collaborationMode: { mode: value || (mode === 'plan' ? 'default' : 'plan'), settings: { model: source.codex.model, reasoning_effort: source.codex.reasoningEffort, developer_instructions: null } } }
        } else {
          if (value) return { kind: 'error', text: '此命令不接受额外文字。草稿已保留。' }
          method = name === 'compact' ? 'thread/compact/start' : name === 'review' ? 'review/start' : 'thread/fork'
          params = name === 'review' ? { target: { type: 'uncommittedChanges' }, delivery: 'inline' } : name === 'fork' ? { excludeTurns: true } : {}
        }
        const entry = saved ?? { text, request: { sourceId: source.sourceId, method, params: { threadId: source.nativeId, ...params }, operationId: crypto.randomUUID() }, busy: false }
        pending.set(id, entry); entry.busy = true
        try {
          const response = saved ? await api.nativeReceipt?.(entry.request) : await api.nativeCall(entry.request)
          if (!response?.ok) return { kind: 'error', text: response && !response.ok ? response.error.message : '结果待确认，请再次检查原命令。' }
          if (response.value.status === 'indeterminate') return { kind: 'error', text: response.value.message }
          pending.delete(id)
          return { kind: response.value.status === 'accepted' ? 'success' : 'error', text: response.value.message }
        } catch (error) { return { kind: 'error', text: `${error instanceof Error ? error.message : String(error)}；原请求已保留，不会自动重发。` } }
        finally { entry.busy = false }
      },
    }
  }
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
  }]
}
export function installRemoteInputTriggers(ctx: Context, api: HhpiRemoteApi): () => void {
  const sessions = ctx.sessions, locale = ctx.locale
  const fiber = ctx.inject(['inputTriggers'], owner => {
    const sources = codexInputSources(api, id => (sessions.binding(id)?.session as RemoteSourceSession | undefined)?.metadata?.getSnapshot(), () => locale.getSnapshot().active.startsWith('zh'))
    const stops = sources.map(source => owner.inputTriggers.registerSource(source))
    return () => { for (const stop of stops) stop() }
  })
  return () => { void fiber.dispose() }
}
