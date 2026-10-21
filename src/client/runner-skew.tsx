import { useEffect, useSyncExternalStore } from 'react';
import { listSkewedMachines, missingRequiredCapabilities } from '../source-runner-capabilities.ts';
import type { SourceAdminAction } from '../source-admin-types.ts';
import type { SourceAdminController } from './source-admin-state.ts';
import type { SourceAdministrationRuntime } from './source-admin-runtime.ts';
import type { RunnerSkewPreferences } from './runner-skew-state.ts';

const languageText = (language: string) => (en: string, zh: string) => language.startsWith('zh') ? zh : en;
function subscribeOnline(listener: () => void): () => void {
    window.addEventListener('online', listener); window.addEventListener('offline', listener);
    return () => { window.removeEventListener('online', listener); window.removeEventListener('offline', listener); };
}
const browserOnline = () => typeof navigator === 'undefined' || navigator.onLine !== false;

/** Mount in the workspace's normal layout flow, never over a terminal or conversation. */
export function RunnerSkewBanner({ runtime, preferences, language }: {
    runtime: SourceAdministrationRuntime; preferences: RunnerSkewPreferences; language: string;
}) {
    const snapshot = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot);
    const preference = useSyncExternalStore(preferences.subscribe, preferences.getSnapshot);
    const online = useSyncExternalStore(subscribeOnline, browserOnline), tr = languageText(language);
    useEffect(() => {
        const refresh = () => { if (browserOnline() && document.visibilityState !== 'hidden') void runtime.refresh(); };
        refresh();
        const timer = window.setInterval(refresh, 15_000);
        window.addEventListener('focus', refresh); window.addEventListener('online', refresh); document.addEventListener('visibilitychange', refresh);
        return () => { window.clearInterval(timer); window.removeEventListener('focus', refresh); window.removeEventListener('online', refresh); document.removeEventListener('visibilitychange', refresh); };
    }, [runtime]);
    useEffect(() => {
        if (!preference.dismissUntil) return;
        const remaining = Math.max(0, preference.dismissUntil - Date.now());
        if (!remaining) { preferences.expire(); return; }
        const timer = window.setTimeout(() => preferences.expire(), Math.min(remaining, 2_147_483_647));
        return () => window.clearTimeout(timer);
    }, [preferences, preference.dismissUntil]);
    const data = snapshot.data;
    if (!online || snapshot.error || !data?.connected || !snapshot.controller || preference.dismissUntil > Date.now()) return null;
    const machines = listSkewedMachines(data.machines);
    if (!machines.length) return null;
    const hosts = machines.map(machine => machine.displayName || machine.host || machine.id).join(', ');
    if (preference.minimized) return <section className="hapi-runner-skew hapi-runner-skew-minimized" data-hapi-runner-skew="minimized" aria-label={tr('Runner compatibility', 'Runner 兼容性')}>
        <button type="button" onClick={() => preferences.setMinimized(false)} aria-expanded={false}>
            {tr(`${machines.length} Runner${machines.length === 1 ? '' : 's'} missing required capabilities`, `${machines.length} 个 Runner 缺少所需能力`)} · {hosts}
            <span>{tr('Expand', '展开')}</span>
        </button>
    </section>;
    return <section className="hapi-runner-skew" data-hapi-runner-skew="expanded" role="alert" aria-label={tr('Runner compatibility', 'Runner 兼容性')}>
        <header><div><strong>{tr('Some Runners need an update', '部分 Runner 需要更新')}</strong>
            <p>{tr('These connected Runners do not advertise capabilities required by this HAPI version. Other sessions remain available.', '这些在线 Runner 尚未声明此 HAPI 版本所需的能力。其他会话仍可使用。')}</p></div>
            <div className="hapi-runner-skew-actions"><button type="button" onClick={() => preferences.setMinimized(true)} aria-expanded={true}>{tr('Minimize', '收起')}</button>
                <button type="button" onClick={() => preferences.dismiss()}>{tr('Dismiss for 1 hour', '暂时隐藏 1 小时')}</button></div></header>
        <RunnerSkewMachines runtime={runtime} controller={snapshot.controller} language={language}/>
        <footer><span>{tr('A supervised restart loads the installed CLI. Install a compatible CLI first if the installed binary has not changed.', '受监管的重启会加载已安装的 CLI。若磁盘上的 CLI 尚未改变，请先安装兼容的版本。')}</span>
            <button type="button" disabled={snapshot.loading} onClick={() => { void runtime.refresh(); }}>{tr('Refresh Runner state', '刷新 Runner 状态')}</button></footer>
    </section>;
}

