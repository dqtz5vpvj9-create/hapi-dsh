import { randomId } from './random-id.ts'
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { remoteValue, type HapiRemoteApi } from '../client-api.ts'
import { sourceOperationSchema, sourceOperationReceiptSchema, type SourceAction, type SourceOperation,
    type SourceOperationReceipt, type SourceSessionTools } from '../hapi-agent/lifecycle-types.ts'

type Api = Pick<HapiRemoteApi, 'sourceSessionTools' | 'sourceOperation' | 'sourceOperationRead'>
type RecoveryStore = Pick<Storage, 'getItem' | 'setItem'>
type Snapshot = {
    data: SourceSessionTools | null; loading: boolean; busy: boolean; error: string | null;
    intents: SourceOperation[]; receipts: SourceOperationReceipt[];
}
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error)
const final = (receipt: SourceOperationReceipt): boolean => receipt.status === 'confirmed' || receipt.status === 'rejected'
const words = (language?: string) => (en: string, zh: string): string =>
    (language ?? globalThis.document?.documentElement.lang ?? '').toLowerCase().startsWith('zh') ? zh : en

/** A source acknowledgement alone never opens a guessed or not-yet-attached child. */
export function sourceOperationDisplayId(receipt: SourceOperationReceipt): string | undefined {
    const result = receipt.result
    if (receipt.status !== 'confirmed' || !result || typeof result !== 'object' || Array.isArray(result)) return undefined
    return result.displayReady === true && typeof result.sessionId === 'string' && result.sessionId ? result.sessionId : undefined
}
/** Only a confirmed source continuation may hand drafts to a successor. */
export function sourceOperationSuccessorId(receipt: SourceOperationReceipt): string | undefined {
    return receipt.action.kind === 'reopen' || receipt.action.kind === 'resume' ? sourceOperationDisplayId(receipt) : undefined
}
export function sourceActionEnabled(data: SourceSessionTools | null, action: SourceAction): boolean {
    if (!data) return false
    return action.kind === 'fork' ? action.displayMessageSeq !== undefined || action.displayMessageId !== undefined
        ? data.capabilities.forkAtMessage : data.capabilities.forkCurrent : data.capabilities[action.kind]
}
const needsObservation = (receipt: SourceOperationReceipt): boolean => !final(receipt)
    || receipt.status === 'confirmed' && ['fork', 'clear', 'reopen', 'resume', 'rewind'].includes(receipt.action.kind)
    && sourceOperationDisplayId(receipt) === undefined
const conflicts = (left: SourceAction, right: SourceAction): boolean =>
    left.kind === right.kind || !['summary', 'pin'].includes(left.kind) && !['summary', 'pin'].includes(right.kind)

/**
 * Browser recovery only observes immutable operations. The HAPI mutation is sent
 * once, after its identity has been retained locally and in the host journal.
 */
