import { randomId } from './random-id.ts';
import { useEffect, useRef, useState } from 'react';
import { remoteValue } from '../client-api.ts';
import type { SourceAdminApi, SourceBulkOperation, SourceBulkReceipt } from '../source-admin-types.ts';

export function SourceBulkPanel({ api, hubId, language }: { api: Pick<SourceAdminApi, 'sourceSessionBulk' | 'sourceSessionBulkRead'>; hubId: string; language: string }) {
    const tr = (en: string, zh: string) => language.startsWith('zh') ? zh : en;
    const key = `hapi-dsh:source-bulk:v1:${hubId}`;
    const [receipt, setReceipt] = useState<SourceBulkReceipt | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
    const pending = useRef<string | null>(null), mounted = useRef(true), flight = useRef(false);
    const inspect = async (id = pending.current) => {
        if (!id || flight.current) return; flight.current = true; setBusy(true);
        try {
            const value = remoteValue(await api.sourceSessionBulkRead({ operationId: id }));
            if (mounted.current) { setReceipt(value); setError(value ? null : tr('The Host has no receipt for this saved operation. It has not been submitted again.', 'Host 尚无这次已保存操作的回执，没有再次提交。')); }
        } catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason)); }
        finally { flight.current = false; if (mounted.current) setBusy(false); }
    };
    useEffect(() => {
        mounted.current = true;
        try { pending.current = localStorage.getItem(key); if (pending.current) void inspect(); }
        catch { setError(tr('Browser recovery storage is unavailable.', '浏览器恢复存储不可用。')); }
        return () => { mounted.current = false; };
    }, [key, api]);
    useEffect(() => {
        if (!receipt || !['reading', 'running'].includes(receipt.state)) return;
        const timer = setInterval(() => { void inspect(); }, 1500); return () => clearInterval(timer);
    }, [receipt?.state, receipt?.operationId, api]);
    const run = async (action: SourceBulkOperation['action']) => {
        if (flight.current) return;
        const operationId = randomId();
        try { localStorage.setItem(key, operationId); } catch { setError(tr('The operation was not sent because its recovery identity could not be saved.', '恢复标识无法保存，因此操作未发送。')); return; }
        pending.current = operationId; flight.current = true; setBusy(true); setError(null); setReceipt(null);
        try { const result = remoteValue(await api.sourceSessionBulk({ operationId, action })); if (mounted.current) setReceipt(result); }
        catch (reason) { if (mounted.current) setError(`${tr('The reply is missing. Check the saved operation; refreshing does not repeat it.', '未收到回执，请查询已保存操作；刷新不会重复提交。')} ${reason instanceof Error ? reason.message : String(reason)}`); }
        finally { flight.current = false; if (mounted.current) setBusy(false); }
    };
    const status = (value: SourceBulkReceipt['targets'][number]['status']) => ({
        prepared: tr('Not dispatched', '尚未发送'), dispatching: tr('Awaiting source reply', '等待源回执'), accepted: tr('Source accepted', '源端已接受'),
        rejected: tr('Source did not accept', '源端未接受'), unknown: tr('Result unknown; not replayed', '结果未知，未重发'), skipped: tr('Skipped', '已跳过'),
    })[value];
    return <section className="hapi-source-bulk" aria-label={tr('Session bulk actions', '会话批量操作')}>
        <h3>{tr('Session bulk actions', '会话批量操作')}</h3>
        <p>{tr('Each click reads the original Hub again, across its machines and source sessions. Waiting approvals and input remain untouched by Pause.', '每次点击都会重新读取原 Hub，覆盖其机器和源会话。暂停操作保留等待审批或输入的会话。')}</p>
        <div className="hapi-button-row"><button type="button" disabled={busy} onClick={() => { void run('standard'); }}>{tr('Set all Fast Codex sessions to Standard', '将所有 Fast Codex 会话改为 Standard')}</button>
            <button type="button" disabled={busy} onClick={() => { void run('pause'); }}>{tr('Pause all running source sessions', '暂停所有运行中的源会话')}</button></div>
        {busy && <p role="status">{tr('Reading and applying the original source operations…', '正在读取并执行原始源操作…')}</p>}
        {error && <p role="alert" className="hapi-error">{error}</p>}
        {receipt && <div data-source-bulk={receipt.operationId}>
            <p role="status">{receipt.targets.filter(row => row.status === 'accepted').length} / {receipt.targets.length} · {tr('source accepted', '源端已接受')} · {receipt.state}</p>
            <small>{tr('An accepted stop request is not proof that a running turn has already ended. Source events continue to report execution state.', '中断请求被接受不代表运行已结束，执行状态仍由源事件报告。')}</small>
            {receipt.error && <p role="alert" className="hapi-error">{receipt.error}</p>}
            <ul>{receipt.targets.map(row => <li key={row.sourceSessionId} data-bulk-session={row.sourceSessionId}><strong>{row.name}</strong> · {status(row.status)}
                {row.machineId && <small> · {row.machineId}</small>}{row.error && <p>{row.error}</p>}</li>)}</ul>
        </div>}
        {pending.current && <button type="button" disabled={busy} onClick={() => { void inspect(); }}>{tr('Check saved bulk operation', '查询已保存的批量操作')}</button>}
    </section>;
}
