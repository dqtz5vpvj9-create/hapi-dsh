import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { AssistantActionOwnerProps } from '@deepseek-ai/dsh-client-ui-chat/client';
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client';
import html2canvas from 'html2canvas-pro';
import { captureShareTurn, type TurnShareSnapshot } from './turn-share-dom.ts';
import { loadShareTurn, shareImageScale, shareTurnOf } from './turn-share-model.ts';

type ActionProps = PropsRuntime<'conversation.chat.assistant-actions'> & AssistantActionOwnerProps;
type Metadata = { id: string; name: string; value: string };
const errorText = (value: unknown) => value instanceof Error ? value.message : String(value);
const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));

function ShareDialog({ ctx, binding, surface, messageId, metadata, language, close }: {
    ctx: Context; binding: SessionBinding; surface: HTMLElement; messageId: string; metadata: Metadata[]; language: string; close(): void;
}) {
    const tr = (en: string, zh: string) => language.startsWith('zh') ? zh : en;
    const dialog = useRef<HTMLDialogElement>(null), preview = useRef<HTMLDivElement>(null);
    const [snapshot, setSnapshot] = useState<TurnShareSnapshot | null>(null), [error, setError] = useState<string | null>(null);
    const [width, setWidth] = useState(960), [wrap, setWrap] = useState(true), [busy, setBusy] = useState(false);
    const [chosen, setChosen] = useState(() => new Set(['title']));
    const [status, setStatus] = useState('');
    const lifetime = useRef<AbortController>();
    const revision = useRef(0), gate = useRef(false);
    useEffect(() => {
        const node = dialog.current; node?.showModal(); return () => { node?.close(); };
    }, []);
    useEffect(() => {
        const abort = new AbortController(); lifetime.current = abort;
        const timeout = setTimeout(() => abort.abort(new Error(tr('Preparing this turn timed out. Reopen Share to retry.', '准备回合超时，请重新打开分享后重试。'))), 30_000);
        const current = () => ctx.sessions.binding(binding.sessionId) === binding && surface.isConnected;
        void (async () => {
            const turn = await loadShareTurn({ binding, conversation: ctx.uiConversation.binding(binding), messageId, current, signal: abort.signal });
            await frame(); await frame(); abort.signal.throwIfAborted();
            if (!current()) throw new Error(tr('The original conversation has closed.', '原会话已经关闭。'));
            const result = await captureShareTurn(surface, turn, abort.signal);
            abort.signal.throwIfAborted(); setSnapshot(result);
        })().catch(failure => { if (lifetime.current === abort && !dialog.current?.hasAttribute('data-closing')) setError(errorText(failure)); })
            .finally(() => clearTimeout(timeout));
        return () => { lifetime.current = undefined; abort.abort(); clearTimeout(timeout); };
    }, [ctx, binding, surface, messageId]);
    useLayoutEffect(() => {
        const root = preview.current;
        if (!root || !snapshot) return;
        for (const [key, value] of Object.entries(snapshot.styles)) root.style.setProperty(key, value);
        revision.current++;
    }, [snapshot, width, wrap, chosen]);
    const active = () => !!lifetime.current && !lifetime.current.signal.aborted && ctx.sessions.binding(binding.sessionId) === binding;
    const render = async (): Promise<Blob> => {
        const node = preview.current, currentRevision = revision.current;
        if (!node || !snapshot || !active()) throw new Error(tr('This share preview is no longer active.', '这份分享预览已经关闭。'));
        await document.fonts.ready; await frame();
        const size = node.getBoundingClientRect(), scale = shareImageScale(Math.ceil(size.width), Math.ceil(size.height));
        const canvas = await html2canvas(node, { scale, backgroundColor: null, allowTaint: false, useCORS: true,
            logging: false, width: Math.ceil(size.width), height: Math.ceil(size.height), imageTimeout: 15_000 });
        if (!active() || revision.current !== currentRevision) throw new Error(tr('The preview changed during export. Try again with the current preview.', '导出期间预览发生了变化，请按当前预览重试。'));
        return new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('The browser could not create a PNG image.')), 'image/png'));
    };
    const run = (kind: 'save' | 'copy' | 'share') => {
        if (gate.current || !snapshot) return;
        gate.current = true; setBusy(true); setError(null); setStatus('');
        const png = render();
        // ClipboardItem receives the Promise while the click still owns the
        // browser activation. No credential or content leaves this browser.
        let operation: Promise<void>;
        try {
            operation = kind === 'copy'
                ? navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
                : png.then(async blob => {
                if (!active()) return;
                const file = new File([blob], `hapi-turn-${new Date().toISOString().replace(/[:.]/gu, '-')}.png`, { type: 'image/png' });
                if (kind === 'share') {
                    if (!navigator.canShare?.({ files: [file] })) throw new Error(tr('File sharing is unavailable in this browser. Save the PNG instead.', '当前浏览器不支持分享文件，请先保存 PNG。'));
                    await navigator.share({ files: [file], title: metadata.find(item => item.id === 'title')?.value ?? 'HAPI turn' });
                } else {
                    const url = URL.createObjectURL(blob), anchor = document.createElement('a');
                    anchor.href = url; anchor.download = file.name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 30_000);
                }
                });
        } catch (failure) {
            // Some browsers expose ClipboardItem but reject promise-backed
            // images synchronously. Consume the render result and release the
            // same UI gate as an asynchronous clipboard failure.
            void png.catch(() => {});
            operation = Promise.reject(failure);
        }
        void operation.then(() => { if (active()) setStatus(tr('Image ready.', '图片已准备完成。')); }, failure => {
            if (active() && !(failure instanceof DOMException && failure.name === 'AbortError')) setError(errorText(failure));
        }).finally(() => { gate.current = false; if (active()) setBusy(false); });
    };
    return <dialog ref={dialog} data-hapi-share-dialog className="hapi-turn-share-dialog" aria-label={tr('Share this turn', '分享当前回合')}
        onCancel={event => { event.preventDefault(); close(); }}>
        <header><h2>{tr('Share this turn', '分享当前回合')}</h2><button type="button" aria-label={tr('Close share preview', '关闭分享预览')} onClick={close}>×</button></header>
        <p>{tr('The preview uses the official conversation, including the current tool disclosure state. Reasoning, other turns and unsent drafts are excluded.', '预览复用官方会话显示，并保留当前工具展开状态。推理内容、其他回合和未发送的草稿不会包含在内。')}</p>
        <fieldset disabled={busy}><legend>{tr('Include in image', '图片中包含')}</legend>
            {metadata.map(item => <label key={item.id}><input type="checkbox" checked={chosen.has(item.id)} onChange={event => {
                const next = new Set(chosen); if (event.currentTarget.checked) next.add(item.id); else next.delete(item.id); setChosen(next);
            }}/>{item.name}</label>)}
        </fieldset>
        <div className="hapi-turn-share-controls"><label>{tr('Image width', '图片宽度')} <select aria-label={tr('Image width', '图片宽度')} value={width} disabled={busy} onChange={event => setWidth(Number(event.currentTarget.value))}>
            {[720, 960, 1200].map(value => <option key={value} value={value}>{value} px</option>)}</select></label>
            <label><input type="checkbox" disabled={busy} checked={wrap} onChange={event => setWrap(event.currentTarget.checked)}/>{tr('Wrap code lines', '代码自动换行')}</label></div>
        {!snapshot && !error && <p role="status">{tr('Loading the complete turn and its images…', '正在加载完整回合及图片…')}</p>}
        {error && <p role="alert" className="hapi-error">{error}</p>}
        {snapshot && <div className="hapi-turn-share-scroll" data-hapi-share-preview>
            <div ref={preview} className={`hapi-turn-share-image${wrap ? ' hapi-share-wrap' : ''}`} style={{ width }}>
                {chosen.size > 0 && <div className="hapi-turn-share-metadata">{metadata.filter(item => chosen.has(item.id)).map(item => <div key={item.id}>
                    <span>{item.name}</span><strong>{item.value}</strong></div>)}</div>}
                <div className="hapi-turn-share-content" dangerouslySetInnerHTML={{ __html: snapshot.html }}/>
            </div>
        </div>}
        <footer><button type="button" disabled={!snapshot || busy} onClick={() => run('save')}>{busy ? tr('Preparing image…', '正在生成图片…') : tr('Save PNG', '保存 PNG')}</button>
            {typeof ClipboardItem !== 'undefined' && !!navigator.clipboard?.write && <button type="button" disabled={!snapshot || busy} onClick={() => run('copy')}>{tr('Copy image', '复制图片')}</button>}
            {typeof navigator.share === 'function' && <button type="button" disabled={!snapshot || busy} onClick={() => run('share')}>{tr('Share image…', '分享图片…')}</button>}
            {status && <output>{status}</output>}
        </footer>
    </dialog>;
}

