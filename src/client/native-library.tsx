import { randomId } from './random-id.ts'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { SourcePiHistoryPanel } from './source-history.tsx';
import { nativeToolAllowed } from './native-tool-admission.ts';
import { remoteValue, type CatalogMachine, type HapiRemoteApi, type NativeDeviceLogin, type NativeLibrary,
    type NativeMachineAction, type NativeMachineState, type NativeOperationReceipt, type NativeSessionTools,
    type NativeSourceAction } from '../client-api.ts';

const isZh = (language?: string) => (language ?? globalThis.document?.documentElement.lang ?? '').toLowerCase().startsWith('zh');
const words = (language?: string) => (en: string, zh: string): string => isZh(language) ? zh : en;
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
const resultRecord = (value: NativeOperationReceipt['result']): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;

/** Keep the last confirmed data on read failure, and reject responses belonging to an older selection. */
function useRead<T>(key: string, read: () => Promise<T>, active = true) {
    const fn = useRef(read); fn.current = read;
    const generation = useRef(0);
    const [data, setData] = useState<T | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const refresh = useCallback(async () => {
        const current = ++generation.current;
        setLoading(true); setError(null);
        try { const value = await fn.current(); if (current === generation.current) setData(value); }
        catch (failure) { if (current === generation.current) setError(errorText(failure)); }
        finally { if (current === generation.current) setLoading(false); }
    }, []);
    useEffect(() => { ++generation.current; setData(null); setError(null); if (active) void refresh(); return () => { ++generation.current; }; }, [key, active, refresh]);
    return { data, loading, error, refresh };
}

function useOperation(api: HapiRemoteApi) {
    const [busy, setBusy] = useState(false);
    const [receipt, setReceipt] = useState<NativeOperationReceipt | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [pendingId, setPendingId] = useState<string | null>(null);
    const gate = useRef(false);
    const inspect = async (id = pendingId): Promise<void> => {
        if (!id || gate.current) return;
        setError(null);
        try { const result = remoteValue(await api.nativeOperation({ operationId: id })); setReceipt(result); }
        catch (failure) { setError(errorText(failure)); }
    };
    const run = async (submit: (operationId: string) => Promise<NativeOperationReceipt>): Promise<NativeOperationReceipt | null> => {
        if (gate.current) return null;
        gate.current = true; setBusy(true); setError(null); setReceipt(null);
        const id = randomId(); setPendingId(id);
        try { const result = await submit(id); setReceipt(result); return result; }
        catch (failure) {
            // The host may have durably admitted this operation before the browser disconnected.
            // Observe its identity; never repeat the source mutation on a transport error.
            setError(errorText(failure));
            try { setReceipt(remoteValue(await api.nativeOperation({ operationId: id }))); } catch { /* Keep its recovery identity visible. */ }
            return null;
        } finally { gate.current = false; setBusy(false); }
    };
    return { busy, receipt, error, pendingId, run, inspect };
}
function OperationStatus({ operation, language }: { operation: ReturnType<typeof useOperation>; language?: string | undefined }) {
    const tr = words(language);
    const state = operation.receipt?.status;
    const labels = { submitting: tr('Submitting', '提交中'), confirmed: tr('Confirmed by owner', '原会话已确认'), rejected: tr('Rejected', '未执行'), indeterminate: tr('Awaiting source confirmation', '等待原会话确认') };
    return <div className="hapi-operation-status" aria-live="polite">
        {operation.busy && <p role="status">{tr('Applying…', '正在执行…')}</p>}
        {state && <p role="status"><strong>{labels[state]}</strong>{operation.receipt?.message && ` · ${operation.receipt.message}`}</p>}
        {operation.error && <p className="hapi-error" role="alert">{operation.error}</p>}
        {(state === 'indeterminate' || operation.error) && operation.pendingId && <details><summary>{tr('Check operation', '查询操作结果')}</summary>
            <p>{tr('This submission is not sent again when you refresh.', '刷新只查询结果，不会再次执行。')}</p><code>{operation.pendingId}</code>
            <button type="button" disabled={operation.busy} onClick={() => { void operation.inspect(); }}>{tr('Check result', '查询结果')}</button></details>}
    </div>;
}
function OpenResult({ receipt, onOpen, language }: { receipt: NativeOperationReceipt | null; onOpen: (id: string) => void; language?: string | undefined }) {
    const value = resultRecord(receipt?.result ?? null); const sessionId = value?.sessionId;
    if (receipt?.status !== 'confirmed' || typeof sessionId !== 'string') return null;
    return <button type="button" onClick={() => onOpen(sessionId)}>{words(language)('Open conversation', '打开聊天')}</button>;
}
function Frame({ title, children, onClose }: { title: string; children: ReactNode; onClose?: (() => void) | undefined }) {
    return <section className="hapi-native-library" aria-label={title}><header className="hapi-button-row"><h2>{title}</h2>
        {onClose && <button type="button" aria-label="Close" onClick={onClose}>×</button>}</header>{children}</section>;
}