export class SourceLifecycleController {
    private state: Snapshot = { data: null, loading: false, busy: false, error: null, intents: [], receipts: [] }
    private readonly listeners = new Set<() => void>()
    private reading: Promise<void> | undefined
    private readonly inspections = new Map<string, Promise<SourceOperationReceipt | null>>()
    private readonly storageKey: string
    private observers = 0
    private timer: ReturnType<typeof setInterval> | undefined
    constructor(private readonly api: Api, readonly sessionId: string, private readonly storage?: RecoveryStore,
        private readonly nextId: () => string = () => randomId()) {
        this.storageKey = `hapi-dsh:source-lifecycle:${sessionId}`
        try {
            const saved: unknown = JSON.parse(storage?.getItem(this.storageKey) ?? 'null')
            if (saved && typeof saved === 'object' && 'version' in saved && saved.version === 1) {
                const intents = 'intents' in saved && Array.isArray(saved.intents) ? saved.intents : []
                const receipts = 'receipts' in saved && Array.isArray(saved.receipts) ? saved.receipts : []
                this.state.intents = intents.flatMap(value => {
                    const parsed = sourceOperationSchema.safeParse(value)
                    return parsed.success && parsed.data.sessionId === sessionId ? [parsed.data] : []
                })
                const owned = new Set(this.state.intents.map(value => value.operationId))
                this.state.receipts = receipts.flatMap(value => {
                    const parsed = sourceOperationReceiptSchema.safeParse(value)
                    return parsed.success && owned.has(parsed.data.operationId) ? [parsed.data] : []
                })
            }
        } catch { /* The authoritative host journal is still read below. */ }
    }
    getSnapshot = (): Snapshot => this.state
    subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
    private publish(value: Partial<Snapshot>): void { this.state = { ...this.state, ...value }; for (const listener of this.listeners) listener() }
    private persist(): void {
        try { this.storage?.setItem(this.storageKey, JSON.stringify({ version: 1, intents: this.state.intents, receipts: this.state.receipts })) }
        catch { /* The host claim remains durable if browser storage is unavailable. */ }
    }
    private accept(receipt: SourceOperationReceipt): void {
        const previous = this.state.receipts.find(value => value.operationId === receipt.operationId)
        if (previous && (previous.updatedAt > receipt.updatedAt || final(previous) && !final(receipt))) return
        this.publish({ receipts: [...this.state.receipts.filter(value => value.operationId !== receipt.operationId), receipt]
            .sort((a, b) => b.createdAt - a.createdAt) })
        this.persist()
    }
    unresolved(): Array<{ operationId: string; action: SourceAction }> {
        const result = new Map<string, { operationId: string; action: SourceAction }>()
        for (const intent of this.state.intents) {
            const receipt = this.state.receipts.find(value => value.operationId === intent.operationId)
            if (!receipt || !final(receipt)) result.set(intent.operationId, intent)
        }
        for (const receipt of this.state.receipts) if (!final(receipt)) result.set(receipt.operationId, receipt)
        return [...result.values()]
    }
    canRun(action: SourceAction): boolean {
        return !this.state.busy && this.state.data?.sessionId === this.sessionId && sourceActionEnabled(this.state.data, action)
            && !this.unresolved().some(value => conflicts(value.action, action))
    }
    refresh = (): Promise<void> => {
        if (this.reading) return this.reading
        this.publish({ loading: true })
        this.reading = (async () => {
            let error: string | null = null
            try {
                const data = remoteValue(await this.api.sourceSessionTools({ sessionId: this.sessionId }))
                this.publish({ data })
                for (const receipt of data.operations) this.accept(receipt)
            } catch (failure) { error = errorText(failure) }
            // Also recover an intent whose host reply was lost before it could
            // appear in the session tools response (including deleted displays).
            const ids = new Set(this.state.intents.filter(intent => {
                const receipt = this.state.receipts.find(value => value.operationId === intent.operationId)
                return !receipt || needsObservation(receipt)
            }).map(value => value.operationId))
            for (const receipt of this.state.receipts) if (needsObservation(receipt)) ids.add(receipt.operationId)
            const inspected = await Promise.all([...ids].map(id => this.inspect(id)))
            if (inspected.some(value => value === null)) error ??= this.state.error
            this.publish({ error })
        })().finally(() => { this.reading = undefined; this.publish({ loading: false }) })
        return this.reading
    }
    watch(): () => void {
        this.observers++
        if (this.observers === 1) {
            void this.refresh()
            this.timer = setInterval(() => { void this.refresh() }, 3000)
        }
        return () => { this.observers--; if (this.observers === 0 && this.timer) { clearInterval(this.timer); this.timer = undefined } }
    }
    async run(action: SourceAction): Promise<SourceOperationReceipt | null> {
        if (!this.canRun(action)) return null
        const request = sourceOperationSchema.parse({ operationId: this.nextId(), sessionId: this.sessionId, action })
        this.publish({ busy: true, error: null, intents: [...this.state.intents, request] }); this.persist()
        let result: SourceOperationReceipt | null = null
        try {
            result = remoteValue(await this.api.sourceOperation(request)); this.accept(result)
            if (result.status === 'rejected') this.publish({ error: result.message })
        } catch (failure) {
            this.publish({ error: errorText(failure) })
            // An HTTP/WebSocket failure cannot establish non-admission. Keep
            // the same operation ID and only ask the host what it recorded.
            result = await this.inspect(request.operationId)
        } finally { this.publish({ busy: false }) }
        return result
    }
    inspect = (operationId: string): Promise<SourceOperationReceipt | null> => {
        const previous = this.inspections.get(operationId)
        if (previous) return previous
        const flight = (async () => {
            try {
                const receipt = remoteValue(await this.api.sourceOperationRead({ operationId, action: 'read' }))
                this.accept(receipt); return receipt
            } catch (error) { this.publish({ error: errorText(error) }); return null }
        })().finally(() => { if (this.inspections.get(operationId) === flight) this.inspections.delete(operationId) })
        this.inspections.set(operationId, flight); return flight
    }
}