/** A completed-message action compatible with the unchanged official Chat. */
export function installTurnSharing(ctx: Context): () => void {
    const Action = (props: ActionProps) => {
        const language = useSyncExternalStore(listener => ctx.locale.subscribe(listener), () => ctx.locale.getSnapshot().active);
        const tr = (en: string, zh: string) => language.startsWith('zh') ? zh : en;
        const native = props.useProjection('hapi'), observed = props.useProjection('hapiObserved'), source = native ?? observed;
        const title = props.useSessions(value => value.byId[props.sessionId]?.displayTitle ?? props.sessionId);
        const turn = props.useChat(value => shareTurnOf(value, props.messageId));
        const [opened, setOpened] = useState<{ binding: SessionBinding; surface: HTMLElement; metadata: Metadata[] } | null>(null);
        if (turn?.status !== 'closed' || !turn.end) return null;
        const open = (button: HTMLButtonElement) => {
            const binding = ctx.sessions.binding(props.sessionId), surface = button.closest<HTMLElement>('[data-pane-id]') ?? button.closest<HTMLElement>('.hapi-host-frame');
            if (!binding || !surface) return;
            const metadata: Metadata[] = [{ id: 'title', name: tr('Title', '标题'), value: title }];
            if (source?.machineName) metadata.push({ id: 'machine', name: tr('Machine', '机器'), value: source.machineName });
            if (source?.model) metadata.push({ id: 'model', name: tr('Model', '模型'), value: source.model });
            if (turn.start?.time) metadata.push({ id: 'time', name: tr('Time', '时间'), value: new Date(turn.start.time).toLocaleString() });
            setOpened({ binding, surface, metadata });
        };
        return <><button type="button" className="hapi-turn-share-action" data-hapi-share-exclude aria-label={tr('Share this turn', '分享当前回合')} title={tr('Share this turn', '分享当前回合')} onClick={event => open(event.currentTarget)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M12 15V3m-4 4 4-4 4 4M5 11v9h14v-9"/></svg>
        </button>{opened && <ShareDialog {...opened} ctx={ctx} messageId={props.messageId} language={language} close={() => setOpened(null)}/>}</>;
    };
    const style = document.createElement('style'); style.textContent = styles; document.head.append(style);
    const stop = ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({ name: 'conversation.chat.assistant-actions', id: 'hapi.share-turn', order: 60 }, Action));
    return () => { stop(); style.remove(); };
}