export interface NativeLibraryPanelProps {
    api: HapiRemoteApi; machines: readonly CatalogMachine[]; onOpen: (sessionId: string) => void;
    onClose?: (() => void) | undefined; language?: string | undefined;
}
/** Native history stays in the original store; connecting it adds another item to the same sidebar. */
export function NativeLibraryPanel({ api, machines, onOpen, onClose, language }: NativeLibraryPanelProps) {
    const tr = words(language);
    const [machineId, setMachine] = useState(machines.find(row => row.online)?.id ?? machines[0]?.id ?? '');
    useEffect(() => {
        if (!machineId && machines.length) setMachine(machines.find(row => row.online)?.id ?? machines[0]!.id);
    }, [machineId, machines]);
    const [tab, setTab] = useState<'history' | 'pi' | 'accounts'>('history');
    const [searchDraft, setSearchDraft] = useState(''); const [cwdDraft, setCwdDraft] = useState('');
    const [query, setQuery] = useState({ search: '', cwd: '' });
    const [page, setPage] = useState<NativeLibrary | null>(null);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [loading, setLoading] = useState(false); const [error, setError] = useState<string | null>(null);
    const sequence = useRef(0); const operation = useOperation(api);
    const read = useCallback(async (cursor?: number) => {
        const token = ++sequence.current; setLoading(true); setError(null);
        try {
            const value = remoteValue(await api.nativeLibrary({ ...(machineId ? { machineId } : {}),
                ...(query.search ? { search: query.search } : {}), ...(query.cwd ? { cwd: query.cwd } : {}), limit: 50, ...(cursor === undefined ? {} : { cursor }) }));
            if (token !== sequence.current) return;
            setPage(previous => cursor === undefined || !previous ? value : { ...value, sessions: [...new Map([...previous.sessions, ...value.sessions].map(row => [row.id, row])).values()] });
        } catch (failure) { if (token === sequence.current) setError(errorText(failure)); }
        finally { if (token === sequence.current) setLoading(false); }
    }, [api, machineId, query]);
    useEffect(() => { setPage(null); setSelected(new Set()); if (tab === 'history') void read(); return () => { ++sequence.current; }; }, [read, tab]);
    const connect = async (threadId: string) => {
        const receipt = await operation.run(async operationId => remoteValue(await api.nativeConnect({ operationId, threadId, ...(machineId ? { machineId } : {}) })));
        const value = resultRecord(receipt?.result ?? null);
        if (receipt?.status === 'confirmed' && typeof value?.sessionId === 'string') onOpen(value.sessionId);
        if (receipt?.status === 'confirmed') void read();
    };
    const importThreads = async () => {
        const receipt = await operation.run(async operationId => remoteValue(await api.nativeImport({ operationId, threadIds: [...selected], ...(machineId ? { machineId } : {}), ...(query.cwd ? { cwd: query.cwd } : {}) })));
        if (receipt?.status === 'confirmed') { setSelected(new Set()); void read(); }
    };
    return <Frame title={tr('History & accounts', '历史与账号')} onClose={onClose}>
        {tab !== 'pi' && <label>{tr('Machine', '机器')}<select value={machineId} onChange={event => setMachine(event.currentTarget.value)}>
            {!machines.length && <option value="">{tr('Hub machine', 'Hub 所在机器')}</option>}
            {machines.map(row => <option value={row.id} key={row.id}>{row.label}{row.online ? '' : ` · ${tr('offline', '离线')}`}</option>)}</select></label>}
        <div className="hapi-button-row" role="tablist" aria-label={tr('History and machine settings', '历史和机器设置')}>
            <button type="button" role="tab" aria-selected={tab === 'history'} onClick={() => setTab('history')}>{tr('Codex history', 'Codex 历史')}</button>
            <button type="button" role="tab" aria-selected={tab === 'pi'} onClick={() => setTab('pi')}>{tr('Pi history', 'Pi 历史')}</button>
            <button type="button" role="tab" aria-selected={tab === 'accounts'} disabled={!machineId} onClick={() => setTab('accounts')}>{tr('Accounts & homes', '账号与目录')}</button></div>
        {tab === 'pi' ? <SourcePiHistoryPanel api={api} machines={machines} initialMachineId={machineId} onOpen={onOpen} language={language}/>
            : tab === 'accounts' ? <NativeMachinePanel api={api} machineId={machineId} language={language}/> : <>
            <form className="hapi-native-library-search" onSubmit={event => { event.preventDefault(); setQuery({ search: searchDraft.trim(), cwd: cwdDraft.trim() }); }}>
                <label>{tr('Search history', '搜索历史')}<input value={searchDraft} onChange={event => setSearchDraft(event.currentTarget.value)} placeholder={tr('Title or message', '标题或聊天内容')}/></label>
                <label>{tr('Working directory', '工作目录')}<input value={cwdDraft} onChange={event => setCwdDraft(event.currentTarget.value)} placeholder={tr('All directories', '全部目录')}/></label>
                <button type="submit" disabled={loading}>{tr('Search', '搜索')}</button><button type="button" disabled={loading} onClick={() => { void read(); }}>{tr('Refresh', '刷新')}</button>
            </form>
            <div className="hapi-button-row"><button type="button" disabled={!selected.size || operation.busy} onClick={() => { void importThreads(); }}>{tr(`Import selected (${selected.size})`, `导入所选 (${selected.size})`)}</button>
                {selected.size > 0 && <button type="button" onClick={() => setSelected(new Set())}>{tr('Clear selection', '取消选择')}</button>}</div>
            {error && <p role="alert" className="hapi-error">{error}</p>}
            {loading && <p role="status">{tr('Reading native history…', '正在读取原生历史…')}</p>}
            {page?.sessions.length === 0 && !loading && <p>{tr('No matching conversations.', '没有匹配的聊天。')}</p>}
            <ul className="hapi-native-history-list">{page?.sessions.map(row => <li key={row.id}>
                <label><input type="checkbox" checked={selected.has(row.id)} onChange={event => { const checked = event.currentTarget.checked; setSelected(previous => { const next = new Set(previous); if (checked) next.add(row.id); else next.delete(row.id); return next; }); }}/><strong>{row.title || row.id}</strong></label>
                {row.lastUserMessage && <p>{row.lastUserMessage}</p>}
                <small title={row.cwd ?? ''}>{row.cwd} · {new Date(row.modifiedAt).toLocaleString()} · {row.connectionState ?? tr('available', '可用')}</small>
                {row.connectionError && <p className="hapi-error">{row.connectionError}</p>}
                <button type="button" disabled={operation.busy || row.connectionState === 'unavailable'} onClick={() => { void connect(row.id); }}>{tr('Open in workspace', '在工作区打开')}</button>
            </li>)}</ul>
            {page?.nextCursor != null && <button type="button" disabled={loading} onClick={() => { void read(page.nextCursor!); }}>{tr('Load more', '加载更多')}</button>}
            <OperationStatus operation={operation} language={language}/><OpenResult receipt={operation.receipt} onOpen={onOpen} language={language}/>
        </>}
    </Frame>;
}

