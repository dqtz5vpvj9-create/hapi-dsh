import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ComponentType } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-ui-settings/client';
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import { remoteValue } from '../client-api.ts';
import { SOURCE_BACKUP_PATH, type SourceAdminApi, type SourceAdministration, type SourceAdminAction, type SourceAdminMachine,
    type SourceDshBundles, type SourceStorage, type SourceUsage, type SourceUsageRequest } from '../source-admin-types.ts';
import { SourceAdminController } from './source-admin-state.ts';
import { SourceAdministrationRuntime } from './source-admin-runtime.ts';
import { RunnerSkewPreferences } from './runner-skew-state.ts';
import { RunnerSkewBanner, runnerSkewStyles } from './runner-skew.tsx';
import { missingRequiredCapabilities } from '../source-runner-capabilities.ts';
import { SourceBulkPanel } from './source-bulk.tsx';
import { notifySourceSummarySettings, type SourceSummarySettings } from './notify-summary-state.ts';
import type {} from './workspace-ui.ts';
import { MachineHealthStats } from './machine-health-view.tsx';

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const words = (language: string) => (en: string, zh: string) => language.startsWith('zh') ? zh : en;
function storage(): Storage | undefined { try { return globalThis.localStorage; } catch { return undefined; } }
export function byteSize(value: number): string {
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']; let index = 0;
    while (value >= 1024 && index < units.length - 1) { value /= 1024; index++; }
    return `${value.toLocaleString(undefined, { maximumFractionDigits: index ? 2 : 0 })} ${units[index]}`;
}
function useRead<T>(key: string, read: () => Promise<T>) {
    const fn = useRef(read); fn.current = read; const generation = useRef(0);
    const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: false });
    const refresh = useCallback(async () => {
        const revision = ++generation.current; setState(value => ({ ...value, error: null, loading: true }));
        try { const data = await fn.current(); if (generation.current === revision) setState({ data, error: null, loading: false }); }
        catch (error) { if (generation.current === revision) setState(value => ({ ...value, error: errorText(error), loading: false })); }
    }, []);
    useEffect(() => { setState({ data: null, error: null, loading: false }); void refresh(); return () => { generation.current++; }; }, [key, refresh]);
    return { ...state, refresh };
}

function ReceiptList({ controller, language }: { controller: SourceAdminController; language: string }) {
    const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot), tr = words(language);
    return <div className="hapi-admin-receipts">
        {state.error && <p role="alert" className="hapi-error">{state.error}</p>}
        {state.intents.filter(intent => !state.receipts.some(row => row.operationId === intent.operationId)).map(intent => <p key={intent.operationId}>
            <code>{intent.operationId}</code> <button type="button" onClick={() => { void controller.inspect(intent.operationId); }}>{tr('Read original operation', '读取原操作')}</button></p>)}
        {state.receipts.length > 0 && <details><summary>{tr('Operation history', '操作记录')} ({state.receipts.length})</summary>
            {state.receipts.map(receipt => <article key={receipt.operationId}><strong>{receipt.action.kind} · {receipt.status}</strong><small> · {new Date(receipt.createdAt).toLocaleString()}</small>
                {receipt.message && <p>{receipt.message}</p>}<code>{receipt.operationId}</code>
                {receipt.status === 'indeterminate' && <button type="button" onClick={() => { void controller.inspect(receipt.operationId); }}>{tr('Check original source', '查询原始源')}</button>}</article>)}</details>}
    </div>;
}

