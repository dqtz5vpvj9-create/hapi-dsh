import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-ui-settings/client';
import type {} from '@deepseek-ai/dsh-client-connection/client';
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import QRCode from 'qrcode';
import type { SourceCompanionApi } from '../source-companion-types.ts';
import { SourceCompanionController, type CompanionDisplayError } from './source-companion-state.ts';

const words = (language: string) => (en: string, zh: string) => language.startsWith('zh') ? zh : en;
function errorMessage(error: CompanionDisplayError, tr: ReturnType<typeof words>): string {
    switch (error) {
        case 'owner-required': return tr('Only the authenticated Host owner can reveal the original Hub credential.', '只有已认证的 Host 所有者可以显示原 Hub 凭据。');
        case 'source-changed': return tr('The selected Hub or its endpoint changed. Refresh its details before revealing again.', '所选 Hub 或地址已变化，请刷新信息后重新显示。');
        case 'credential-unavailable': return tr('The original Hub credential is unavailable. Check the private Host configuration.', '原 Hub 凭据不可用，请检查 Host 的私有配置。');
        case 'endpoint-unavailable': return tr('Configure a reachable HTTPS origin for this original HAPI Hub first.', '请先为这个原 HAPI Hub 配置手机可达的 HTTPS origin。');
        case 'invalid-response': return tr('The response did not match the selected Hub. No pairing link was displayed.', '响应与所选 Hub 不匹配，未显示配对链接。');
        case 'copy-failed': return tr('Clipboard access is unavailable. Select and copy the visible link manually.', '无法访问剪贴板，请选择下方链接手动复制。');
        case 'read-failed': return tr('Could not read the original Hub pairing details. Refresh to try again.', '无法读取原 Hub 配对信息，请刷新重试。');
        case 'reveal-failed': return tr('Could not reveal the pairing link. No link is kept in this view; try again when connected.', '无法显示配对链接。此页面未保留链接，可在连接恢复后重试。');
    }
}

/** Uses the same local QR encoder as the original HAPI web app; no QR service receives the link. */
export function renderCompanionQr(link: string): Promise<string> {
    return QRCode.toDataURL(link, { type: 'image/png', errorCorrectionLevel: 'M', margin: 2, scale: 6,
        color: { dark: '#000000', light: '#ffffff' } });
}

export function SourceCompanionPanel({ api, language = 'en', observe }: {
    api: SourceCompanionApi;
    language?: string | undefined;
    observe?: ((controller: SourceCompanionController) => () => void) | undefined;
}) {
    const tr = words(language), controller = useMemo(() => new SourceCompanionController(api, renderCompanionQr), [api]);
    const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
    useEffect(() => {
        const unobserve = observe?.(controller);
        void controller.start();
        const conceal = () => {
            const phase = controller.getSnapshot().phase;
            if (phase === 'revealed' || phase === 'revealing') controller.hide();
        };
        const visibility = () => { if (document.visibilityState === 'hidden') conceal(); };
        document.addEventListener('visibilitychange', visibility);
        window.addEventListener('pagehide', conceal);
        return () => {
            document.removeEventListener('visibilitychange', visibility);
            window.removeEventListener('pagehide', conceal);
            unobserve?.();
            controller.dispose();
        };
    }, [controller, observe]);
    const info = state.info, revealed = state.phase === 'revealed', revealing = state.phase === 'revealing';
    return <section className="hapi-companion" aria-label={tr('HAPI Companion pairing', 'HAPI Companion 配对')}>
        <h2>{tr('Companion pairing', 'Companion 配对')}</h2>
        <p>{tr('Connect the HAPI iOS or Android app directly to your original HAPI Hub. Scan its pairing QR or copy the link to your trusted device.', '将 HAPI iOS 或 Android 应用直接连接到原 HAPI Hub。使用受信任的设备扫描二维码或接收配对链接。')}</p>
        <p className="hapi-companion-access">{tr('The pairing link contains the original Hub access token and retains its namespace. Anyone who receives it can sign in with that Hub credential. Keep it private.', '配对链接包含原 Hub 访问 token，并保留原命名空间。收到链接的人可以使用该 Hub 凭据登录，请妥善保管。')}</p>
        {state.error && <p role="alert" className="hapi-companion-error">{errorMessage(state.error, tr)}</p>}
        {state.phase === 'loading' && <p role="status">{tr('Reading original Hub details…', '正在读取原 Hub 信息…')}</p>}
        {info && <>
            <dl><div><dt>{tr('Source Hub', '源 Hub')}</dt><dd>{info.hubId}</dd></div>
                <div><dt>{tr('Source connection', '源连接')}</dt><dd><code>{info.sourceUrl}</code></dd></div>
                {info.endpoint && <div><dt>{tr('Companion endpoint', 'Companion 地址')}</dt><dd><code>{info.endpoint.url}</code></dd></div>}</dl>
            {info.unavailableReason && <div className="hapi-companion-unavailable">
                <p>{info.unavailableReason === 'https-required'
                    ? tr('The source connection uses HTTP. Android requires HTTPS, and HTTPS is recommended for both native apps.', '源连接使用 HTTP。Android 要求 HTTPS，两种原生应用均建议使用 HTTPS。')
                    : tr('This source URL contains a path prefix. The native apps identify Hubs by origin and discard path prefixes.', '源地址含路径前缀。原生应用按 origin 识别 Hub，会丢弃路径前缀。')}</p>
                <p>{tr('Set hapi.companionUrl in the Host configuration to the reachable HTTPS origin of this same HAPI Hub. The endpoint must serve the original HAPI API.', '请在 Host 配置中将 hapi.companionUrl 设为这个 HAPI Hub 手机可达的 HTTPS origin。该地址必须提供原 HAPI API。')}</p>
            </div>}
            {info.warnings.includes('loopback-host') && <p className="hapi-companion-unavailable">{tr('This endpoint uses a loopback host. On a physical phone, localhost refers to the phone. Configure a reachable Hub address for that device.', '此地址使用回环主机。真机上的 localhost 指向手机自身，请为设备配置可达的 Hub 地址。')}</p>}
            <div className="hapi-companion-actions">
                {!revealed && !revealing && <button type="button" disabled={!info.endpoint} onClick={() => { void controller.reveal(); }}>{tr('Show pairing QR', '显示配对二维码')}</button>}
                {(revealed || revealing) && <button type="button" onClick={controller.hide}>{tr('Hide pairing link', '隐藏配对链接')}</button>}
                {revealed && <button type="button" disabled={state.copying} onClick={() => { void controller.copy(async link => {
                    if (!navigator.clipboard) throw new Error('Clipboard unavailable.');
                    await navigator.clipboard.writeText(link);
                }); }}>{state.copied ? tr('Link copied', '链接已复制') : state.copying ? tr('Copying…', '正在复制…') : tr('Copy pairing link', '复制配对链接')}</button>}
            </div>
            {revealing && <p role="status">{tr('Preparing the pairing link…', '正在准备配对链接…')}</p>}
            {revealed && state.link && <div className="hapi-companion-revealed">
                {state.qrDataUrl ? <img src={state.qrDataUrl} width={256} height={256} alt={tr('Companion pairing QR code', 'Companion 配对二维码')}/>
                    : !state.qrFailed && <p role="status">{tr('Generating the QR locally…', '正在本地生成二维码…')}</p>}
                {state.qrFailed && <p role="status">{tr('The QR could not be rendered. Copy the pairing link below instead.', '二维码无法生成，仍可复制下方配对链接。')}</p>}
                <label>{tr('Companion pairing link', 'Companion 配对链接')}<textarea readOnly spellCheck={false} autoComplete="off" rows={4} value={state.link}/></label>
                <p>{tr('Confirm the Hub in the native app. It checks the protocol, signs in and saves the credential there; this page does not report a paired device.', '请在原生应用中确认 Hub。应用会检查协议、登录并保存凭据；此页面不会报告设备已配对。')}</p>
            </div>}
        </>}
        <div className="hapi-companion-actions"><button type="button" disabled={state.phase === 'loading'} onClick={() => { void controller.refresh(); }}>{tr('Refresh pairing details', '刷新配对信息')}</button></div>
    </section>;
}