const controllers = new WeakMap<Api, Map<string, SourceLifecycleController>>()
function controllerFor(api: Api, sessionId: string): SourceLifecycleController {
    let sessions = controllers.get(api)
    if (!sessions) { sessions = new Map(); controllers.set(api, sessions) }
    let controller = sessions.get(sessionId)
    if (!controller) {
        let storage: Storage | undefined
        try { storage = globalThis.localStorage } catch { /* Browser privacy mode. */ }
        controller = new SourceLifecycleController(api, sessionId, storage); sessions.set(sessionId, controller)
    }
    return controller
}
function useSourceLifecycle(api: Api, sessionId: string, active = true) {
    const controller = useMemo(() => controllerFor(api, sessionId), [api, sessionId])
    const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
    useEffect(() => active ? controller.watch() : undefined, [controller, active])
    return { controller, state }
}
function actionLabel(kind: SourceAction['kind'], tr: ReturnType<typeof words>): string {
    return { archive: tr('Archive session', '归档会话'), reopen: tr('Reopen session', '重新打开会话'),
        resume: tr('Resume session', '继续会话'), restart: tr('Restart agent', '重启 Agent'),
        delete: tr('Delete session', '删除会话'), clear: tr('Start a fresh conversation', '清空并开始新会话'),
        summary: tr('Save summary', '保存摘要'), pin: tr('Pin session', '置顶会话'),
        fork: tr('Fork conversation', '分叉会话'), rewind: tr('Rewind here', '回退到此处') }[kind]
}
function confirmationText(action: SourceAction, tr: ReturnType<typeof words>): string {
    switch (action.kind) {
        case 'archive': return tr('Archive this session and stop its live agent?', '归档这个会话并停止它正在运行的 Agent？')
        case 'restart': return tr('Restart the original agent process? Its next input resumes through the same Runner.', '重启原 Agent 进程？下一条消息仍由原 Runner 继续处理。')
        case 'delete': return tr('Permanently delete this session and its HAPI history?', '永久删除这个会话及其 HAPI 历史记录？')
        case 'clear': return tr('Create a fresh conversation through the original source?', '通过原会话所属的引擎开始新的聊天？')
        case 'rewind': return tr('Rewind the original conversation to this invoked user message?', '将原始会话回退到这条已经执行的用户消息？')
        case 'fork': return action.displayMessageSeq === undefined && action.displayMessageId === undefined
            ? tr('Create a new branch at the current source history?', '在原会话的当前历史位置创建新分支？')
            : tr('Create a new branch at this invoked user message?', '从这条已经执行的用户消息创建新分支？')
        default: return tr('Apply this change to the original source?', '将这项修改应用到原会话？')
    }
}

function SourceReceipts({ controller, state, onOpen, onSuccessor, language, operationId }: {
    controller: SourceLifecycleController; state: Snapshot; onOpen?: ((id: string) => void) | undefined;
    onSuccessor?: ((displaySessionId: string) => void) | undefined;
    language?: string | undefined; operationId?: string | undefined;
}) {
    const tr = words(language)
    const labels = { submitting: tr('Submitting', '提交中'), submitted: tr('Accepted; awaiting source readiness', '已接受，等待原会话就绪'),
        confirmed: tr('Confirmed by source', '原会话已确认'), rejected: tr('Not executed', '未执行'),
        indeterminate: tr('Result unknown', '结果尚未确认') }
    const receipts = operationId ? state.receipts.filter(row => row.operationId === operationId) : state.receipts
    const unconfirmed = state.intents.filter(row => !state.receipts.some(receipt => receipt.operationId === row.operationId)
        && (!operationId || row.operationId === operationId))
    if (!receipts.length && !unconfirmed.length) return null
    return <div className="hapi-operation-status" aria-live="polite">
        {unconfirmed.map(row => <div key={row.operationId}>
            <p role="status">{actionLabel(row.action.kind, tr)} · {tr('The reply was not recorded yet. Check this same operation.', '尚未记录操作回执，请查询同一操作。')}</p>
            <code>{row.operationId}</code><button type="button" onClick={() => { void controller.inspect(row.operationId) }}>{tr('Check result', '查询结果')}</button>
        </div>)}
        {receipts.map(row => {
            const displayId = sourceOperationDisplayId(row)
            return <div key={row.operationId} data-source-operation={row.operationId} data-source-operation-state={row.status}>
                <p role="status"><strong>{actionLabel(row.action.kind, tr)} · {labels[row.status]}</strong>{row.message ? ` · ${row.message}` : ''}</p>
                <details><summary>{tr('Operation details', '操作详情')}</summary><code>{row.operationId}</code>
                    <p>{tr('Checking reads the recorded result. It does not submit this action again.', '查询只读取已记录的结果，不会再次提交这项操作。')}</p>
                    {row.sourceCode && <p>{row.sourceCode}</p>}
                    <button type="button" onClick={() => { void controller.inspect(row.operationId) }}>{tr('Check result', '查询结果')}</button>
                </details>
                {displayId && onOpen && <button type="button" onClick={() => (sourceOperationSuccessorId(row) ? onSuccessor ?? onOpen : onOpen)(displayId)}>{tr('Open conversation', '打开聊天')}</button>}
            </div>
        })}
    </div>
}