export function NativeMachinePanel({ api, machineId, language }: { api: HapiRemoteApi; machineId: string; language?: string | undefined }) {
    const tr = words(language); const state = useRead<NativeMachineState>(machineId, async () => remoteValue(await api.nativeMachineState({ machineId })), !!machineId);
    const operation = useOperation(api); const [login, setLogin] = useState<NativeDeviceLogin | null>(null);
    const [home, setHome] = useState({ id: '', label: '', path: '' }); const [accountName, setAccountName] = useState('');
    const [confirmation, setConfirmation] = useState<NativeMachineAction | null>(null);
    const [loginError, setLoginError] = useState<string | null>(null);
    useEffect(() => { setLogin(null); setHome({ id: '', label: '', path: '' }); setConfirmation(null); }, [machineId]);
    useEffect(() => {
        if (login?.status !== 'pending') return;
        let active = true; let timer: ReturnType<typeof setTimeout>;
        const poll = async () => {
            try {
                const next = remoteValue(await api.nativeDeviceLogin({ machineId, loginId: login.id }));
                if (!active) return; setLogin(next); setLoginError(null);
                if (next.status === 'completed') void state.refresh();
                if (next.status === 'pending') timer = setTimeout(() => { void poll(); }, 3000);
            } catch (failure) { if (active) { setLoginError(errorText(failure)); timer = setTimeout(() => { void poll(); }, 6000); } }
        };
        timer = setTimeout(() => { void poll(); }, 1500);
        return () => { active = false; clearTimeout(timer); };
    }, [api, machineId, login?.id, login?.status, state.refresh]);
    const perform = async (action: NativeMachineAction) => {
        const receipt = await operation.run(async operationId => remoteValue(await api.nativeMachineOperation({ operationId, machineId, action })));
        if (receipt?.status !== 'confirmed') return;
        setConfirmation(null); void state.refresh();
        const value = resultRecord(receipt.result);
        if (action.kind === 'device-login' && value?.login) setLogin(value.login as NativeDeviceLogin);
        if (action.kind === 'save-home') setHome({ id: '', label: '', path: '' });
    };
    return <div className="hapi-native-machine-panel">
        <h3>{tr('Codex accounts', 'Codex 账号')}</h3>
        {state.loading && <p role="status">{tr('Loading…', '加载中…')}</p>}
        {state.error && <p role="alert" className="hapi-error">{state.error}</p>}
        {state.data?.warnings.map((message, index) => <p className="hapi-error" key={index}>{message}</p>)}
        <ul>{state.data?.accounts.map(row => <li key={row.id}>
            <strong>{row.label}</strong> {row.email} {state.data?.currentAccountId === row.id && <span>{tr('Current', '当前使用')}</span>}
            <div className="hapi-button-row"><button type="button" disabled={operation.busy || !row.enabled || state.data?.currentAccountId === row.id} onClick={() => { void perform({ kind: 'switch-account', id: row.id }); }}>{tr('Use on machine', '设为机器默认')}</button>
                <button type="button" disabled={operation.busy} onClick={() => setConfirmation({ kind: 'rename-account', id: row.id, label: row.label })}>{tr('Rename', '重命名')}</button>
                <button type="button" disabled={operation.busy} onClick={() => setConfirmation({ kind: 'delete-account', id: row.id })}>{tr('Remove account', '移除账号')}</button></div>
        </li>)}</ul>
        <label>{tr('Account label (optional)', '账号名称（可选）')}<input value={accountName} onChange={event => setAccountName(event.currentTarget.value)}/></label>
        <div className="hapi-button-row"><button type="button" disabled={operation.busy} onClick={() => { void perform({ kind: 'import-account', ...(accountName.trim() ? { label: accountName.trim() } : {}) }); }}>{tr('Import current Runner login', '导入 Runner 当前登录')}</button>
            <button type="button" disabled={operation.busy || login?.status === 'pending'} onClick={() => { void perform({ kind: 'device-login', action: 'start', ...(accountName.trim() ? { label: accountName.trim() } : {}) }); }}>{tr('Sign in with device code', '使用设备码登录')}</button></div>
        {login && <div className="hapi-native-device-login" role="status"><strong>{login.userCode}</strong>
            <a href={login.verificationUrl} target="_blank" rel="noopener noreferrer">{tr('Open verification page', '打开验证页面')}</a>
            <p>{login.status} · {tr('Expires', '有效期至')} {new Date(login.expiresAt).toLocaleTimeString()}</p>
            {login.error && <p role="alert">{login.error}</p>}{loginError && <p role="alert">{loginError}</p>}
            {login.status === 'pending' && <button type="button" disabled={operation.busy} onClick={() => { void perform({ kind: 'device-login', action: 'cancel', id: login.id }); }}>{tr('Cancel sign-in', '取消登录')}</button>}</div>}
        <h3>{tr('Codex homes', 'Codex 配置目录')}</h3>
        <ul>{state.data?.homes.map(row => <li key={row.id}><strong>{row.label}</strong><code>{row.path}</code>
            <button type="button" disabled={operation.busy} onClick={() => setHome({ id: row.id, label: row.label, path: row.path })}>{tr('Edit', '编辑')}</button>
            {!row.official && <button type="button" disabled={operation.busy} onClick={() => setConfirmation({ kind: 'delete-home', id: row.id })}>{tr('Remove', '移除')}</button>}</li>)}</ul>
        <form onSubmit={event => { event.preventDefault(); void perform({ kind: 'save-home', label: home.label, path: home.path, ...(home.id ? { id: home.id } : {}) }); }}>
            <label>{tr('Label', '名称')}<input required value={home.label} onChange={event => setHome({ ...home, label: event.currentTarget.value })}/></label>
            <label>{tr('Path on Runner', 'Runner 上的路径')}<input required value={home.path} onChange={event => setHome({ ...home, path: event.currentTarget.value })}/></label>
            <button type="submit" disabled={operation.busy || !home.label.trim() || !home.path.trim()}>{home.id ? tr('Save home', '保存目录') : tr('Add home', '添加目录')}</button>
            {home.id && <button type="button" onClick={() => setHome({ id: '', label: '', path: '' })}>{tr('Cancel edit', '取消编辑')}</button>}
        </form>
        {confirmation && <div role="group" aria-label={tr('Confirm change', '确认修改')}>
            {confirmation.kind === 'rename-account' ? <label>{tr('New label', '新名称')}<input value={confirmation.label} onChange={event => setConfirmation({ ...confirmation, label: event.currentTarget.value })}/></label>
                : <p>{confirmation.kind === 'delete-account' ? tr('Remove this saved account from the Runner?', '从 Runner 移除这个已保存的账号？') : tr('Remove this Codex home registration?', '移除这个 Codex 目录配置？')}</p>}
            <button type="button" disabled={operation.busy} onClick={() => { void perform(confirmation); }}>{tr('Confirm', '确认')}</button><button type="button" onClick={() => setConfirmation(null)}>{tr('Cancel', '取消')}</button></div>}
        <button type="button" disabled={state.loading} onClick={() => { void state.refresh(); }}>{tr('Refresh machine state', '刷新机器状态')}</button>
        <OperationStatus operation={operation} language={language}/>
    </div>;
}

