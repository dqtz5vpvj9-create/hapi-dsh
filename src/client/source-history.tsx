import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { remoteValue } from '../client-api.ts'
import { sourceHistoryOperationSchema, sourceHistoryReceiptSchema, type PiHistoryEntry, type SourceHistoryAction,
  type SourceHistoryApi, type SourceHistoryOperation, type SourceHistoryPiResult, type SourceHistoryReceipt,
  type SourceHistoryTools } from '../hapi-agent/history-types.ts'

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>
type Snapshot = { busy: boolean; error: string | null; intents: SourceHistoryOperation[]; receipts: SourceHistoryReceipt[]; prepared: string[] }
const words = (language?: string) => (en: string, zh: string) => (language ?? '').toLowerCase().startsWith('zh') ? zh : en
const text = (error: unknown) => error instanceof Error ? error.message : String(error)
const pending = (value: SourceHistoryReceipt) => ['submitting', 'submitted', 'ready-to-connect', 'indeterminate'].includes(value.status)
function storage(): StorageLike | undefined { try { return globalThis.localStorage } catch { return undefined } }
function overlaps(left: SourceHistoryAction, right: SourceHistoryAction): boolean {
  if (left.kind === 'pi-import') return right.kind === 'pi-import' && left.machineId === right.machineId
    && left.piSessionIds.some(id => right.piSessionIds.includes(id))
  return right.kind !== 'pi-import' && left.sessionId === right.sessionId
}