function RunnerSettings({ api, machine, controller, refresh, language }: {
    api: SourceAdminApi; machine: SourceAdminMachine; controller: SourceAdminController; refresh(): Promise<void>; language: string;
}) {
    const tr = words(language), state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
    const [name, setName] = useState(machine.displayName), [confirmation, setConfirmation] = useState(false), [showBundles, setShowBundles] = useState(false);
    useEffect(() => { setName(machine.displayName); setConfirmation(false); setShowBundles(false); }, [machine.id, machine.displayName]);
    const perform = async (action: SourceAdminAction) => { const receipt = await controller.run(action); if (receipt) { setConfirmation(false); await refresh(); } };
    const rename = { kind: 'machine-name' as const, machineId: machine.id, displayName: name.trim() }, restart = { kind: 'restart-runner' as const, machineId: machine.id };
    return <div>
        <h3>{machine.displayName || machine.host || machine.id}</h3>
        <dl className="hapi-admin-properties"><dt>{tr('Connection', '连接')}</dt><dd>{machine.online ? tr('Online', '在线') : tr('Offline', '离线')}</dd>
            <dt>{tr('Runner version', 'Runner 版本')}</dt><dd>{machine.version || '—'}</dd><dt>{tr('Platform', '平台')}</dt><dd>{machine.platform || '—'}</dd>
            <dt>{tr('Last seen', '最后在线')}</dt><dd>{new Date(machine.lastSeenAt).toLocaleString()}</dd>
            <dt>{tr('Home directory', '主目录')}</dt><dd>{machine.homeDir || '—'}</dd>
            {machine.runner && <><dt>{tr('Process', '进程')}</dt><dd>{machine.runner.status} · PID {machine.runner.pid ?? '—'}
                {machine.runner.startedAt !== null && <> · {new Date(machine.runner.startedAt).toLocaleString()}</>}</dd></>}
        </dl>
        <MachineHealthStats health={machine.health} platform={machine.platform} online={machine.online} language={language}/>
        <details><summary>{tr('Workspace roots and capabilities', '工作区目录与能力')}</summary><ul>{machine.workspaceRoots.map(path => <li key={path}><code>{path}</code></li>)}</ul>
            <p>{machine.capabilities.join(' · ') || '—'}</p><code>{machine.id}</code></details>
        <form onSubmit={event => { event.preventDefault(); void perform(rename); }}>
            <label>{tr('Machine display name', '机器显示名称')}<input maxLength={64} value={name} onChange={event => setName(event.currentTarget.value)}/></label>
            <small>{tr('Leave empty to use its original host name.', '留空可恢复原主机名。')}</small><div className="hapi-button-row"><button type="submit" disabled={!controller.canRun(rename)}>{tr('Save machine name', '保存机器名称')}</button></div>
        </form>
        {machine.online && missingRequiredCapabilities(machine.capabilities).length > 0 && <p role="status">{tr('Missing required Runner capabilities', 'Runner 缺少所需能力')}: <code>{missingRequiredCapabilities(machine.capabilities).join(', ')}</code></p>}
        {machine.restartRecommended && <p role="status">{tr('The installed CLI differs from the running binary. Restart the Runner to load it.', '已安装的 CLI 与运行中的二进制文件不同。重启 Runner 后会加载它。')}</p>}
        <button type="button" disabled={!machine.online || !machine.supervisedRestart || !controller.canRun(restart)} onClick={() => setConfirmation(true)}>{tr('Restart Runner', '重启 Runner')}</button>
        {!machine.supervisedRestart && <p><small>{tr('Restart is available when the original Runner has a supervisor configured to relaunch it.', '原 Runner 配置了自动拉起进程的 supervisor 后才支持此重启入口。')}</small></p>}
        {confirmation && <div role="group" aria-label={tr('Confirm Runner restart', '确认重启 Runner')}><p>{tr('Stop this Runner and let its configured supervisor relaunch it? Its connection will briefly go offline.', '停止此 Runner 并由已配置的 supervisor 重新拉起？连接会短暂离线。')}</p>
            <div className="hapi-button-row"><button type="button" disabled={state.busy} onClick={() => { void perform(restart); }}>{tr('Confirm Runner restart', '确认重启 Runner')}</button><button type="button" onClick={() => setConfirmation(false)}>{tr('Cancel', '取消')}</button></div></div>}
        <h3>{tr('Runner DSH profile', 'Runner 的 DSH Profile')}</h3>
        <p>{tr('This is the bundle profile used by HAPI’s DSH agent on this Runner. Existing sessions keep their startup composition.', '这是此 Runner 上 HAPI 的 DSH Agent 使用的 bundle 配置。现有会话保留启动时的组成。')}</p>
        <button type="button" disabled={!machine.online} onClick={() => setShowBundles(value => !value)}>{tr('Show source profile', '查看源 Profile')}</button>
        {showBundles && <RunnerBundles api={api} machineId={machine.id} controller={controller} language={language}/>}
    </div>;
}
function RunnerBundles({ api, machineId, controller, language }: { api: SourceAdminApi; machineId: string; controller: SourceAdminController; language: string }) {
    const tr = words(language), state = useRead<SourceDshBundles>(machineId, async () => remoteValue(await api.sourceAdminBundles({ machineId })));
    useSyncExternalStore(controller.subscribe, controller.getSnapshot);
    return <div>{state.loading && <p role="status">{tr('Reading profile…', '正在读取 Profile…')}</p>}{state.error && <p role="alert" className="hapi-error">{state.error}</p>}
        {state.data && <><p><strong>{state.data.profile}</strong> · <code>{state.data.dshHome}</code></p>
            {state.data.restartRequired && <p role="status">{tr('Profile changed. Start a new DSH session to use the new composition.', 'Profile 已更改。新建 DSH 会话后使用新配置。')}</p>}
            {state.data.available.map(bundle => {
                const action = { kind: 'dsh-bundle' as const, machineId, name: bundle.name, enabled: !bundle.enabled };
                return <label key={bundle.name} className="hapi-admin-toggle"><input type="checkbox" checked={bundle.enabled} disabled={!bundle.switchable || !controller.canRun(action)} onChange={() => {
                    void controller.run(action).then(() => state.refresh());
                }}/><span>{bundle.name}<small>{bundle.description}{!bundle.switchable && ` · ${tr('Required foundation', '必需基础组件')}`}</small></span></label>;
            })}</>}
        <button type="button" disabled={state.loading} onClick={() => { void state.refresh(); }}>{tr('Refresh profile', '刷新 Profile')}</button></div>;
}