function RunnerSkewMachines({ runtime, controller, language }: {
    runtime: SourceAdministrationRuntime; controller: SourceAdminController; language: string;
}) {
    const snapshot = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot);
    const operations = useSyncExternalStore(controller.subscribe, controller.getSnapshot), tr = languageText(language);
    const machines = listSkewedMachines(snapshot.data?.machines ?? []);
    return <><ul>{machines.map(machine => {
        const action: SourceAdminAction = { kind: 'restart-runner', machineId: machine.id };
        const matching = operations.receipts.filter(receipt => receipt.action.kind === 'restart-runner' && receipt.action.machineId === machine.id);
        const unknown = matching.find(receipt => receipt.status === 'indeterminate' || receipt.status === 'submitting');
        const unsavedReply = operations.intents.find(intent => intent.action.kind === 'restart-runner' && intent.action.machineId === machine.id
            && !operations.receipts.some(receipt => receipt.operationId === intent.operationId));
        const unresolvedId = unknown?.operationId ?? unsavedReply?.operationId;
        const eligibleRestart = machine.restartRecommended && machine.supervisedRestart;
        const canRestart = machine.online && eligibleRestart && controller.canRun(action);
        return <li key={machine.id} data-source-runner-skew={machine.id}>
            <div><strong>{machine.displayName || machine.host || machine.id}</strong>{machine.version && <span> · CLI {machine.version}</span>}
                <p>{tr('Missing capabilities', '缺少能力')}: {missingRequiredCapabilities(machine.capabilities).map((capability, index) => <span key={capability}>{index ? ', ' : ''}<code>{capability}</code></span>)}</p>
                {machine.restartRecommended && <p>{tr('The installed CLI differs from the running binary.', '已安装的 CLI 与运行中的二进制文件不同。')}</p>}
                {unresolvedId && <p>{tr('The original restart result is not confirmed. Read its status; it will not be sent again.', '原重启结果尚未确认。请查询其状态，不会再次发送重启。')}</p>}
                {!unresolvedId && matching[0]?.message && <p role="status">{matching[0].message}</p>}
            </div>
            {(eligibleRestart || unresolvedId) && <div className="hapi-runner-skew-actions">{eligibleRestart && <button type="button" disabled={!canRestart} onClick={() => { void controller.run(action).then(() => runtime.revalidate()); }}>
                {operations.busy && unsavedReply ? tr('Requesting restart…', '正在请求重启…') : tr('Restart Runner', '重启 Runner')}</button>}
                {unresolvedId && <button type="button" onClick={() => { void controller.inspect(unresolvedId).then(() => runtime.revalidate()); }}>{tr('Read original restart', '查询原重启')}</button>}
            </div>}
        </li>;
    })}</ul>{operations.error && <p className="hapi-runner-skew-error" role="alert">{operations.error}</p>}</>;
}

export const runnerSkewStyles = `
.hapi-runner-skew{flex:0 0 auto;min-width:0;max-height:34dvh;overflow:auto;padding:10px 14px;border-block:1px solid color-mix(in srgb,var(--dsw-static-orange-500,#c88a32) 65%,transparent);background:color-mix(in srgb,var(--dsw-static-orange-500,#c88a32) 10%,var(--hapi-bg,Canvas));color:var(--hapi-fg,CanvasText);font:12px/1.45 system-ui,sans-serif}
.hapi-runner-skew header,.hapi-runner-skew footer,.hapi-runner-skew li{display:flex;align-items:start;justify-content:space-between;gap:10px}.hapi-runner-skew header>div:first-child,.hapi-runner-skew li>div:first-child{min-width:0;flex:1}.hapi-runner-skew p{margin:4px 0;overflow-wrap:anywhere}.hapi-runner-skew code{font-size:11px}.hapi-runner-skew ul{list-style:none;margin:8px 0;padding:0;display:grid;gap:6px}.hapi-runner-skew li{padding:8px;border:1px solid var(--hapi-border,#8884);border-radius:6px}.hapi-runner-skew-actions{display:flex;flex-wrap:wrap;gap:6px;flex:0 0 auto}.hapi-runner-skew button{font:inherit;color:inherit;border:1px solid var(--hapi-border,#8885);border-radius:5px;background:var(--hapi-bg,Canvas);padding:5px 8px;cursor:pointer}.hapi-runner-skew button:disabled{cursor:default;opacity:.5}.hapi-runner-skew footer{align-items:center;gap:12px;font-size:11px}.hapi-runner-skew footer>span{flex:1}.hapi-runner-skew footer>button{flex:0 0 auto}.hapi-runner-skew-minimized{padding:0}.hapi-runner-skew-minimized>button{border:0;border-radius:0;width:100%;display:flex;align-items:center;justify-content:space-between;gap:8px;text-align:left;background:transparent;padding:6px 14px;overflow-wrap:anywhere}.hapi-runner-skew-minimized>button>span{font-weight:600;flex:0 0 auto}.hapi-runner-skew-error{color:var(--hapi-danger,#a92f32)}
@media(max-width:600px){.hapi-runner-skew{padding:8px;max-height:30dvh}.hapi-runner-skew header,.hapi-runner-skew footer,.hapi-runner-skew li{flex-wrap:wrap}.hapi-runner-skew header>div:first-child{flex-basis:100%}.hapi-runner-skew-minimized{padding:0}.hapi-runner-skew-minimized>button{padding:7px 10px}.hapi-runner-skew li>div:first-child{flex-basis:100%}}
`;