const styles = `
.hapi-turn-share-action{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:0;border-radius:5px;background:transparent;color:var(--text-secondary,#888);cursor:pointer}.hapi-turn-share-action:hover{background:var(--bg-hover,#8882)}
.hapi-turn-share-dialog{border:1px solid var(--border-secondary,#8885);border-radius:12px;background:var(--bg-primary,#fff);color:var(--text-primary,#222);padding:16px;width:min(1100px,calc(100vw - 32px));max-height:calc(100dvh - 32px);overflow:auto;box-sizing:border-box;font-size:13px}.hapi-turn-share-dialog::backdrop{background:#0007}.hapi-turn-share-dialog>header{display:flex;justify-content:space-between;align-items:center;gap:12px}.hapi-turn-share-dialog h2{font-size:18px;margin:0}.hapi-turn-share-dialog p{white-space:normal;color:var(--text-secondary,#777);line-height:1.6}.hapi-turn-share-dialog button,.hapi-turn-share-dialog select{border:1px solid var(--border-secondary,#8885);border-radius:6px;background:var(--bg-secondary,transparent);color:inherit;padding:5px 10px;font:inherit;cursor:pointer}.hapi-turn-share-dialog button:disabled{opacity:.5;cursor:default}.hapi-turn-share-dialog fieldset{display:flex;flex-wrap:wrap;gap:10px;border:1px solid var(--border-secondary,#8885);border-radius:6px;margin:10px 0}.hapi-turn-share-dialog label{display:inline-flex;align-items:center;gap:5px}.hapi-turn-share-controls,.hapi-turn-share-dialog footer{display:flex;align-items:center;flex-wrap:wrap;gap:10px;margin:10px 0}.hapi-turn-share-scroll{max-height:58vh;overflow:auto;border:1px solid var(--border-secondary,#8885);border-radius:7px;background:var(--bg-secondary,#eee)}
.hapi-turn-share-image{box-sizing:border-box;padding:32px 40px;background:var(--bg-primary,#fff);color:var(--text-primary,#222);flex:none;max-width:none;min-height:60px}.hapi-turn-share-metadata{padding-bottom:16px;margin-bottom:18px;border-bottom:1px solid var(--border-secondary,#8885);display:grid;gap:5px}.hapi-turn-share-metadata>div{display:flex;gap:12px;align-items:baseline;overflow-wrap:anywhere}.hapi-turn-share-metadata span{color:var(--text-secondary,#777);font-size:12px}.hapi-turn-share-metadata strong{font-weight:500;font-size:14px}.hapi-turn-share-content{display:flex;flex-direction:column;gap:16px;min-width:0}.hapi-turn-share-content>*{flex:none}.hapi-turn-share-content img{max-width:100%;object-fit:contain}.hapi-turn-share-content [data-turn-process-hidden=true]{display:none!important}.hapi-share-wrap pre,.hapi-share-wrap code{white-space:pre-wrap!important;overflow-wrap:anywhere!important;word-break:break-word!important;max-width:100%}.hapi-share-wrap [data-code-cell]{white-space:pre-wrap!important;overflow-wrap:anywhere!important}.hapi-turn-share-dialog .hapi-error{color:var(--text-error,#c55)}
`;
