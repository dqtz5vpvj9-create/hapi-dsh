/** Root-only Push, app badging and installation controls in official public slots. */
import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type {} from '@deepseek-ai/dsh-client-ui-settings/client';
import type {} from '@deepseek-ai/dsh-client-ui-layout/client';
import type { SourceNotificationsApi } from '../../notification-types.ts';
import { SourceNotificationsRuntime, type SourceNotificationsUiOptions } from './runtime.ts';
import { HAPI_DSH_BUILD_ID, HAPI_DSH_VERSION, DSH_VERSION, HAPI_SOURCE_REVISION } from '../../build-info.ts';
export type { SourceNotificationsUiOptions } from './runtime.ts';

export function installSourceNotifications(ctx: Context, api: SourceNotificationsApi, options: SourceNotificationsUiOptions): () => void {
    const runtime = new SourceNotificationsRuntime(api, options), disposers: Array<() => void> = [];
    const language = () => ctx.locale.getSnapshot().active;
    function useWords() {
        const locale = useSyncExternalStore(listener => ctx.locale.subscribe(listener), language);
        return (en: string, zh: string): string => locale.startsWith('zh') ? zh : en;
    }
    function Settings(_props: PropsRuntime<'settings.section'>) {
        const state = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot), tr = useWords();
        return <section className="hapi-notification-settings" aria-label={tr('Notifications and installation', '通知与安装')}>
            <h2>{tr('Notifications and installation', '通知与安装')}</h2>
            {state.error && <p role="alert" className="hapi-notification-error">{state.error}</p>}
            {state.presenceError && <p role="alert" className="hapi-notification-error">{state.presenceError}</p>}
            <h3>{tr('Push notifications', 'Push 通知')}</h3>
            <p>{tr('Receive original HAPI task and approval notifications when this workspace is not visible. Notifications open the same source conversation in the unified sidebar.', '工作区不可见时接收原 HAPI 任务与审批通知。点击通知后，在统一侧边栏打开相同的源会话。')}</p>
            <p role="status">{!state.supported ? tr('This browser does not support Web Push on this origin. Use HTTPS or a supported local browser.', '此来源上的浏览器不支持 Web Push，请使用 HTTPS 或受支持的本地浏览器。')
                : state.permission === 'denied' ? tr('Notification permission is blocked in the browser. Change its site permission to enable Push.', '浏览器已阻止通知权限，请在站点设置中允许通知后再启用。')
                : state.push === 'on' ? tr('This browser subscription was accepted by the original Hub.', '原 Hub 已接受此浏览器的订阅。')
                : state.push === 'unknown' ? tr('A browser subscription may exist, but Hub registration is not confirmed. No request has been automatically repeated.', '浏览器可能已有订阅，但 Hub 注册结果未确认。系统没有自动重复请求。')
                : tr('Push notifications are off for this browser.', '此浏览器尚未启用 Push 通知。')}</p>
            <div className="hapi-notification-actions"><button type="button" disabled={state.busy || !state.supported || state.permission === 'denied'} onClick={() => { void runtime.enablePush(); }}>
                {state.busy ? tr('Applying…', '处理中…') : state.push === 'unknown' ? tr('Register this browser explicitly', '明确注册此浏览器') : tr('Enable Push notifications', '启用 Push 通知')}</button>
                <button type="button" disabled={state.busy || !state.supported} onClick={() => { void runtime.disablePush(); }}>{tr('Disable Push notifications', '停用 Push 通知')}</button>
                <button type="button" disabled={state.busy} onClick={() => { void runtime.refreshPush(); }}>{tr('Refresh browser status', '刷新浏览器状态')}</button></div>
            <h3>{tr('App icon badge', '应用图标角标')}</h3>
            <label><input type="checkbox" checked={state.badgeEnabled} onChange={event => runtime.setBadgeEnabled(event.target.checked)}/>{tr('Show the unified sidebar unread count', '显示统一侧边栏的未读数')}</label>
            <p>{state.badgeSupported ? tr('Uses the same eligible conversations and read state as the sidebar. Temporary reconnects keep the last known count.', '与侧边栏使用相同的可见会话与已读状态，临时断线保留上次确认的数量。')
                : tr('System badges require an installed app and a browser with App Badging support. The preference is retained here.', '系统角标需要已安装应用与支持 App Badging 的浏览器，此处会保留偏好。')}</p>
            <h3>{tr('Install this workspace', '安装此工作区')}</h3>
            {state.installed ? <p>{tr('This workspace is running as an installed app.', '此工作区正在以已安装应用运行。')}</p>
                : state.iosInstall ? <p>{tr('In Safari, open Share and choose “Add to Home Screen”. Then open the installed app to enable supported notifications and badges.', '在 Safari 中打开“分享”，选择“添加到主屏幕”；从主屏幕打开后，可启用系统支持的通知与角标。')}</p>
                : state.canInstall ? <button type="button" disabled={state.installing} onClick={() => { void runtime.promptInstall(); }}>{state.installing ? tr('Opening installer…', '正在打开安装提示…') : tr('Install workspace', '安装工作区')}</button>
                : <p>{tr('Use the browser’s install or Add to Home Screen action when it is available. The installed app opens this unified workspace.', '浏览器支持时，可使用安装或“添加到主屏幕”操作；安装后仍打开此统一工作区。')}</p>}
            <h3>{tr('Workspace updates', '工作区更新')}</h3>
            {state.updateReady && <p role="status">{tr('An updated workspace is available. Open drafts and attachment bytes are saved before this page reloads.', '工作区已有更新，刷新前会先保存已打开的草稿和附件原始内容。')}</p>}
            <div className="hapi-notification-actions"><button type="button" disabled={state.updating} onClick={() => { void runtime.checkUpdate(); }}>{tr('Check for updates', '检查更新')}</button>
                <button type="button" disabled={state.updating} onClick={() => { void runtime.applyUpdate(); }}>{state.updating ? tr('Saving open editors…', '正在保存已打开的编辑器…') : state.updateReady ? tr('Save drafts and update', '保存草稿并更新') : tr('Save drafts and reload workspace', '保存草稿并刷新工作区')}</button></div>
            <details><summary>{tr('Version and source licenses', '版本与源代码许可')}</summary>
                <p>HAPI DSH {HAPI_DSH_VERSION} · DSH {DSH_VERSION}<br/>{HAPI_DSH_BUILD_ID.slice(0, 16)}</p>
                <p>{tr('HAPI-derived code is AGPL-3.0-only. Official DSH dependencies remain unmodified and MIT licensed.', 'HAPI 衍生代码采用 AGPL-3.0-only；官方 DSH 依赖保持原样，采用 MIT 许可。')}</p>
                <p><a href="https://github.com/dqtz5vpvj9-create/hapi-dsh" target="_blank" rel="noreferrer">{tr('Source and notices', '源代码与许可声明')}</a> · <a href={`https://github.com/dqtz5vpvj9-create/hapi/tree/${HAPI_SOURCE_REVISION}`} target="_blank" rel="noreferrer">{tr('Original HAPI baseline', '原 HAPI 基线')}</a></p>
            </details>
            <p><small>{state.connected ? tr('Original Hub notification stream connected.', '原 Hub 通知连接正常。') : tr('Reconnecting the original Hub notification stream. Source Push remains independent of this page.', '正在重连原 Hub 通知流；源 Push 投递不依赖此页面。')}</small></p>
        </section>;
    }
    // Only real source notifications float above the workspace. Installation and
    // update offers live in Settings so a normal reading/file view is never
    // covered; the saving dialog appears only after the user starts an update.
    function Overlay(_props: PropsRuntime<'shell.overlay'>) {
        const state = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot), tr = useWords();
        const saving = useRef<HTMLDialogElement>(null);
        useEffect(() => { if (state.updating) saving.current?.showModal(); else saving.current?.close(); }, [state.updating]);
        const notices = state.notices.slice(-5);
        if (!state.updating && !notices.length) return null;
        return <div className="hapi-notification-stack" aria-label={tr('Source notifications', '源会话通知')}>
            <dialog ref={saving} className="hapi-update-dialog" aria-label={tr('Saving workspace drafts', '保存工作区草稿')} onCancel={event => event.preventDefault()}>
                <p role="status">{tr('Saving open editors and original attachment bytes before updating…', '正在保存已打开的编辑器和附件原始内容，随后更新…')}</p>
            </dialog>
            {notices.map(notice => <article key={notice.id} role="status"><div><strong>{notice.title}</strong><p>{notice.body}</p>
                <button type="button" onClick={() => { void runtime.open(notice).then(() => runtime.dismiss(notice.id)).catch(() => {}); }}>{tr('Open conversation', '打开会话')}</button></div>
                <button type="button" className="hapi-notification-dismiss" aria-label={tr('Dismiss notification', '关闭通知')} onClick={() => runtime.dismiss(notice.id)}>×</button></article>)}
        </div>;
    }
    disposers.push(ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'hapi-notifications', order: 35,
        label: () => language().startsWith('zh') ? '通知与安装' : 'Notifications and installation' }, Settings)));
    disposers.push(ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'hapi-source-notifications', order: 35 }, Overlay)));
    const style = document.createElement('style'); style.textContent = styles; document.head.append(style); disposers.push(() => style.remove());
    void runtime.start();
    return () => { runtime.close(); for (const dispose of disposers.reverse()) dispose(); };
}