export function SourceSessionToolsPanel({ api, sessionId, onOpen, onSuccessor, language, active = true, initialAction }: {
    api: HapiRemoteApi; sessionId: string; onOpen: (id: string) => void; language?: string | undefined;
    onSuccessor?: ((displaySessionId: string) => void) | undefined;
    active?: boolean | undefined; initialAction?: 'fork' | 'archive' | 'reopen' | 'pin' | 'restart' | 'delete' | undefined;
}) {
    const tr = words(language), { controller, state } = useSourceLifecycle(api, sessionId, active)
    const [summary, setSummary] = useState(''), [editing, setEditing] = useState(false)
    const [confirmation, setConfirmation] = useState<SourceAction | null>(initialAction && initialAction !== 'pin' ? { kind: initialAction } : null)
    useEffect(() => { setEditing(false); setConfirmation(initialAction && initialAction !== 'pin' ? { kind: initialAction } : null) }, [controller, initialAction])
    useEffect(() => { if (!editing) setSummary(state.data?.summary ?? '') }, [state.data?.summary, editing])
    const perform = async (action: SourceAction) => {
        const receipt = await controller.run(action)
        if (receipt) setConfirmation(null)
        if (receipt?.status === 'confirmed') {
            setEditing(false)
            const displayId = sourceOperationDisplayId(receipt)
            if (displayId && displayId !== sessionId) (sourceOperationSuccessorId(receipt) ? onSuccessor ?? onOpen : onOpen)(displayId)
            if (action.kind !== 'delete') void controller.refresh()
        }
    }
    const data = state.data
    return <section className="hapi-native-session-tools" aria-label={tr('Session tools', '会话操作')}>
        {state.loading && !data && <p role="status">{tr('Reading source capabilities…', '正在读取原会话能力…')}</p>}
        {state.error && <p className="hapi-error" role="alert">{state.error}</p>}
        {data && <>
            <p>{data.flavor} · {data.lifecycleState ?? (data.active ? tr('active', '运行中') : tr('inactive', '未运行'))}</p>
            {data.sessionId !== sessionId && <p role="status">{tr('This history display was replaced. Open the current source view to make changes.', '这份历史视图已经更新，请打开原会话的当前视图后操作。')}
                <button type="button" onClick={() => onOpen(data.sessionId)}>{tr('Open current view', '打开当前视图')}</button></p>}
            <details open><summary>{tr('Summary & pin', '摘要与置顶')}</summary>
                <label>{tr('Pin', '置顶')}<select value={data.pinMode} disabled={!controller.canRun({ kind: 'pin', mode: data.pinMode })}
                    onChange={event => { void perform({ kind: 'pin', mode: event.currentTarget.value as 'none' | 'project' | 'global' }) }}>
                    <option value="none">{tr('Not pinned', '不置顶')}</option><option value="project">{tr('In project', '目录内置顶')}</option><option value="global">{tr('Everywhere', '全局置顶')}</option>
                </select></label>
                <form onSubmit={event => { event.preventDefault(); void perform({ kind: 'summary', text: summary.trim() }) }}>
                    <label>{tr('Session summary', '会话摘要')}<textarea maxLength={255} value={summary} disabled={!data.capabilities.summary}
                        onChange={event => { setEditing(true); setSummary(event.currentTarget.value) }}/></label>
                    <button type="submit" disabled={!editing || !summary.trim() || !controller.canRun({ kind: 'summary', text: summary.trim() })}>{tr('Save summary', '保存摘要')}</button>
                </form>
            </details>
            <div className="hapi-button-row">
                {(['reopen', 'resume', 'archive', 'restart', 'delete', 'clear', 'fork'] as const).filter(kind => sourceActionEnabled(data, { kind })).map(kind =>
                    <button key={kind} type="button" disabled={!controller.canRun({ kind })} onClick={() => {
                        if (kind === 'resume' || kind === 'reopen') void perform({ kind }); else setConfirmation({ kind })
                    }}>{actionLabel(kind, tr)}</button>)}
            </div>
            {data.warnings.map((warning, index) => <p key={index}>{warning}</p>)}
        </>}
        {confirmation && <div role="group" className="hapi-native-confirm" aria-label={tr('Confirm session operation', '确认会话操作')}>
            <p>{confirmationText(confirmation, tr)}</p>
            {!controller.canRun(confirmation) && <p>{tr('The source must permit this action, with no conflicting unresolved operation.', '需要原会话允许这项操作，且没有结果未确认的冲突操作。')}</p>}
            <button type="button" disabled={!controller.canRun(confirmation)} onClick={() => { void perform(confirmation) }}>{tr('Confirm', '确认')}</button>
            <button type="button" disabled={state.busy} onClick={() => setConfirmation(null)}>{tr('Cancel', '取消')}</button>
        </div>}
        <details open={controller.unresolved().length > 0}><summary>{tr('Operation history & recovery', '操作历史与恢复')}</summary>
            <SourceReceipts controller={controller} state={state} onOpen={onOpen} onSuccessor={onSuccessor} language={language}/>
        </details>
        <button type="button" disabled={state.loading} onClick={() => { void controller.refresh() }}>{tr('Refresh source state', '刷新原会话状态')}</button>
    </section>
}

