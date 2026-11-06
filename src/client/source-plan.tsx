import { useMemo, useState, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { HhpiRemoteApi } from '../hhpi-api.ts'
import type { CodexCall, CodexCallResult } from '../remote/codex-access.ts'
import type { SourceSession } from '../remote/protocol.ts'
import type { RemoteSourceSession } from './remote-sessions.ts'
import { sourceIsOffline } from '../shared/source-connectivity.ts'

export function proposedPlanText(blocks: readonly { kind: string; text?: string }[]): string | null {
    const text = blocks.filter(block => block.kind === 'text').map(block => block.text ?? '').join('\n')
    return /<proposed_plan>\s*([\s\S]+?)\s*<\/proposed_plan>/u.exec(text)?.[1]?.trim() || null
}
interface PlanRequest { request: CodexCall; result?: CodexCallResult }
/** Save the intent before dispatch; remounts check its receipt instead of sending it again. */
export class SourcePlanOperation {
    private busy = false
    constructor(private api: HhpiRemoteApi, private storage: Pick<Storage, 'getItem' | 'setItem'>, private key: string) {}
    read(): PlanRequest | null { const raw = this.storage.getItem(this.key); return raw ? JSON.parse(raw) as PlanRequest : null }
    async submit(metadata: SourceSession, text: string, mode: 'default' | 'plan'): Promise<CodexCallResult | null> {
        if (this.busy) return null
        this.busy = true
        try {
            const previous = this.read()
            if (previous && previous.result?.status !== 'rejected') return await this.check(previous)
            if (!this.api.nativeCall || !metadata.codex?.model || sourceIsOffline(metadata) || metadata.status !== 'idle') throw new Error('The source must be idle and report its model before this plan can start.')
            const operationId = crypto.randomUUID()
            const request: CodexCall = { sourceId: metadata.sourceId, method: 'turn/start', operationId, params: {
                threadId: metadata.nativeId, clientUserMessageId: operationId,
                input: [{ type: 'text', text: `${mode === 'default' ? 'Implement this plan.' : 'Continue planning; do not implement yet.'}\n\n${text}` }],
                collaborationMode: { mode, settings: { model: metadata.codex.model, reasoning_effort: metadata.codex.reasoningEffort ?? null, developer_instructions: null } },
            } }
            const pending: PlanRequest = { request }; this.storage.setItem(this.key, JSON.stringify(pending))
            let result: CodexCallResult
            try { const response = await this.api.nativeCall(request); result = response.ok ? response.value : { status: 'indeterminate', message: response.error.message } }
            catch (error) { result = { status: 'indeterminate', message: error instanceof Error ? error.message : String(error) } }
            this.storage.setItem(this.key, JSON.stringify({ request, result })); return result
        } finally { this.busy = false }
    }
    async check(saved = this.read()): Promise<CodexCallResult | null> {
        if (!saved) return null
        if (saved.result?.status === 'accepted') return saved.result
        if (!this.api.nativeReceipt) return { status: 'indeterminate', message: 'Awaiting the original request receipt.' }
        const response = await this.api.nativeReceipt(saved.request)
        if (!response.ok) throw new Error(response.error.message)
        this.storage.setItem(this.key, JSON.stringify({ ...saved, result: response.value })); return response.value
    }
}

const none = () => () => {}, empty = () => undefined
export function SourcePlanActions({ ctx, sessionId, planId, text, session: supplied }: {
    ctx: Context; sessionId: SessionId; planId: string; text: string; session?: RemoteSourceSession | undefined
}) {
    const session = supplied ?? ctx.sessions.binding(sessionId)?.session as RemoteSourceSession | undefined
    const metadata = useSyncExternalStore(session?.metadata.subscribe ?? none, session?.metadata.getSnapshot ?? empty)
    const operation = useMemo(() => new SourcePlanOperation(ctx.remote.hhpi, localStorage, `hhpi-plan-action:${sessionId}:${planId}`), [ctx, sessionId, planId])
    const [busy, setBusy] = useState(false), [result, setResult] = useState<CodexCallResult | null>(() => {
        try { const saved = operation.read(); return saved ? saved.result ?? { status: 'indeterminate', message: '' } : null } catch { return null }
    }), [error, setError] = useState('')
    const zh = ctx.locale.getSnapshot().active.startsWith('zh')
    const run = async (mode?: 'default' | 'plan') => {
        if (!metadata) return
        setBusy(true); setError('')
        try { setResult(mode ? await operation.submit(metadata, text, mode) : await operation.check()) }
        catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
        finally { setBusy(false) }
    }
    const disabled = busy || !metadata?.capabilities.send || metadata.status !== 'idle' || sourceIsOffline(metadata) || !metadata.codex?.model || result?.status === 'accepted' || result?.status === 'indeterminate'
    return <section className="hhpi-plan-actions" aria-label={zh ? '计划操作' : 'Plan actions'}>
        <div><button type="button" disabled={disabled} onClick={() => { void run('default') }}>{zh ? '实施计划' : 'Implement plan'}</button>
            <button type="button" disabled={disabled} onClick={() => { void run('plan') }}>{zh ? '继续规划' : 'Continue planning'}</button></div>
        {result && <p role="status">{result.status === 'accepted' ? zh ? '源端已接收，执行进度见正文。' : 'Accepted by the source. Progress appears in this conversation.' : result.status === 'indeterminate' ? zh ? '结果待确认，不会重复发送。' : 'Awaiting confirmation; this will not be sent again.' : result.message}</p>}
        {result?.status === 'indeterminate' && <button type="button" disabled={busy} onClick={() => { void run() }}>{zh ? '检查原请求结果' : 'Check original request'}</button>}
        {error && <p role="alert">{error}</p>}
    </section>
}