export function NativeSessionToolsPanel({ api, sessionId, machineId, onOpen, onSuccessor, language, initialAction }: {
    api: HapiRemoteApi; sessionId: string; machineId?: string | null | undefined; onOpen: (id: string) => void; language?: string | undefined;
    initialAction?: 'archive' | 'reopen' | 'pin' | 'restart' | 'delete' | undefined;
    onSuccessor?: ((displaySessionId: string) => void) | undefined;
}) {
    const tr = words(language); const state = useRead<NativeSessionTools>(sessionId, async () => remoteValue(await api.nativeSessionTools({ sessionId })));
    const accounts = useRead<NativeMachineState>(machineId ?? '', async () => remoteValue(await api.nativeMachineState({ machineId: machineId! })), !!machineId);
    const [goal, setGoal] = useState(''); const [summary, setSummary] = useState('');
    const [editingGoal, setEditingGoal] = useState(false); const [editingSummary, setEditingSummary] = useState(false);
    const [confirmation, setConfirmation] = useState<NativeSourceAction | null>(null); const operation = useOperation(api);
    const [actionError, setActionError] = useState<string | null>(null);
    const allowed = (action: NativeSourceAction): boolean => !state.loading && !state.error && nativeToolAllowed(state.data, sessionId, action);
    useEffect(() => { if (!editingGoal) setGoal(state.data?.goal?.objective ?? ''); }, [state.data?.goal?.objective, editingGoal]);
    useEffect(() => { if (!editingSummary) setSummary(state.data?.summary ?? ''); }, [state.data?.summary, editingSummary]);
    useEffect(() => { setEditingGoal(false); setEditingSummary(false); setActionError(null); setConfirmation(initialAction && initialAction !== 'pin' ? { kind: initialAction } : null); }, [sessionId, initialAction]);
    const perform = async (action: NativeSourceAction) => {
        if (!allowed(action)) { setActionError(tr('Refresh the current source state before applying this operation.', '请先刷新当前源会话状态，再执行此操作。')); return; }
        setActionError(null);
        const receipt = await operation.run(async operationId => remoteValue(await api.nativeSourceOperation({ operationId, sessionId, action })));
        if (receipt?.status !== 'confirmed') return;
        setConfirmation(null); setEditingGoal(false); setEditingSummary(false);
        const value = resultRecord(receipt.result);
        if (typeof value?.sessionId === 'string' && value.sessionId !== sessionId) {
            if (action.kind === 'reopen' || action.kind === 'resume') (onSuccessor ?? onOpen)(value.sessionId);
            else onOpen(value.sessionId);
        }
        else if (action.kind !== 'delete') void state.refresh();
    };
    const labels = { clear: tr('Start a fresh native thread', '清空并开始新的原生线程'), archive: tr('Archive session', '归档会话'), restart: tr('Restart agent', '重启 Agent'), delete: tr('Delete session', '删除会话') };
    return <section className="hapi-native-session-tools" aria-label={tr('Session tools', '会话操作')}>
        {state.loading && <p role="status">{tr('Loading…', '加载中…')}</p>}{state.error && <p role="alert" className="hapi-error">{state.error}</p>}
        {state.data && <>
            <details><summary>{tr('Persistent goal', '持续目标')}{state.data.goal ? ` · ${state.data.goal.status}` : ''}</summary>
                {state.data.goal && <p>{state.data.goal.tokensUsed.toLocaleString()} {tr('tokens', 'tokens')} · {Math.round(state.data.goal.timeUsedSeconds)}s</p>}
                <form onSubmit={event => { event.preventDefault(); void perform({ kind: 'goal', command: { action: 'set', objective: goal } }); }}>
                    <label>{tr('Objective', '目标')}<textarea value={goal} disabled={state.data.readOnly} onChange={event => { setEditingGoal(true); setGoal(event.currentTarget.value); }}/></label>
                    <button type="submit" disabled={operation.busy || state.data.readOnly || !goal.trim()}>{tr('Set goal', '设置目标')}</button>
                </form>
                {state.data.goal && <div className="hapi-button-row"><button type="button" disabled={operation.busy || state.data.readOnly} onClick={() => { void perform({ kind: 'goal', command: { action: state.data!.goal!.status === 'paused' ? 'resume' : 'pause' } }); }}>{state.data.goal.status === 'paused' ? tr('Resume goal', '继续目标') : tr('Pause goal', '暂停目标')}</button>
                    <button type="button" disabled={operation.busy || state.data.readOnly} onClick={() => setConfirmation({ kind: 'goal', command: { action: 'clear' } })}>{tr('Clear goal', '清除目标')}</button></div>}
            </details>
            <details open={initialAction === 'pin' ? true : undefined}><summary>{tr('Summary & pin', '摘要与置顶')}</summary>
                <label>{tr('Pin', '置顶')}<select value={state.data.pinMode} disabled={operation.busy} onChange={event => { void perform({ kind: 'pin', mode: event.currentTarget.value as 'none' | 'project' | 'global' }); }}>
                    <option value="none">{tr('Not pinned', '不置顶')}</option><option value="project">{tr('In project', '目录内置顶')}</option><option value="global">{tr('Everywhere', '全局置顶')}</option></select></label>
                <form onSubmit={event => { event.preventDefault(); void perform({ kind: 'summary', text: summary }); }}>
                    <label>{tr('Session summary', '会话摘要')}<textarea value={summary} maxLength={255} onChange={event => { setEditingSummary(true); setSummary(event.currentTarget.value); }}/></label>
                    <button type="submit" disabled={operation.busy || !editingSummary || !summary.trim()}>{tr('Save summary', '保存摘要')}</button></form>
            </details>
            {accounts.data && accounts.data.accounts.length > 0 && <label>{tr('Account for this session', '本会话账号')}<select defaultValue="" disabled={operation.busy} onChange={event => { if (event.currentTarget.value) setConfirmation({ kind: 'switch-account', accountId: event.currentTarget.value }); event.currentTarget.value = ''; }}>
                <option value="" disabled>{tr('Choose account…', '选择账号…')}</option>{accounts.data.accounts.filter(row => row.enabled).map(row => <option key={row.id} value={row.id}>{row.label} {row.email}</option>)}</select></label>}
            <div className="hapi-button-row">
                {!state.data.active && <button type="button" disabled={operation.busy} onClick={() => { void perform({ kind: 'reopen' }); }}>{tr('Reopen session', '重新打开会话')}</button>}
                {(Object.keys(labels) as Array<keyof typeof labels>).filter(kind => kind === 'clear' ? state.data!.canClear : kind === 'delete' ? !state.data!.active : state.data!.active).map(kind =>
                    <button key={kind} type="button" disabled={operation.busy} onClick={() => setConfirmation({ kind })}>{labels[kind]}</button>)}
            </div>
        </>}
        {confirmation && <div role="group" className="hapi-native-confirm" aria-label={tr('Confirm session operation', '确认会话操作')}>
            <p>{confirmation.kind === 'delete' ? tr('Permanently delete this session and its HAPI history?', '永久删除这个会话及其 HAPI 历史记录？')
                : confirmation.kind === 'clear' ? tr('Start a fresh native thread? The current thread remains in native history.', '开始新的原生线程？当前线程仍保留在原生历史中。')
                : confirmation.kind === 'archive' ? tr('Archive this session and stop its live agent?', '归档这个会话并停止它正在运行的 Agent？')
                : confirmation.kind === 'restart' ? tr('Restart this agent process? Its conversation remains available.', '重启此 Agent 进程？聊天记录会保留。')
                : confirmation.kind === 'reopen' ? tr('Reopen this session with its original engine?', '使用原引擎重新打开这条会话？')
                : confirmation.kind === 'switch-account' ? tr('Switch the account used by this session?', '切换这个会话使用的账号？') : tr('Clear the persistent goal?', '清除持续目标？')}</p>
            <button type="button" disabled={operation.busy || !allowed(confirmation)} onClick={() => { void perform(confirmation); }}>{tr('Confirm', '确认')}</button><button type="button" disabled={operation.busy} onClick={() => setConfirmation(null)}>{tr('Cancel', '取消')}</button></div>}
        {actionError && <p role="alert" className="hapi-error">{actionError}</p>}
        <OperationStatus operation={operation} language={language}/><OpenResult receipt={operation.receipt} onOpen={id => {
            if (operation.receipt?.action === 'reopen' || operation.receipt?.action === 'resume') (onSuccessor ?? onOpen)(id); else onOpen(id);
        }} language={language}/>
        <button type="button" disabled={state.loading} onClick={() => { void state.refresh(); }}>{tr('Refresh session state', '刷新会话状态')}</button>
    </section>;
}

