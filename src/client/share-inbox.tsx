import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type { WorkspaceCatalogRow, WorkspaceController } from './controller.ts';
import { parseSessionResourceId, sessionLocation } from './controller.ts';
import { isSourceChild, sourceIdentity } from '../workspace/legacy.ts';
import { sessionFolder } from '../workspace/presentation.ts';
import { parseShareFields, shareFromFragment, shareSeedText, type ShareTarget } from './share-transfer.ts';
import type {} from './workspace-ui.ts';

function targetFor(row: WorkspaceCatalogRow): ShareTarget {
    const source = sourceIdentity(row);
    return source?.hubId ? { kind: 'hapi', hubId: source.hubId, sessionId: source.sessionId }
        : { kind: 'dsh', hostId: row.hostId, sessionId: row.sourceSessionId };
}

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
    const created = controller.subscribeCreated(id => {
        if (inbox.getSnapshot().phase !== 'creating') return;
        const row = controller.getSnapshot().catalog.byId[id], source = parseSessionResourceId(id);
        inbox.created(row ? targetFor(row) : { kind: 'dsh', hostId: source.hostId, sessionId: source.sessionId });
    });
    const watchCreation = controller.subscribe(() => {
        if (!controller.getSnapshot().creation && inbox.getSnapshot().phase === 'creating') inbox.cancelCreation();
    });
    const ShareDialog = () => {
        const state = useSyncExternalStore(inbox.subscribe, inbox.getSnapshot), snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
        const lang = useSyncExternalStore(listener => ctx.locale.subscribe(listener), language), tr = (en: string, zh: string) => lang.startsWith('zh') ? zh : en;
        const dialog = useRef<HTMLDialogElement>(null), [query, setQuery] = useState('');
        const rows = useMemo(() => Object.values(snapshot.catalog.byId).filter(row => !isSourceChild(row))
            .filter(row => `${row.displayTitle} ${row.hostLabel} ${sessionLocation(row).machineName ?? ''} ${sessionFolder(row).path}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
            .sort((a, b) => a.displayTitle.localeCompare(b.displayTitle)), [snapshot.catalog, query]);
        useEffect(() => { if (state.opened) dialog.current?.showModal(); else dialog.current?.close(); }, [state.opened]);
        const record = state.record, busy = state.phase === 'inserting' || state.phase === 'loading', delivered = record?.hapiDshDelivery;
        return <dialog ref={dialog} className="hapi-incoming-share-dialog" aria-label={tr('Incoming share', '接收分享')} onCancel={event => { event.preventDefault(); inbox.hide(); }}>
            <header><h2>{tr('Incoming share', '接收分享')}</h2><button type="button" aria-label={tr('Close incoming share', '关闭分享')} onClick={inbox.hide}>×</button></header>
            <p>{tr('Choose a conversation in this workspace. Shared content is added to its draft for review before sending.', '选择工作区中的会话。分享内容会加入草稿，检查后再发送。')}</p>
            {state.error && <p role="alert" className="hapi-error">{state.error}</p>}
            {busy && <p role="status">{tr('Preparing shared content…', '正在准备分享内容…')}</p>}
            {record && <>
                <pre className="hapi-incoming-share-preview">{shareSeedText(record)}</pre>
                {record.files.length > 0 && <ul>{record.files.map((file, index) => <li key={index}>{file.name} · {Math.ceil(file.blob.size / 1024)} KiB
                    <button type="button" onClick={() => { const url = URL.createObjectURL(file.blob), anchor = document.createElement('a'); anchor.href = url; anchor.download = file.name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 30_000); }}>{tr('Save original file', '保存原始文件')}</button></li>)}</ul>}
                {delivered && <p>{state.phase === 'inserted' ? tr('This content has been inserted. Its original files remain available here for one hour. Inserting again can duplicate the draft.', '这些内容已插入草稿，原始文件在此保留一小时。再次插入可能产生重复内容。')
                    : tr('The hand-off is bound to the selected conversation. If an earlier insertion was interrupted, check that draft before retrying.', '分享已经绑定所选会话。如果之前的插入中断，请先检查草稿，再决定是否重试。')}</p>}
                <label>{tr('Find conversation', '查找会话')}<input type="search" value={query} onChange={event => setQuery(event.currentTarget.value)} disabled={busy}/></label>
                <div className="hapi-share-destinations">{rows.map(row => <button type="button" key={row.id} disabled={busy || !row.hostOnline} onClick={() => {
                    if (delivered && delivered.status !== 'ready' && !window.confirm(tr('Insert this share again? Review the target draft first to avoid duplicate text or files.', '再次插入这份分享？请先检查目标草稿，避免重复文字或文件。'))) return;
                    controller.openSession(row.id); void inbox.select(targetFor(row), Boolean(delivered));
                }}><strong>{row.displayTitle}</strong><small>{row.hostLabel} · {sessionLocation(row).machineName ?? sessionLocation(row).machineId ?? ''} · {sessionFolder(row).path}</small></button>)}</div>
                {!rows.length && <p>{tr('No matching conversation. Create one or change the search.', '未找到匹配会话，可新建会话或修改搜索。')}</p>}
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
    const style = document.createElement('style'); style.textContent = styles; document.head.append(style);
    return () => { lifetime.abort(); created(); watchCreation(); overlay(); shortcut(); style.remove(); };
}
const styles = `.hapi-incoming-share-dialog{width:min(660px,calc(100vw - 24px));max-height:calc(100dvh - 32px);overflow:auto;box-sizing:border-box;padding:20px;border:1px solid var(--border-secondary,#8886);border-radius:12px;background:var(--bg-primary,Canvas);color:var(--text-primary,CanvasText);font-size:14px}.hapi-incoming-share-dialog::backdrop{background:#0007}.hapi-incoming-share-dialog header{display:flex;align-items:center;justify-content:space-between;gap:12px}.hapi-incoming-share-dialog h2{font-size:18px;margin:0}.hapi-incoming-share-dialog p{line-height:1.6}.hapi-incoming-share-preview{max-height:25vh;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;background:var(--bg-secondary,#8881);padding:12px;border-radius:8px}.hapi-incoming-share-dialog label{display:flex;flex-direction:column;gap:6px}.hapi-incoming-share-dialog input{box-sizing:border-box;width:100%;padding:8px;border:1px solid var(--border-secondary,#8885);border-radius:6px;background:var(--bg-input,transparent);color:inherit}.hapi-incoming-share-dialog button,.hapi-incoming-share-status button{font:inherit;border:1px solid var(--border-secondary,#8885);border-radius:6px;background:var(--bg-secondary,transparent);color:inherit;cursor:pointer;padding:5px 9px}.hapi-incoming-share-dialog button:disabled{opacity:.5;cursor:default}.hapi-share-destinations{display:grid;gap:6px;max-height:35vh;overflow:auto;margin:12px 0}.hapi-share-destinations button{display:grid;gap:4px;text-align:start}.hapi-share-destinations small{color:var(--text-secondary,#888);overflow-wrap:anywhere}.hapi-incoming-share-dialog footer,.hapi-incoming-share-dialog li{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:10px 0}.hapi-incoming-share-status{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;padding:6px;color:var(--text-secondary,#888)}.hapi-incoming-share-dialog .hapi-error{color:var(--text-error,#d45d62);overflow-wrap:anywhere}`;
