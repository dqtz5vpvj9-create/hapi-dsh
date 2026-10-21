import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import { sessionResourceId, type WorkspaceController } from './controller.ts';
import { hasHandoffContent, type HandoffAddress, type HandoffDraft, type WorkspaceDraftHandoffs } from './draft-handoff.ts';
import type {} from './workspace-ui.ts';

function waitForSource(handoffs: WorkspaceDraftHandoffs, source: HandoffAddress, signal: AbortSignal, paneId?: string): Promise<void> {
    if (handoffs.sourceAvailable(source, paneId)) return Promise.resolve();
    return new Promise((resolve, reject) => {
        let done = false;
        const finish = (error?: Error): void => {
            if (done) return; done = true; clearTimeout(timer); stop(); signal.removeEventListener('abort', abort);
            if (error) reject(error); else resolve();
        };
        const stop = handoffs.subscribe(() => { if (handoffs.sourceAvailable(source, paneId)) finish(); });
        const abort = () => finish(new Error('The workspace closed before the original composer was ready.'));
        const timer = setTimeout(() => finish(new Error('The original composer is not ready. Open it and use the confirmed operation receipt again; its draft has not been cleared.')), 15_000);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort(); else if (handoffs.sourceAvailable(source, paneId)) finish();
    });
}

/** Root-only transaction UI. The source and target are actual public input
 * endpoints; the dialog never submits, replaces a renderer, or guesses ids. */
export function installDraftHandoff(ctx: Context, controller: WorkspaceController): () => void {
    const scope = ctx.inject(['hapiWorkspaceUi'], owner => {
        const handoffs = owner.hapiWorkspaceUi.handoffs, inbox = owner.hapiWorkspaceUi.shareInbox, lifetime = new AbortController();
        const unsubscribe = controller.installSuccessorHandler(async (from, to, paneId) => {
            try {
                if (!handoffs.sourceAvailable(from, paneId)) {
                    if (paneId) controller.store.focus(paneId);
                    controller.openSession(sessionResourceId(from.hostId, from.displayId));
                    await waitForSource(handoffs, from, lifetime.signal, paneId);
                }
                await handoffs.prepare(from, to, paneId);
                // Only an untouched, same-window 'ready' share may follow this
                // backend-confirmed new original source identity.
                await inbox.retargetPending(from, to);
                controller.openSession(sessionResourceId(to.hostId, to.displayId));
            } catch (error) { handoffs.report(error); throw error; }
        });
        const Dialog = () => {
            const state = useSyncExternalStore(handoffs.subscribe, handoffs.getSnapshot);
            const language = useSyncExternalStore(listener => owner.locale.subscribe(listener), () => owner.locale.getSnapshot().active);
            const tr = (en: string, zh: string) => language.startsWith('zh') ? zh : en;
            const dialog = useRef<HTMLDialogElement>(null), record = state.record;
            useEffect(() => { if (state.opened) dialog.current?.showModal(); else dialog.current?.close(); }, [state.opened]);
            const open = (address: HandoffAddress) => { controller.openSession(sessionResourceId(address.hostId, address.displayId)); handoffs.hide(); };
            const files = (draft: HandoffDraft) => draft.files.length > 0 && <ul>{draft.files.map(({ id, file }) => <li key={id}>{file.name} · {Math.ceil(file.size / 1024)} KiB
                <button type="button" onClick={() => { const url = URL.createObjectURL(file), link = document.createElement('a'); link.href = url; link.download = file.name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 30_000); }}>{tr('Save original', '保存原件')}</button></li>)}</ul>;
            return <dialog ref={dialog} className="hapi-draft-handoff-dialog" aria-label={tr('Move draft to recovered conversation', '将草稿转入恢复的会话')}
                onCancel={event => { event.preventDefault(); if (!state.busy) handoffs.hide(); }}>
                <header><h2>{tr('Move draft to recovered conversation', '将草稿转入恢复的会话')}</h2>
                    <button type="button" disabled={state.busy} aria-label={tr('Close draft transfer', '关闭草稿转移')} onClick={handoffs.hide}>×</button></header>
                <p>{tr('The source operation returned a different original session. Review both drafts before moving content. This action never sends a message.', '源端操作返回了新的原始会话。请检查两边草稿后再转移；这一步不会发送消息。')}</p>
                {state.error && <p role="alert">{state.error}</p>}
                {record && <>
                    <section><h3>{tr('Original draft', '原草稿')}</h3><code>{record.from.sessionId}</code><pre>{record.draft.text || tr('(Attachments only)', '（仅附件）')}</pre>{files(record.draft)}
                        <button type="button" disabled={state.busy} onClick={() => open(record.from)}>{tr('Inspect original conversation', '检查原会话')}</button></section>
                    <section><h3>{tr('Target draft', '目标草稿')}</h3><code>{record.to.sessionId}</code>
                        {state.target ? <><pre>{state.target.text || tr('(Empty text)', '（文字为空）')}</pre>{files(state.target)}</>
                            : <p role="status">{tr('Waiting for the target’s official composer. Open the recovered conversation to continue.', '等待目标会话的官方输入框；打开恢复后的会话即可继续。')}</p>}
                        <button type="button" disabled={state.busy} onClick={() => open(record.to)}>{tr('Inspect recovered conversation', '检查恢复后的会话')}</button></section>
                    {record.status === 'prepared' && <button type="button" className="hapi-primary" disabled={state.busy || !state.targetReady || !state.target}
                        onClick={() => { if (state.target) void handoffs.transfer(state.target, hasHandoffContent(state.target)); }}>
                        {state.busy ? tr('Transferring…', '正在转移…') : state.target && hasHandoffContent(state.target)
                            ? tr('Append captured content to the target draft', '把捕获内容追加到目标草稿') : tr('Move captured content to the empty target', '将捕获内容转入空目标草稿')}
                    </button>}
                    {record.status === 'unknown' && <p>{tr('A previous insertion may have partially succeeded. Automatic replay is disabled. Inspect both actual composers before keeping or manually combining them.', '之前的插入可能部分成功，不会自动重放。请检查两端实际输入框，再保留或手动合并。')}</p>}
                    {record.status === 'complete' && <p role="status">{record.cleared ? tr('The target accepted the draft and the unchanged original was cleared. Nothing was sent.', '目标已接收草稿，未被改动的原草稿已清空；没有发送消息。') : tr('The target accepted the captured content. The original was retained because it changed or its live binding is unavailable.', '目标已接收捕获的内容。由于原草稿已变化或绑定不可用，原草稿继续保留。')}</p>}
                    <footer><button type="button" disabled={state.busy} onClick={() => { void handoffs.keepBoth().catch(handoffs.report); }}>
                        {record.status === 'complete' ? tr('Done', '完成') : tr('Keep both drafts; finish without copying', '保留两边草稿，结束转移')}
                    </button></footer>
                </>}
            </dialog>;
        };
        const Shortcut = () => {
            const state = useSyncExternalStore(handoffs.subscribe, handoffs.getSnapshot);
            const language = useSyncExternalStore(listener => owner.locale.subscribe(listener), () => owner.locale.getSnapshot().active);
            return state.record || state.error ? <button type="button" className="hapi-draft-handoff-open" onClick={handoffs.show}>{language.startsWith('zh') ? '草稿转移' : 'Draft transfer'}</button> : null;
        };
        const overlay = owner.slots.inject('shell.overlay', () => owner.slots.register({ name: 'shell.overlay', id: 'hapi.draft-handoff', order: 41 }, Dialog));
        const shortcut = owner.slots.inject('sidebar.footer.action', () => owner.slots.register({ name: 'sidebar.footer.action', id: 'hapi.draft-handoff', order: 41 }, Shortcut));
        const style = document.createElement('style'); style.textContent = styles; document.head.append(style);
        return () => { lifetime.abort(); unsubscribe(); overlay(); shortcut(); style.remove(); };
    });
    return () => { void scope.dispose(); };
}