export function NativeRewindButton({ api, sessionId, messageId, messageSeq, onChanged, language }: {
    api: HapiRemoteApi; sessionId: string; messageId?: string | undefined; messageSeq?: number | undefined; onChanged?: (() => void) | undefined; language?: string | undefined;
}) {
    const tr = words(language); const [confirm, setConfirm] = useState(false); const operation = useOperation(api);
    const rewind = async () => {
        const receipt = await operation.run(async operationId => remoteValue(await api.nativeSourceOperation({ operationId, sessionId, action: { kind: 'rewind', ...(messageId === undefined ? { displayMessageSeq: messageSeq! } : { displayMessageId: messageId }) } })));
        if (receipt?.status === 'confirmed') { setConfirm(false); onChanged?.(); }
    };
    return <span className="hapi-native-rewind"><button type="button" disabled={operation.busy} onClick={() => setConfirm(value => !value)}>{tr('Rewind here', '回退到此处')}</button>
        {confirm && <span role="group" aria-label={tr('Confirm native rewind', '确认原生回退')}>
            <span>{tr('Rewind the original conversation to this user message?', '将原始会话回退到这条用户消息？')}</span>
            <button type="button" disabled={operation.busy} onClick={() => { void rewind(); }}>{tr('Rewind conversation', '回退会话')}</button><button type="button" onClick={() => setConfirm(false)}>{tr('Cancel', '取消')}</button></span>}
        <OperationStatus operation={operation} language={language}/></span>;
}