/** Closing/reloading a panel never replays an unknown source migration or reopen. */
export class SourceHistoryController {
  private state: Snapshot = { busy: false, error: null, intents: [], receipts: [], prepared: [] }
  private readonly listeners = new Set<() => void>()
  private readonly reads = new Map<string, Promise<SourceHistoryReceipt | null>>()
  private readonly storageKey: string
  constructor(private readonly api: SourceHistoryApi, scope: string, private readonly saved?: StorageLike,
    private readonly nextId: () => string = () => crypto.randomUUID()) {
    this.storageKey = `hapi-dsh:source-history:${scope}`
    try {
      const value: unknown = JSON.parse(saved?.getItem(this.storageKey) ?? 'null')
      if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1) return
      if ('intents' in value && Array.isArray(value.intents)) this.state.intents = value.intents.flatMap(item => {
        const parsed = sourceHistoryOperationSchema.safeParse(item); return parsed.success ? [parsed.data] : []
      })
      if ('receipts' in value && Array.isArray(value.receipts)) this.state.receipts = value.receipts.flatMap(item => {
        const parsed = sourceHistoryReceiptSchema.safeParse(item); return parsed.success ? [parsed.data] : []
      })
      if ('prepared' in value && Array.isArray(value.prepared)) this.state.prepared = value.prepared.filter((id): id is string =>
        typeof id === 'string' && this.state.intents.some(intent => intent.operationId === id)
          && !this.state.receipts.some(receipt => receipt.operationId === id))
    } catch { /* The Host operation inventory remains authoritative. */ }
  }
  getSnapshot = (): Snapshot => this.state
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish(patch: Partial<Snapshot>) { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener() }
  private persist() {
    if (!this.saved) throw new Error('This browser cannot retain the original history operation. Enable browser storage before submitting it.')
    const serialized = JSON.stringify({ version: 1, intents: this.state.intents, receipts: this.state.receipts, prepared: this.state.prepared })
    this.saved.setItem(this.storageKey, serialized)
    if (this.saved.getItem(this.storageKey) !== serialized) throw new Error('The browser could not retain this history operation. Free browser storage, then submit the same operation ID.')
  }
  accept(receipts: readonly SourceHistoryReceipt[]) {
    const values = new Map(this.state.receipts.map(row => [row.operationId, row]))
    for (const receipt of receipts) {
      const previous = values.get(receipt.operationId)
      if (!previous || previous.updatedAt <= receipt.updatedAt) values.set(receipt.operationId, receipt)
    }
    this.publish({ receipts: [...values.values()].sort((a, b) => b.createdAt - a.createdAt), prepared: this.state.prepared.filter(id => !values.has(id)) })
    try { this.persist() } catch (error) { this.publish({ error: text(error) }) }
  }
  canRun(action: SourceHistoryAction) {
    return !this.state.busy && !this.state.intents.some(intent => {
      const receipt = this.state.receipts.find(row => row.operationId === intent.operationId)
      return overlaps(action, intent.action) && (!receipt || pending(receipt))
    }) && !this.state.receipts.some(receipt => pending(receipt) && overlaps(action, receipt.action))
  }
  async run(action: SourceHistoryAction): Promise<SourceHistoryReceipt | null> {
    if (!this.canRun(action)) return null
    const request = sourceHistoryOperationSchema.parse({ operationId: this.nextId(), action })
    this.publish({ error: null, intents: [...this.state.intents, request], prepared: [...this.state.prepared, request.operationId] })
    return this.submitPrepared(request.operationId)
  }
  /** Only a request known not to have reached the Host can be explicitly submitted. */
  async submitPrepared(operationId: string): Promise<SourceHistoryReceipt | null> {
    const request = this.state.intents.find(intent => intent.operationId === operationId)
    if (this.state.busy || !request || !this.state.prepared.includes(operationId)) return null
    this.publish({ busy: true, error: null })
    try {
      // Preserve the same identity even if the following write fails. Mark it
      // potentially sent durably before invoking the Host, never afterwards.
      this.persist()
      this.publish({ prepared: this.state.prepared.filter(id => id !== operationId) })
      this.persist()
    } catch (error) {
      this.publish({ busy: false, error: text(error), prepared: [...new Set([...this.state.prepared, operationId])] })
      return null
    }
    try { const value = remoteValue(await this.api.sourceHistoryOperation(request)); this.accept([value]); return value }
    catch (error) { this.publish({ error: text(error) }); return this.inspect(request.operationId) }
    finally { this.publish({ busy: false }) }
  }
  inspect(operationId: string): Promise<SourceHistoryReceipt | null> {
    const current = this.reads.get(operationId); if (current) return current
    const work = (async () => {
      try {
        const value = remoteValue(await this.api.sourceHistoryOperationRead({ operationId }))
        if (value) { this.publish({ error: null }); this.accept([value]) }
        else this.publish({ error: 'The original Host receipt is not available. Preserve this operation ID; it has not been re-sent.' })
        return value
      } catch (error) { this.publish({ error: text(error) }); return null }
    })()
    this.reads.set(operationId, work)
    void work.finally(() => { if (this.reads.get(operationId) === work) this.reads.delete(operationId) })
    return work
  }
  async recover(): Promise<void> {
    const ids = new Set(this.state.intents.filter(intent => {
      if (this.state.prepared.includes(intent.operationId)) return false
      const receipt = this.state.receipts.find(row => row.operationId === intent.operationId); return !receipt || pending(receipt)
    }).map(intent => intent.operationId))
    for (const receipt of this.state.receipts) if (pending(receipt)) ids.add(receipt.operationId)
    await Promise.all([...ids].map(id => this.inspect(id)))
  }
  async continue(operationId: string): Promise<SourceHistoryReceipt | null> {
    if (this.state.busy || !this.state.receipts.find(row => row.operationId === operationId)?.canContinue) return null
    this.publish({ busy: true, error: null })
    try { this.persist() } catch (error) { this.publish({ busy: false, error: text(error) }); return null }
    try { const value = remoteValue(await this.api.sourceHistoryContinue({ operationId })); this.accept([value]); return value }
    catch (error) { this.publish({ error: text(error) }); return this.inspect(operationId) }
    finally { this.publish({ busy: false }) }
  }
}