/** Mounted beside the official user row; the conversation renderer is unchanged. */
export function SourceHistoryAction({ api, sessionId, messageId, kind, onOpen, onChanged, language }: {
    api: HapiRemoteApi; sessionId: string; messageId: string; kind: 'rewind' | 'fork';
    onOpen?: ((id: string) => void) | undefined; onChanged?: (() => void) | undefined; language?: string | undefined;
}) {
    const tr = words(language), { controller, state } = useSourceLifecycle(api, sessionId)
    const [confirm, setConfirm] = useState(false), [operationId, setOperationId] = useState<string | undefined>()
    const action: SourceAction = { kind, displayMessageId: messageId }
    const matching = state.intents.findLast(row => row.action.kind === kind && row.action.displayMessageId === messageId)
    const selectedId = operationId ?? matching?.operationId
    useEffect(() => { setConfirm(false); setOperationId(undefined) }, [controller, kind, messageId])
    const perform = async () => {
        const receipt = await controller.run(action)
        if (!receipt) return
        setOperationId(receipt.operationId); setConfirm(false)
        if (receipt.status === 'confirmed') {
            const displayId = sourceOperationDisplayId(receipt)
            if (displayId) onOpen?.(displayId)
            onChanged?.()
        }
    }
    if (!sourceActionEnabled(state.data, action) && !selectedId) return null
    return <div className="hapi-native-rewind">
        <button type="button" disabled={!controller.canRun(action)} onClick={() => setConfirm(value => !value)}>
            {kind === 'fork' ? tr('Fork from here', '从此处分叉') : tr('Rewind here', '回退到此处')}
        </button>
        {confirm && <div role="group" aria-label={tr('Confirm history action', '确认历史操作')}>
            <p>{confirmationText(action, tr)}</p>
            <button type="button" disabled={!controller.canRun(action)} onClick={() => { void perform() }}>{tr('Confirm', '确认')}</button>
            <button type="button" disabled={state.busy} onClick={() => setConfirm(false)}>{tr('Cancel', '取消')}</button>
        </div>}
        {state.error && selectedId && <p role="alert" className="hapi-error">{state.error}</p>}
        {selectedId && <SourceReceipts controller={controller} state={state} operationId={selectedId} onOpen={onOpen} language={language}/>} 
    </div>
}