const styles = `
.hapi-notification-settings,.hapi-notification-stack,.hapi-update-dialog{font:400 14px/1.5 var(--dsw-font-family,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif)}
.hapi-update-dialog{position:fixed;inset:0;margin:auto;max-width:min(420px,calc(100vw - 32px));border:1px solid var(--border-secondary,#8886);border-radius:12px;padding:24px;background:var(--bg-primary,Canvas);color:var(--text-primary,CanvasText);pointer-events:auto}.hapi-update-dialog::backdrop{background:#0008}
.hapi-notification-settings{font-size:14px;line-height:1.5;color:inherit}.hapi-notification-settings h2{font-size:18px;margin:0 0 16px}.hapi-notification-settings h3{font-size:15px;margin:22px 0 8px}.hapi-notification-settings p{max-width:64ch}.hapi-notification-settings label{display:flex;align-items:center;gap:8px}.hapi-notification-actions{display:flex;flex-wrap:wrap;gap:8px}.hapi-notification-settings button,.hapi-notification-stack button{font:inherit;border:1px solid var(--border-secondary,#8885);background:var(--bg-secondary,Canvas);color:inherit;border-radius:6px;padding:6px 10px;cursor:pointer}.hapi-notification-settings button:disabled{opacity:.5;cursor:default}.hapi-notification-error{color:var(--text-error,#d45d62);overflow-wrap:anywhere}.hapi-notification-stack{position:fixed;right:16px;bottom:40px;display:grid;gap:8px;max-width:min(390px,calc(100vw - 32px));max-height:60dvh;overflow:auto;pointer-events:none;z-index:70}.hapi-notification-stack article{pointer-events:auto;display:flex;gap:12px;padding:14px;border:1px solid var(--border-secondary,#8886);border-radius:12px;background:var(--bg-primary,Canvas);color:var(--text-primary,CanvasText);box-shadow:0 4px 24px #0003;font-size:13px}.hapi-notification-stack p{margin:6px 0;white-space:pre-wrap;overflow-wrap:anywhere;max-height:160px;overflow:auto}.hapi-notification-dismiss{align-self:start;border:0!important;background:transparent!important;padding:0 3px!important;font-size:20px!important}
`;