export function filterPiHistory(sessions: readonly PiHistoryEntry[], query: string, directory: string): PiHistoryEntry[] {
  const tokens = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean)
  return sessions.filter(row => (!directory || row.cwd === directory)
    && tokens.every(token => [row.id, row.title, row.lastUserMessage, row.cwd, row.model].some(value => value?.toLocaleLowerCase().includes(token))))
}
export function piHistoryPage(sessions: readonly PiHistoryEntry[], page: number): { rows: readonly PiHistoryEntry[]; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(sessions.length / 50)), current = Math.max(0, Math.min(page, pages - 1))
  return { rows: sessions.slice(current * 50, (current + 1) * 50), page: current, pages }
}
/** A migration acknowledgement or an observed target alone cannot move drafts. */
export function sourceHistorySuccessorId(receipt: SourceHistoryReceipt): string | undefined {
  if (receipt.action.kind === 'pi-import' || receipt.status !== 'confirmed' || !receipt.sessionId) return undefined
  return receipt.observation?.targetObserved === true && receipt.observation.sessionId === receipt.sessionId ? receipt.sessionId : undefined
}
function useController(api: SourceHistoryApi, scope: string) {
  const controller = useMemo(() => new SourceHistoryController(api, scope, storage()), [api, scope])
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  return { controller, state }
}
function OperationReceipts({ controller, onOpen, onSuccessor, language }: {
  controller: SourceHistoryController; onOpen: (id: string) => void;
  onSuccessor?: ((displaySessionId: string) => void) | undefined; language?: string | undefined;
}) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot), tr = words(language)
  const unrecorded = state.intents.filter(intent => !state.receipts.some(row => row.operationId === intent.operationId))
  return <div>
    {state.error && <p role="alert" className="hapi-error">{state.error}</p>}
    {(state.receipts.length > 0 || unrecorded.length > 0) && <h3>{tr('Original operation receipts', '原始操作回执')}</h3>}
    {unrecorded.map(intent => <div key={intent.operationId}><code>{intent.operationId}</code><p>{state.prepared.includes(intent.operationId)
      ? tr('This operation has not been sent. Retain its recovery identity before submitting it.', '此操作尚未发送。保存同一恢复身份后才能提交。')
      : tr('Reply not yet recorded. Read the same operation.', '尚未取得回执。读取同一条操作。')}</p>
      {state.prepared.includes(intent.operationId)
        ? <button type="button" disabled={state.busy} onClick={() => { void controller.submitPrepared(intent.operationId) }}>{tr('Save and submit this operation', '保存并提交同一操作')}</button>
        : <button type="button" onClick={() => { void controller.inspect(intent.operationId) }}>{tr('Read original receipt', '读取原始回执')}</button>}</div>)}
    {state.receipts.map((receipt, index) => <details key={receipt.operationId} open={index === 0 || pending(receipt)}>
      <summary>{receipt.action.kind} · {receipt.status} · {new Date(receipt.createdAt).toLocaleString()}</summary>
      <p><code>{receipt.operationId}</code> · {receipt.phase}</p>{receipt.message && <p role={receipt.status === 'failed' || receipt.status === 'rejected' ? 'alert' : 'status'}>{receipt.message}</p>}
      {receipt.codexResult?.warnings?.map((warning, index) => <p key={index}>{warning}</p>)}
      {receipt.codexResult?.journalPath && <p>{tr('Runner migration journal', 'Runner 迁移记录')}：<code>{receipt.codexResult.journalPath}</code></p>}
      {receipt.cursorResult?.ok && <p>{tr('Replayed notifications', '回放事件数')}：{receipt.cursorResult.replayNotifications} · {receipt.cursorResult.sourceRemoved ? tr('Legacy source removed', '原存储已移除') : tr('Legacy source retained', '原存储已保留')}</p>}
      {receipt.observation && <p>{tr('Observed source', '已观察源状态')}：{receipt.observation.nativeId} · {receipt.observation.codexHome ?? receipt.observation.cursorProtocol}</p>}
      <ul>{receipt.items.map(item => <li key={item.piSessionId}><code>{item.piSessionId}</code> · {item.action ?? item.importState?.state ?? item.confirmation}
        {item.appended !== null && <span> · {tr('Appended', '新增')} {item.appended}</span>}
        {item.error && <p className="hapi-error">{item.error.code}: {item.error.message}</p>}
        {item.sessionId && <button type="button" onClick={() => onOpen(item.sessionId!)}>{tr('Open imported history', '打开导入历史')}</button>}</li>)}</ul>
      <div className="hapi-button-row"><button type="button" disabled={state.busy} onClick={() => { void controller.inspect(receipt.operationId) }}>{tr('Read original receipt', '读取原始回执')}</button>
        {receipt.canContinue && <button type="button" disabled={state.busy} onClick={() => { void controller.continue(receipt.operationId).then(value => { if (value?.status === 'confirmed' && value.sessionId) onOpen(value.sessionId) }) }}>{tr('Continue this imported Pi session', '继续此已导入的 Pi 会话')}</button>}
        {receipt.sessionId && <button type="button" onClick={() => (sourceHistorySuccessorId(receipt) ? onSuccessor ?? onOpen : onOpen)(receipt.sessionId!)}>{tr('Open observed source', '打开已观察到的会话')}</button>}</div>
    </details>)}
  </div>
}