function StoragePanel({ api, hubId, language }: { api: SourceAdminApi; hubId: string; language: string }) {
    const tr = words(language), state = useRead<SourceStorage>(hubId, async () => remoteValue(await api.sourceAdminStorage()));
    const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [received, setReceived] = useState(0);
    const download = useRef<AbortController | null>(null);
    useEffect(() => () => download.current?.abort(), []);
    const backup = async () => {
        if (download.current) return;
        const abort = new AbortController(); download.current = abort; setBusy(true); setError(null); setReceived(0);
        try {
            const response = await fetch(SOURCE_BACKUP_PATH, { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json', 'X-Hapi-Backup': '1' }, body: JSON.stringify({ hubId }), signal: abort.signal });
            if (!response.ok) { const result: unknown = await response.json().catch(() => null); throw new Error(result && typeof result === 'object' && 'error' in result && typeof result.error === 'string' ? result.error : `HTTP ${response.status}`); }
            if (!response.body || response.headers.get('content-type')?.split(';')[0] !== 'application/vnd.sqlite3') throw new Error(tr('The source did not return a SQLite backup.', '源端未返回 SQLite 备份。'));
            const reader = response.body.getReader(), chunks: Uint8Array<ArrayBuffer>[] = []; let bytes = 0;
            try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; chunks.push(new Uint8Array(chunk.value)); bytes += chunk.value.byteLength; setReceived(bytes); } }
            finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
            abort.signal.throwIfAborted();
            const blob = new Blob(chunks, { type: 'application/vnd.sqlite3' }), url = URL.createObjectURL(blob), link = document.createElement('a');
            const name = /filename="([^"/\\]*)"/.exec(response.headers.get('content-disposition') ?? '')?.[1] ?? 'hapi-backup.db';
            link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 60_000);
        } catch (failure) { if (!abort.signal.aborted) setError(errorText(failure)); }
        finally { download.current = null; setBusy(false); }
    };
    const slices = state.data ? [
        { name: tr('Database', '数据库'), bytes: state.data.databaseBytes, color: 'var(--text-link,#668de5)' },
        { name: 'WAL', bytes: state.data.walBytes, color: '#b38c55' }, { name: 'SHM', bytes: state.data.shmBytes, color: '#5baa8d' },
    ] : [];
    return <div><h3>{tr('Original Hub database', '原 Hub 数据库')}</h3>
        {state.loading && <p role="status">{tr('Reading storage…', '正在读取存储…')}</p>}{state.error && <p role="alert" className="hapi-error">{state.error}</p>}
        {state.data && <><p><code>{state.data.path}</code></p><strong>{byteSize(state.data.totalBytes)}</strong>
            <div className="hapi-admin-storage-bar" aria-hidden="true">{slices.map(slice => <span key={slice.name} style={{ width: `${state.data!.totalBytes ? slice.bytes / state.data!.totalBytes * 100 : 0}%`, background: slice.color }}/>)}</div>
            <dl className="hapi-admin-properties">{slices.map(slice => <span key={slice.name}><dt>{slice.name}</dt><dd>{byteSize(slice.bytes)}</dd></span>)}</dl></>}
        <p>{tr('The original Hub creates a consistent SQLite snapshot. Its database, WAL and SHM remain managed by HAPI.', '原 Hub 生成一致的 SQLite 快照，数据库、WAL 和 SHM 继续由 HAPI 管理。')}</p>
        <div className="hapi-button-row"><button type="button" disabled={busy || !state.data} onClick={() => { void backup(); }}>{tr('Download database backup', '下载数据库备份')}</button>
            <button type="button" disabled={state.loading} onClick={() => { void state.refresh(); }}>{tr('Refresh storage', '刷新存储')}</button>
            {busy && <button type="button" onClick={() => download.current?.abort()}>{tr('Cancel download', '取消下载')}</button>}</div>
        {busy && <p role="status">{tr('Downloading snapshot', '正在下载快照')} · {byteSize(received)}</p>}{error && <p role="alert" className="hapi-error">{error}</p>}
    </div>;
}
function UsageRows({ rows, title, language }: { rows: SourceUsage['daily']; title: string; language: string }) {
    const tr = words(language), max = Math.max(1, ...rows.map(row => row.totalTokens));
    return <section><h3>{title}</h3>{!rows.length && <p>{tr('No recorded usage in this range.', '此范围内没有用量记录。')}</p>}
        {rows.map(row => <details key={row.key} className="hapi-admin-usage-row"><summary><span>{row.key}</span><strong>{row.totalTokens.toLocaleString()}</strong></summary>
            <div className="hapi-admin-usage-bar" aria-hidden="true"><span style={{ width: `${row.totalTokens / max * 100}%` }}/></div>
            <dl className="hapi-admin-properties"><dt>{tr('Input', '输入')}</dt><dd>{row.inputTokens.toLocaleString()}</dd><dt>{tr('Output', '输出')}</dt><dd>{row.outputTokens.toLocaleString()}</dd>
                <dt>{tr('Cache read', '缓存读取')}</dt><dd>{row.cacheReadTokens.toLocaleString()}</dd><dt>{tr('Cache creation', '缓存创建')}</dt><dd>{row.cacheCreationTokens.toLocaleString()}</dd><dt>{tr('Requests', '请求')}</dt><dd>{row.requests.toLocaleString()}</dd></dl></details>)}</section>;
}
function UsagePanel({ api, hubId, language }: { api: SourceAdminApi; hubId: string; language: string }) {
    const tr = words(language), [range, setRange] = useState<SourceUsageRequest['range']>('7d');
    const [timeZone, setTimeZone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
    const state = useRead<SourceUsage>(`${hubId}:${range}:${timeZone}`, async () => remoteValue(await api.sourceAdminUsage({ range, timeZone })));
    const data = state.data, metrics = data ? [
        [tr('Total tokens', '总 Token'), data.totals.totalTokens.toLocaleString()], [tr('Uncached', '未缓存'), data.totals.uncachedTokens.toLocaleString()],
        [tr('Input', '输入'), data.totals.inputTokens.toLocaleString()], [tr('Output', '输出'), data.totals.outputTokens.toLocaleString()],
        [tr('Cache read', '缓存读取'), data.totals.cacheReadTokens.toLocaleString()], [tr('Cache creation', '缓存创建'), data.totals.cacheCreationTokens.toLocaleString()],
        [tr('Cache hit rate', '缓存命中率'), `${(data.totals.inputTokens ? data.totals.cacheReadTokens / data.totals.inputTokens * 100 : 0).toFixed(1)}%`],
        [tr('Requests', '请求'), data.totals.requests.toLocaleString()], [tr('Sessions', '会话'), data.totals.sessions.toLocaleString()],
    ] : [];
    return <div><h3>{tr('Source usage', '源端用量')}</h3><div className="hapi-button-row" role="radiogroup" aria-label={tr('Usage period', '用量范围')}>
        {(['7d', '30d', 'all'] as const).map(value => <button key={value} type="button" role="radio" aria-checked={range === value} onClick={() => setRange(value)}>{value === '7d' ? tr('7 days', '7 天') : value === '30d' ? tr('30 days', '30 天') : tr('All time', '全部')}</button>)}</div>
        <label>{tr('Time zone', '时区')}<select value={timeZone} onChange={event => setTimeZone(event.currentTarget.value)}>{[...new Set([Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', 'UTC'])].map(zone => <option key={zone}>{zone}</option>)}</select></label>
        {state.loading && <p role="status">{tr('Reading source usage…', '正在读取源端用量…')}</p>}{state.error && <p role="alert" className="hapi-error">{state.error}</p>}
        {data && <><div className="hapi-admin-metrics">{metrics.map(([label, value]) => <div key={label}><small>{label}</small><strong>{value}</strong></div>)}</div>
            <UsageRows rows={data.daily} title={tr('Daily usage', '每日用量')} language={language}/><UsageRows rows={data.byAgent} title={tr('By agent', '按 Agent')} language={language}/><UsageRows rows={data.byModel} title={tr('By model', '按模型')} language={language}/>
            <small>{tr('Updated', '更新于')} {new Date(data.updatedAt).toLocaleString()}</small></>}
        <div className="hapi-button-row"><button type="button" disabled={state.loading} onClick={() => { void state.refresh(); }}>{tr('Refresh usage', '刷新用量')}</button></div>
    </div>;
}

function Administration({ api, data, controller, refresh, language, onSummarySettings }: { api: SourceAdminApi; data: SourceAdministration; controller: SourceAdminController; refresh(): Promise<void>; language: string; onSummarySettings(value: SourceSummarySettings): void }) {
    const tr = words(language), [tab, setTab] = useState<'hub' | 'machines' | 'storage' | 'usage'>('hub'), [machineId, setMachineId] = useState('');
    useSyncExternalStore(controller.subscribe, controller.getSnapshot);
    const machine = data.machines.find(row => row.id === machineId) ?? data.machines.find(row => row.online) ?? data.machines[0];
    return <><div className="hapi-button-row" role="tablist" aria-label={tr('HAPI administration', 'HAPI 管理')}>
        {([['hub', tr('Hub', 'Hub')], ['machines', tr('Machines', '机器')], ['storage', tr('Storage', '存储')], ['usage', tr('Usage', '用量')]] as const).map(([value, label]) => <button type="button" role="tab" key={value} aria-selected={tab === value} onClick={() => setTab(value)}>{label}</button>)}</div>
        {tab === 'hub' && <div><p><strong>{data.hubId}</strong> · {data.connected ? tr('Connected', '已连接') : tr('Reconnecting', '正在重连')}</p>
            {data.settingsError && <p role="alert" className="hapi-error">{data.settingsError}</p>}{data.settings && <>
                {([['sessionSummaryContract', tr('Ask agents for compact task summaries', '请求 Agent 生成简短任务摘要'), tr('New sessions receive the original Hub’s summary contract.', '新会话使用原 Hub 的摘要约定。')],
                    ['sessionSummaryInChat', tr('Show compact summaries in chat', '在聊天中显示简短摘要'), tr('This updates the original Hub’s chat display preference.', '更新原 Hub 的聊天显示偏好。')]] as const).map(([key, label, description]) => {
                    const action = { kind: 'settings' as const, values: { [key]: !data.settings![key] } };
                    return <label key={key} className="hapi-admin-toggle"><input type="checkbox" checked={data.settings![key]} disabled={!controller.canRun(action)} onChange={() => { void controller.run(action).then(receipt => {
                        if (receipt?.settings && (receipt.status === 'confirmed' || receipt.status === 'observed')) onSummarySettings({ hubId: receipt.hubId, sessionSummaryInChat: receipt.settings.sessionSummaryInChat });
                        return refresh();
                    }); }}/><span>{label}<small>{description}</small></span></label>;
                })}</>}
            <SourceBulkPanel key={data.hubId} api={api} hubId={data.hubId} language={language}/>
        </div>}
        {tab === 'machines' && <div><label>{tr('Machine', '机器')}<select value={machine?.id ?? ''} onChange={event => setMachineId(event.currentTarget.value)}>{data.machines.map(row => <option key={row.id} value={row.id}>{row.displayName || row.host || row.id}{row.online ? '' : ` · ${tr('offline', '离线')}`}</option>)}</select></label>
            {machine ? <RunnerSettings key={machine.id} api={api} machine={machine} controller={controller} refresh={refresh} language={language}/> : <p>{tr('No machines registered with this Hub.', '此 Hub 尚无注册机器。')}</p>}</div>}
        {tab === 'storage' && <StoragePanel api={api} hubId={data.hubId} language={language}/>}{tab === 'usage' && <UsagePanel api={api} hubId={data.hubId} language={language}/>}
        <ReceiptList controller={controller} language={language}/>
    </>;
}

export interface SourceAdminInstallation { (): void; RunnerSkew: ComponentType }

/** Uses the unchanged official Settings shell; the workspace mounts its in-flow banner. */
export function installSourceAdmin(ctx: Context, api: SourceAdminApi): SourceAdminInstallation {
    const readLanguage = () => ctx.locale.getSnapshot().active;
    const runtime = new SourceAdministrationRuntime(api, storage());
    let session: Storage | undefined;
    try { session = globalThis.sessionStorage; } catch { /* Dismissal and minimization remain available in memory. */ }
    const preferences = new RunnerSkewPreferences(session);
    const onSummarySettings = (value: SourceSummarySettings) => notifySourceSummarySettings(ctx.get('hapiWorkspaceUi')?.sourceSummaries, value);
    const Section = (_props: PropsRuntime<'settings.section'>) => {
        const language = useSyncExternalStore(listener => ctx.locale.subscribe(listener), readLanguage), tr = words(language);
        const state = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot);
        useEffect(() => { void runtime.refresh(); }, []);
        return <section className="hapi-source-panel hapi-administration" aria-label={tr('HAPI Hub and Runners', 'HAPI Hub 与 Runner')}><h2>{tr('HAPI Hub and Runners', 'HAPI Hub 与 Runner')}</h2>
            {state.loading && !state.data && <p role="status">{tr('Reading Hub state…', '正在读取 Hub 状态…')}</p>}{state.error && <p role="alert" className="hapi-error">{state.error}</p>}
            {state.data && state.controller && <Administration api={api} data={state.data} controller={state.controller} refresh={runtime.revalidate} language={language} onSummarySettings={onSummarySettings}/>}
            <div className="hapi-button-row"><button type="button" disabled={state.loading} onClick={() => { void runtime.refresh(); }}>{tr('Refresh Hub state', '刷新 Hub 状态')}</button></div>
        </section>;
    };
    const RunnerSkew = () => {
        const language = useSyncExternalStore(listener => ctx.locale.subscribe(listener), readLanguage);
        return <RunnerSkewBanner runtime={runtime} preferences={preferences} language={language}/>;
    };
    const style = document.createElement('style'); style.textContent = styles + runnerSkewStyles; document.head.append(style);
    const unregister = ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'hapi-hub', order: 35, label: () => words(readLanguage())('HAPI Hub', 'HAPI Hub') }, Section));
    return Object.assign(() => { runtime.dispose(); preferences.dispose(); unregister(); style.remove(); }, { RunnerSkew });
}
const styles = `
.hapi-administration{height:auto;min-height:0;padding:0;overflow:visible}.hapi-administration code{overflow-wrap:anywhere}
.hapi-admin-properties{display:grid;grid-template-columns:minmax(90px,1fr) minmax(0,2fr);gap:6px 14px}.hapi-admin-properties>span{display:contents}.hapi-admin-properties dt{opacity:.7}.hapi-admin-properties dd{margin:0;overflow-wrap:anywhere}
.hapi-administration .hapi-admin-toggle{display:flex;align-items:start;gap:10px;margin:16px 0}.hapi-admin-toggle input{margin-top:5px}.hapi-admin-toggle span{flex:1}.hapi-admin-toggle small{display:block;margin-top:4px}
.hapi-admin-metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(125px,1fr));gap:10px}.hapi-admin-metrics>div{display:grid;gap:5px;border:1px solid var(--border-secondary,#8885);border-radius:8px;padding:10px}.hapi-admin-metrics strong{font-size:19px}
.hapi-admin-usage-row{padding:8px 0}.hapi-admin-usage-row summary{display:flex;justify-content:space-between;gap:10px;cursor:pointer;overflow-wrap:anywhere}.hapi-admin-usage-bar{height:5px;border-radius:8px;background:var(--bg-secondary,#8882);margin-top:6px}.hapi-admin-usage-bar span{display:block;height:100%;background:var(--text-link,#668de5);border-radius:8px}
.hapi-admin-storage-bar{height:14px;display:flex;overflow:hidden;border-radius:5px;margin:14px 0}.hapi-admin-storage-bar span{display:block;height:100%}.hapi-admin-receipts{margin-top:22px}.hapi-admin-receipts article{padding:10px 0;border-top:1px solid var(--border-secondary,#8883)}
`;
