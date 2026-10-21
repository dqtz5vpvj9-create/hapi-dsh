import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type { WorkspaceController } from './controller.ts';
import { parseSessionResourceId } from './controller.ts';
import { parseShareFields, shareFromFragment } from './share-transfer.ts';
import { resolveShareCandidate, shareTargetForRow, type SharePickerCandidate } from '../workspace/share-picker.ts';
import { SharePayloadPreview, ShareTargetPicker, sharePickerStyles } from './share-picker.tsx';
import type {} from './workspace-ui.ts';

/** Root-only picker. It never posts a chat or chooses a target from whichever pane mounts first. */
export function installShareInbox(ctx: Context, controller: WorkspaceController): () => void {
    const scope = ctx.inject(['hapiWorkspaceUi'], owner => installRootShareInbox(owner, controller));
    return () => { void scope.dispose(); };
}

function installRootShareInbox(ctx: Context, controller: WorkspaceController): () => void {
    const inbox = ctx.hapiWorkspaceUi.shareInbox, lifetime = new AbortController();
    const language = () => ctx.locale.getSnapshot().active;
    const address = (id?: string) => {
        const url = new URL(location.href); url.hash = ''; url.searchParams.delete('hapiShareError');
        if (id) url.searchParams.set('hapiShare', id); else url.searchParams.delete('hapiShare');
        history.replaceState(history.state, '', url);
    };
    const start = async () => {
        const url = new URL(location.href), id = url.searchParams.get('hapiShare');
        if (url.searchParams.has('hapiShareError')) { inbox.report(new Error('The browser could not save the shared content. Share it again after opening this workspace.')); return; }
        if (!id) return;
        let fields = {};
        try { if (id === 'incoming') fields = parseShareFields(url.hash); }
        finally { address(id === 'incoming' ? undefined : id); }
        if (id !== 'incoming') { await inbox.load(id); return; }
        const timed = AbortSignal.any([lifetime.signal, AbortSignal.timeout(30_000)]);
        const transfer = await shareFromFragment(fields, timed); const stored = await inbox.ingest(transfer); address(stored);
    };
    void start().catch(inbox.report);
    let awaitingCreatedIdentity: string | null = null;
    const created = controller.subscribeCreated(id => {
        if (inbox.getSnapshot().phase !== 'creating') return;
        const row = controller.getSnapshot().catalog.byId[id], source = parseSessionResourceId(id);
        const target = row ? shareTargetForRow(row) : /^(?:hapi-codex-|hapi-observed-)/u.test(source.sessionId) ? null
            : { kind: 'dsh' as const, hostId: source.hostId, sessionId: source.sessionId };
        if (target) { awaitingCreatedIdentity = null; inbox.created(target); }
        else awaitingCreatedIdentity = id;
    });
    const watchCreation = controller.subscribe(() => {
        if (inbox.getSnapshot().phase !== 'creating') { awaitingCreatedIdentity = null; return; }
        if (awaitingCreatedIdentity) {
            const row = controller.getSnapshot().catalog.byId[awaitingCreatedIdentity], target = row && shareTargetForRow(row);
            if (target) { awaitingCreatedIdentity = null; inbox.created(target); }
        } else if (!controller.getSnapshot().creation) inbox.cancelCreation();
    });
    const ShareDialog = () => {
        const state = useSyncExternalStore(inbox.subscribe, inbox.getSnapshot);
        const lang = useSyncExternalStore(listener => ctx.locale.subscribe(listener), language), tr = (en: string, zh: string) => lang.startsWith('zh') ? zh : en;
        const dialog = useRef<HTMLDialogElement>(null);
        useEffect(() => { if (state.opened) dialog.current?.showModal(); else dialog.current?.close(); }, [state.opened]);
        const record = state.record, busy = state.phase === 'inserting' || state.phase === 'loading', delivered = record?.hapiDshDelivery;
        const select = (candidate: SharePickerCandidate): void => {
            if (delivered && delivered.status !== 'ready' && !window.confirm(tr('Insert this share again? Review the target draft first to avoid duplicate text or files.', '再次插入这份分享？请先检查目标草稿，避免重复文字或文件。'))) return;
            // Confirmation can remain open across an SSE update. Recheck the
            // exact source after it closes, without choosing a similar row.
            const target = resolveShareCandidate(candidate, controller.getSnapshot().catalog);
            if (target.status !== 'ready') { inbox.report(new Error(tr('The chosen source is no longer available under this identity. Refresh the conversation snapshot and choose again.', '所选源会话当前无法按原身份访问，请刷新会话快照后重新选择。'))); return; }
            controller.openSession(target.row.id); void inbox.select(target.target, Boolean(delivered));
        };
        return <dialog ref={dialog} className="hapi-incoming-share-dialog" aria-label={tr('Incoming share', '接收分享')} onCancel={event => { event.preventDefault(); inbox.hide(); }}>
            <header><h2>{tr('Incoming share', '接收分享')}</h2><button type="button" aria-label={tr('Close incoming share', '关闭分享')} onClick={inbox.hide}>×</button></header>
            <p>{tr('Choose a conversation in this workspace. Shared content is added to its draft for review before sending.', '选择工作区中的会话。分享内容会加入草稿，检查后再发送。')}</p>
            {state.error && <p role="alert" className="hapi-error">{state.error}</p>}
            {busy && <p role="status">{tr('Preparing shared content…', '正在准备分享内容…')}</p>}
            {record && <>
                <SharePayloadPreview key={record.id} record={record} language={lang}/>
                {delivered && <p>{state.phase === 'inserted' ? tr('This content has been inserted. Its original files remain available here for one hour. Inserting again can duplicate the draft.', '这些内容已插入草稿，原始文件在此保留一小时。再次插入可能产生重复内容。')
                    : tr('The hand-off is bound to the selected conversation. If an earlier insertion was interrupted, check that draft before retrying.', '分享已经绑定所选会话。如果之前的插入中断，请先检查草稿，再决定是否重试。')}</p>}
                <ShareTargetPicker key={record.id} controller={controller} busy={busy} language={lang} t={ctx.locale.bind('hapiWorkspace')} onSelect={select}/>
                <footer><button type="button" disabled={busy || Boolean(delivered)} onClick={() => { if (inbox.beginCreation()) controller.requestNewSession(); }}>{tr('Create a conversation for this share', '为这份分享新建会话')}</button>
                    <button type="button" disabled={busy} onClick={() => { if (window.confirm(tr('Discard the saved original share? Existing conversation drafts are kept.', '删除保存的原始分享内容？已有会话草稿会保留。'))) void inbox.discard().then(() => { if (!inbox.getSnapshot().record) address(); }); }}>{tr('Discard saved share', '删除保存的分享')}</button></footer>
            </>}
        </dialog>;
    };
    const Shortcut = () => {
        const state = useSyncExternalStore(inbox.subscribe, inbox.getSnapshot), lang = useSyncExternalStore(listener => ctx.locale.subscribe(listener), language);
        return state.record || state.error ? <button type="button" className="hapi-incoming-share-open" onClick={inbox.show} title={lang.startsWith('zh') ? '检查接收的分享' : 'Review incoming share'}>{lang.startsWith('zh') ? '分享' : 'Share'}</button> : null;
    };
    const overlay = ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'hapi.share-inbox', order: 40 }, ShareDialog));
    const shortcut = ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: 'hapi.share-inbox', order: 40 }, Shortcut));
    const style = document.createElement('style'); style.textContent = styles + sharePickerStyles; document.head.append(style);
    return () => { lifetime.abort(); created(); watchCreation(); overlay(); shortcut(); style.remove(); };
}
const styles = `
.hapi-incoming-share-dialog{width:min(660px,calc(100vw - 24px));max-height:calc(100dvh - 32px);overflow:auto;box-sizing:border-box;padding:20px;border:1px solid var(--hapi-border);border-radius:12px;background:var(--hapi-bg);color:var(--hapi-fg);font-size:14px}
.hapi-incoming-share-dialog::backdrop{background:#0007}
.hapi-incoming-share-dialog>header{display:flex;align-items:center;justify-content:space-between;gap:12px}
.hapi-incoming-share-dialog h2{font-size:18px;margin:0}.hapi-incoming-share-dialog p{line-height:1.6}
.hapi-incoming-share-preview{max-height:25vh;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;background:var(--hapi-muted);padding:12px;border-radius:8px}
:where(.hapi-incoming-share-dialog) label{display:flex;flex-direction:column;gap:6px}
:where(.hapi-incoming-share-dialog) input{box-sizing:border-box;width:100%;padding:8px;border:1px solid var(--hapi-border);border-radius:6px;background:var(--hapi-bg);color:inherit}
:where(.hapi-incoming-share-dialog) button,.hapi-incoming-share-status button{font:inherit;border:1px solid var(--hapi-border,var(--dsw-alias-border-l2,#8885));border-radius:6px;background:var(--hapi-muted,var(--dsw-alias-bg-layer-2,transparent));color:inherit;cursor:pointer;padding:5px 9px}
.hapi-incoming-share-dialog button:disabled{opacity:.5;cursor:default}
.hapi-share-destinations{display:grid;gap:6px;max-height:35vh;overflow:auto;margin:12px 0}.hapi-share-destinations button{display:grid;gap:4px;text-align:start}
.hapi-share-destinations small{color:var(--hapi-secondary);overflow-wrap:anywhere}
.hapi-incoming-share-dialog>footer,.hapi-incoming-share-dialog li{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:10px 0}
.hapi-incoming-share-status{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;padding:6px;color:var(--dsw-alias-label-secondary,#888)}
.hapi-incoming-share-dialog .hapi-error{color:var(--dsw-alias-state-error-primary,#d45d62);overflow-wrap:anywhere}
`;