const styles = `.hapi-draft-handoff-dialog{width:min(720px,calc(100vw - 24px));max-height:calc(100dvh - 32px);overflow:auto;box-sizing:border-box;padding:20px;border:1px solid var(--border-secondary,#8886);border-radius:12px;background:var(--bg-primary,Canvas);color:var(--text-primary,CanvasText);font-size:14px}.hapi-draft-handoff-dialog::backdrop{background:#0007}.hapi-draft-handoff-dialog header{display:flex;align-items:center;justify-content:space-between;gap:12px}.hapi-draft-handoff-dialog h2{font-size:18px;margin:0}.hapi-draft-handoff-dialog p{line-height:1.6}.hapi-draft-handoff-dialog pre{max-height:22vh;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;background:var(--bg-secondary,#8881);padding:12px;border-radius:8px}.hapi-draft-handoff-dialog code{overflow-wrap:anywhere;font-size:12px}.hapi-draft-handoff-dialog button{font:inherit;border:1px solid var(--border-secondary,#8885);border-radius:6px;background:var(--bg-secondary,transparent);color:inherit;cursor:pointer;padding:5px 9px}.hapi-draft-handoff-dialog button:disabled{opacity:.5;cursor:default}.hapi-draft-handoff-dialog footer,.hapi-draft-handoff-dialog li{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:10px 0}.hapi-draft-handoff-dialog section{margin:16px 0}.hapi-draft-handoff-dialog [role=alert]{color:var(--text-error,#d45d62);overflow-wrap:anywhere}`;