/** Pi catalog filters/pages are local views of the complete list returned by HAPI, not invented source cursors. */
export function SourcePiHistoryPanel({ api, machines, onOpen, language, active = true, initialMachineId }: {
  api: SourceHistoryApi; machines: readonly { id: string; label: string; online: boolean }[];
  onOpen: (id: string) => void; language?: string | undefined; active?: boolean | undefined; initialMachineId?: string | undefined;
}) {
  const tr = words(language), [machineId, setMachineId] = useState(initialMachineId ?? machines.find(row => row.online)?.id ?? machines[0]?.id ?? '')
  const [data, setData] = useState<SourceHistoryPiResult | null>(null), [error, setError] = useState<string | null>(null), [loading, setLoading] = useState(false)
  const [revision, setRevision] = useState(0), [query, setQuery] = useState(''), [directory, setDirectory] = useState(''), [page, setPage] = useState(0)
  const [selected, setSelected] = useState<string[]>([]), { controller, state } = useController(api, `pi:${machineId}`)
  useEffect(() => { if (!machines.some(row => row.id === machineId)) setMachineId(machines.find(row => row.online)?.id ?? machines[0]?.id ?? '') }, [machines, machineId])
  useEffect(() => { setSelected([]); setQuery(''); setDirectory(''); setPage(0); setData(null) }, [machineId])
  useEffect(() => {
    if (!active || !machineId) return
    let disposed = false; setLoading(true)
    void api.sourceHistoryPi({ machineId }).then(remoteValue).then(value => {
      if (disposed) return; setData(value); setError(null); controller.accept(value.operations); void controller.recover()
    }, failure => { if (!disposed) setError(text(failure)) }).finally(() => { if (!disposed) setLoading(false) })
    return () => { disposed = true }
  }, [api, machineId, revision, active, controller])
  const directories = useMemo(() => [...new Set((data?.sessions ?? []).flatMap(row => row.cwd ? [row.cwd] : []))].sort(), [data])
  const filtered = filterPiHistory(data?.sessions ?? [], query, directory), visible = piHistoryPage(filtered, page)
  const selection = selected.filter(id => data?.sessions.some(row => row.id === id))
  const action = (connect: boolean): SourceHistoryAction => ({ kind: 'pi-import', machineId, piSessionIds: selection, connect })
  const perform = async (connect: boolean) => {
    if (!selection.length || connect && selection.length !== 1) return
    const receipt = await controller.run(action(connect))
    setRevision(value => value + 1)
    if (connect && receipt?.status === 'confirmed' && receipt.sessionId) onOpen(receipt.sessionId)
  }
  return <section className="hapi-source-panel" aria-label={tr('Pi history', 'Pi 历史')}>
    <h2>{tr('Import or continue original Pi history', '导入或继续原始 Pi 历史')}</h2>
    <p>{tr('History stays on its original Runner. Stop an active HAPI Pi session before importing newer native history; a diverged branch needs source review.', '历史保留在原 Runner 上。同步新增原生历史前需停止活跃的 HAPI Pi 会话；分支分歧会保留源错误并停止导入。')}</p>
    <label>{tr('Runner', '机器')}<select value={machineId} onChange={event => setMachineId(event.currentTarget.value)}>{machines.map(row => <option key={row.id} value={row.id}>{row.label}{row.online ? '' : ` · ${tr('offline', '离线')}`}</option>)}</select></label>
    <div className="hapi-button-row"><button type="button" disabled={loading || !machineId} onClick={() => setRevision(value => value + 1)}>{tr('Refresh Pi histories', '刷新 Pi 历史')}</button></div>
    {loading && <p role="status">{tr('Reading original Pi catalog…', '正在读取原始 Pi 目录…')}</p>}{error && <p role="alert" className="hapi-error">{error}</p>}
    <label>{tr('Search title, native identity, path or model', '搜索标题、原生身份、路径或模型')}<input type="search" value={query} onChange={event => { setQuery(event.currentTarget.value); setPage(0) }}/></label>
    <label>{tr('Directory', '目录')}<select value={directory} onChange={event => { setDirectory(event.currentTarget.value); setPage(0) }}><option value="">{tr('All directories', '全部目录')}</option>{directories.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
    <div className="hapi-button-row"><button type="button" disabled={state.busy || !visible.rows.length} onClick={() => setSelected(visible.rows.map(row => row.id))}>{tr('Select this page', '选择本页')}</button>
      <button type="button" disabled={state.busy || !filtered.length || filtered.length > 200} onClick={() => setSelected(filtered.map(row => row.id))}>{tr('Select filtered histories (up to 200)', '选择筛选结果（最多 200 条）')}</button>
      <button type="button" disabled={state.busy || !selected.length} onClick={() => setSelected([])}>{tr('Clear selection', '清除选择')}</button><span>{selection.length} {tr('selected', '已选')}</span></div>
    {!loading && !filtered.length && <p>{tr('No matching Pi history.', '没有匹配的 Pi 历史。')}</p>}
    <ul className="hapi-source-notes">{visible.rows.map(row => <li key={row.id}>
      <label style={{ display: 'flex', alignItems: 'start', gap: 8 }}><input type="checkbox" checked={selected.includes(row.id)} disabled={state.busy || !selected.includes(row.id) && selection.length >= 200}
        onChange={event => { const checked = event.currentTarget.checked; setSelected(values => checked ? [...values, row.id] : values.filter(id => id !== row.id)) }}/><span><strong>{row.title || row.id}</strong><br/><small>{row.cwd} · {row.model} · {row.messageCount} {tr('messages', '条消息')}</small></span></label>
      <p>{row.lastUserMessage}</p><small>{new Date(row.modifiedAt).toLocaleString()} · {row.importState ?? tr('not imported', '尚未导入')}</small>
      <details><summary>{tr('Original identity', '原始身份')}</summary><code>{row.id}</code><p>{row.file}</p></details>
      {row.displaySessionId && <button type="button" onClick={() => onOpen(row.displaySessionId!)}>{tr('Open existing imported conversation', '打开已导入会话')}</button>}
    </li>)}</ul>
    <div className="hapi-button-row"><button type="button" disabled={visible.page === 0} onClick={() => setPage(visible.page - 1)}>{tr('Previous', '上一页')}</button><span>{visible.page + 1} / {visible.pages}</span><button type="button" disabled={visible.page + 1 >= visible.pages} onClick={() => setPage(visible.page + 1)}>{tr('Next', '下一页')}</button></div>
    <div className="hapi-button-row"><button type="button" disabled={!selection.length || !controller.canRun(action(false))} onClick={() => { void perform(false) }}>{tr('Import selected histories', '导入所选历史')}</button>
      <button type="button" disabled={selection.length !== 1 || !controller.canRun(action(true))} onClick={() => { void perform(true) }}>{tr('Import and continue selected Pi session', '导入并继续所选 Pi 会话')}</button></div>
    <OperationReceipts controller={controller} onOpen={onOpen} language={language}/>
  </section>
}

/** Source-specific controls to mount inside an ordinary official rightbar tab. */
export function SourceMigrationPanel({ api, sessionId, onOpen, onSuccessor, language, active = true }: {
  api: SourceHistoryApi; sessionId: string; onOpen: (id: string) => void; language?: string | undefined; active?: boolean | undefined;
  onSuccessor?: ((displaySessionId: string) => void) | undefined;
}) {
  const tr = words(language), { controller, state } = useController(api, `session:${sessionId}`)
  const [data, setData] = useState<SourceHistoryTools | null>(null), [error, setError] = useState<string | null>(null), [loading, setLoading] = useState(false)
  const [revision, setRevision] = useState(0), [target, setTarget] = useState(''), [provider, setProvider] = useState(''), [model, setModel] = useState('')
  const [keepSource, setKeepSource] = useState(true), [archive, setArchive] = useState(false), [skipVerify, setSkipVerify] = useState(false)
  const [confirmation, setConfirmation] = useState<SourceHistoryAction | null>(null)
  useEffect(() => { setData(null); setTarget(''); setProvider(''); setModel(''); setKeepSource(true); setArchive(false); setSkipVerify(false); setConfirmation(null) }, [sessionId])
  useEffect(() => {
    if (!active) return
    let disposed = false, reading = false
    const refresh = async () => {
      if (reading) return
      reading = true
      setLoading(true)
      try {
        const result = remoteValue(await api.sourceHistoryTools({ sessionId }))
        if (!disposed) { setData(result); setError(null); controller.accept(result.operations); await controller.recover() }
      } catch (failure) { if (!disposed) setError(text(failure)) }
      finally { reading = false; if (!disposed) setLoading(false) }
    }
    void refresh(); const timer = setInterval(() => { void refresh() }, 5000)
    return () => { disposed = true; clearInterval(timer) }
  }, [api, sessionId, active, revision, controller])
  const targets = data?.codex?.homes.filter(home => home.path !== data.codex?.sourceHome) ?? [], targetHome = targets.find(home => home.id === target) ?? targets[0]
  const current = data?.sessionId === sessionId
  const perform = async (action: SourceHistoryAction) => {
    const result = await controller.run(action); setConfirmation(null); setRevision(value => value + 1)
    if (result?.status === 'confirmed' && result.sessionId && result.sessionId !== sessionId) (sourceHistorySuccessorId(result) ? onSuccessor ?? onOpen : onOpen)(result.sessionId)
  }
  return <section className="hapi-source-panel" aria-label={tr('Native history and migration', '原生历史与迁移')}>
    <h2>{tr('Native history and migration', '原生历史与迁移')}</h2>
    {loading && !data && <p role="status">{tr('Reading original source…', '正在读取原始会话…')}</p>}{error && <p role="alert" className="hapi-error">{error}</p>}
    {data && <p>{data.flavor} · <code>{data.nativeId}</code> · {data.machineId}</p>}
    {data && !current && <p>{tr('This source has a newer display generation.', '此原始会话已有新的显示代次。')} <button type="button" onClick={() => onOpen(data.sessionId)}>{tr('Open current source', '打开当前源会话')}</button></p>}
    {data?.pi && <div><h3>{tr('Pi native history', 'Pi 原生历史')}</h3>
      {data.pi.importState && <p>{data.pi.importState.state} · {data.pi.importState.leafEntryId}<br/>{data.pi.importState.error}</p>}
      <p>{tr('Synchronization reads the existing Pi transcript. An active session must be stopped before importing newer history.', '同步读取现有 Pi 记录。导入较新的历史前需要停止活跃会话。')}</p>
      <button type="button" disabled={!current || !data.pi.canSync || state.busy || !data.machineId || !data.nativeId}
        onClick={() => { if (data.machineId && data.nativeId) void perform({ kind: 'pi-import', machineId: data.machineId, piSessionIds: [data.nativeId], connect: false }) }}>{tr('Sync this original Pi history', '同步此原始 Pi 历史')}</button></div>}
    {data?.codex && <div><h3>{tr('Codex home migration', 'Codex 配置目录迁移')}</h3><p>{tr('The source operation stops this session, copies its native thread and rebinds the same HAPI session to the target home. The target runtime stays online.', '源操作会停止此会话、复制原生线程，再将同一 HAPI 会话绑定到目标目录。目标运行时保持在线。')}</p>
      <p>{tr('Current home', '当前目录')}：<code>{data.codex.sourceHome}</code></p>
      {data.codex.migrationInProgress && <p role="status">{tr('Source migration in progress', '源迁移正在进行')}：{data.codex.migrationInProgress.sourceHome} → {data.codex.migrationInProgress.targetHome}</p>}
      <label>{tr('Target home on the same Runner', '同一 Runner 上的目标目录')}<select value={targetHome?.id ?? ''} onChange={event => setTarget(event.currentTarget.value)}>{targets.map(home => <option key={home.id} value={home.id}>{home.label} — {home.path}</option>)}</select></label>
      <label>{tr('Target provider ID (optional)', '目标 Provider ID（可选）')}<input value={provider} onChange={event => setProvider(event.currentTarget.value)}/></label>
      <label>{tr('Target model ID (optional)', '目标模型 ID（可选）')}<input value={model} onChange={event => setModel(event.currentTarget.value)}/></label>
      <button type="button" disabled={!current || !data.codex.canMigrate || !targetHome || state.busy} onClick={() => { if (targetHome) setConfirmation({ kind: 'codex-home', sessionId, targetHomeId: targetHome.id,
        ...(provider.trim() ? { targetProvider: provider.trim() } : {}), ...(model.trim() ? { targetModel: model.trim() } : {}) }) }}>{tr('Review home migration', '检查目录迁移')}</button></div>}
    {data?.cursor && <div><h3>{tr('Cursor legacy history to ACP', 'Cursor 旧历史迁移到 ACP')}</h3>
      <p>{tr('The pinned HAPI migrator runs on the HAPI Hub machine. A history from another host is refused by the source. Loading is always verified; prompt verification uses the original Cursor runtime.', '当前 HAPI 迁移器在 HAPI Hub 本机执行，来自其他主机的历史会被源端拒绝。迁移始终验证加载，提示词验证使用原 Cursor 运行时。')}</p>
      {data.cursor.state === 'in_progress' && <p role="status">{tr('The original source is upgrading Cursor history to ACP.', '原始源正在将 Cursor 历史升级为 ACP。')}</p>}
      {data.cursor.state === 'ambiguous' && <p role="alert">{tr('The source refused an ambiguous legacy store or a history-size mismatch. Review the original source files before continuing.', '源端发现多个旧存储或历史大小不匹配。请先检查原始存储，再继续。')}</p>}
      <p>{tr('Current protocol', '当前协议')}：{data.cursor.protocol ?? tr('legacy / unspecified', '旧版 / 未声明')}</p>
      <label><span><input type="checkbox" checked={keepSource} onChange={event => setKeepSource(event.currentTarget.checked)}/> {tr('Keep the original legacy store after migration', '迁移后保留原有存储')}</span></label>
      {!keepSource && <p>{tr('The source will remove its legacy store after a successful migration.', '迁移成功后，源端将删除旧存储。')}</p>}
      <label><span><input type="checkbox" checked={archive} onChange={event => setArchive(event.currentTarget.checked)}/> {tr('Allow the source to archive an active session first', '允许源端先归档活跃会话')}</span></label>
      <label><span><input type="checkbox" checked={skipVerify} onChange={event => setSkipVerify(event.currentTarget.checked)}/> {tr('Skip prompt verification (session loading is still checked)', '跳过提示词验证（仍检查会话加载）')}</span></label>
      <button type="button" disabled={!current || !data.cursor.canMigrate || data.active && !archive || state.busy} onClick={() => setConfirmation({ kind: 'cursor-acp', sessionId, keepSource, forceArchiveRunning: archive, skipVerify })}>{tr('Review Cursor migration', '检查 Cursor 迁移')}</button></div>}
    {data && !data.pi && !data.codex && !data.cursor && <p>{tr('This source engine has no Pi/Codex/Cursor migration operation.', '此源引擎不提供 Pi/Codex/Cursor 迁移操作。')}</p>}
    {confirmation && <div role="group" aria-label={tr('Confirm native history operation', '确认原生历史操作')}>
      <p><strong>{confirmation.kind === 'codex-home' ? tr('Stop and migrate this original thread?', '停止并迁移此原始线程？') : tr('Migrate this original Cursor store?', '迁移此原始 Cursor 存储？')}</strong></p>
      <p><code>{data?.nativeId}</code>{confirmation.kind === 'codex-home' && <> · {data?.codex?.sourceHome} → {targetHome?.path}</>}</p>
      <div className="hapi-button-row"><button type="button" disabled={!current || !controller.canRun(confirmation)} onClick={() => { void perform(confirmation) }}>{tr('Confirm source operation', '确认源操作')}</button><button type="button" disabled={state.busy} onClick={() => setConfirmation(null)}>{tr('Cancel', '取消')}</button></div>
    </div>}
    <OperationReceipts controller={controller} onOpen={onOpen} onSuccessor={onSuccessor} language={language}/>
  </section>
}