/** One owner setting on the outer workspace; no per-pane credential or pairing state. */
export function installSourceCompanion(ctx: Context, api: SourceCompanionApi): () => void {
    const readLanguage = () => ctx.locale.getSnapshot().active;
    const panels = new Set<SourceCompanionController>();
    const observe = (controller: SourceCompanionController) => { panels.add(controller); return () => { panels.delete(controller); }; };
    // Connection owns this public generation event. Invalidate secrets before
    // asynchronously re-reading source identity; never re-reveal on recovery.
    const unreset = ctx.on('connection/reset', () => { for (const panel of panels) void panel.refresh(); });
    const Section = (_props: PropsRuntime<'settings.section'>) => {
        const language = useSyncExternalStore(listener => ctx.locale.subscribe(listener), readLanguage);
        return <SourceCompanionPanel api={api} language={language} observe={observe}/>;
    };
    const style = document.createElement('style'); style.textContent = styles; document.head.append(style);
    const unregister = ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'hapi-companion', order: 36,
        label: () => words(readLanguage())('Companion', 'Companion') }, Section));
    return () => { unreset(); for (const panel of panels) panel.dispose(); panels.clear(); unregister(); style.remove(); };
}
const styles = `
.hapi-companion{font:var(--dsw-font-s-14);max-width:720px;color:var(--dsw-alias-label-primary)}.hapi-companion h2{font:var(--dsw-font-l-20);margin:0 0 14px}.hapi-companion p{line-height:1.6}.hapi-companion-access,.hapi-companion-unavailable{padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}.hapi-companion dl>div{display:grid;grid-template-columns:minmax(110px,1fr) minmax(0,3fr);gap:12px;margin:10px 0}.hapi-companion dt{color:var(--dsw-alias-label-secondary)}.hapi-companion dd{margin:0;overflow-wrap:anywhere}.hapi-companion-actions{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0}.hapi-companion button{font:inherit;padding:7px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-layer-1);color:inherit;cursor:pointer}.hapi-companion button:focus-visible,.hapi-companion textarea:focus-visible{outline:2px solid var(--dsw-alias-link);outline-offset:2px}.hapi-companion button:disabled{opacity:.5;cursor:default}.hapi-companion-revealed{display:grid;gap:12px;justify-items:center}.hapi-companion-revealed img{max-width:100%;height:auto;background:white;border-radius:8px;image-rendering:pixelated}.hapi-companion label{display:grid;gap:6px;width:100%;font-size:13px}.hapi-companion textarea{box-sizing:border-box;width:100%;resize:vertical;font:12px/1.5 ui-monospace,monospace;padding:9px;background:var(--dsw-alias-bg-layer-1);color:inherit;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;overflow-wrap:anywhere}.hapi-companion-error{color:var(--dsw-alias-state-error-primary)}
`;
