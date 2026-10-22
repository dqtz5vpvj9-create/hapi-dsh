import { randomId } from './random-id.ts'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { HapiRemoteApi, WorkbenchSource } from '../client-api.ts';
import type { SourceComposerBridge } from './source-composer.tsx';
import { ComposerParkingController, parkingSnapshotMatches } from './composer-parking.ts';

type InputProps = PropsRuntime<'conversation.input.left'>;
/** Composer extension only; the official editor, attachments and submit path remain owners. */
export function installSourceComposerParking(ctx: Context, api: HapiRemoteApi, bridge: SourceComposerBridge): {
    /** Controlled action rendered inside the pane's composer overflow menu. */
    Action: (props: InputProps & { onAttention?(attention: boolean): void }) => React.ReactNode;
    dispose(): void;
} {
    const Action = ({ props, source, onAttention }: { props: InputProps; source: WorkbenchSource; onAttention?: ((attention: boolean) => void) | undefined }) => {
        const language = useSyncExternalStore(listener => ctx.locale.subscribe(listener), () => ctx.locale.getSnapshot().active);
        const tr = (en: string, zh: string): string => language.startsWith('zh') ? zh : en;
        const input = props.useInput(value => value);
        const [expanded, setExpanded] = useState(false), [captureError, setCaptureError] = useState<string | null>(null), [dismissed, setDismissed] = useState(false);
        const [viewId] = useState(() => randomId());
        const files = useRef<readonly { id: string; file: File }[]>([]);
        const actions = useRef(props.inputActions); actions.current = props.inputActions;
        const pane = ctx.get('hapiWorkspacePane');
        const controller = useMemo(() => new ComposerParkingController(api, source,
            JSON.stringify([source.sourceHubId, source.sourceSessionId, pane?.paneId ?? 'root']), snapshot => {
                const binding = ctx.sessions.binding(props.sessionId); if (!binding) return false;
                const owner = ctx.conversation.input.for(binding.ctx);
                if (!parkingSnapshotMatches(snapshot, owner.state.getSnapshot(), viewId)) return false;
                // The check and public writes run in one synchronous turn. A
                // changed editor or a different graph is never cleared.
                actions.current.setDraft(''); bridge.removeFiles(props.sessionId, files.current);
                actions.current.persistDraft(); return true;
            }), [source.sourceHubId, source.sourceSessionId, source.machineId, pane?.paneId, props.sessionId, viewId]);
        const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot), journal = state.journal;
        useEffect(() => { void controller.load(); }, [controller]);
        // Routine errors/recovery stay discoverable from the closed overflow menu.
        useEffect(() => { onAttention?.(Boolean(state.error || captureError || (journal && journal.state !== 'saved'))) },
            [onAttention, state.error, captureError, journal?.state]);
        const pending = !!journal && journal.state !== 'saved';
        const park = () => {
            setExpanded(true); setCaptureError(null); setDismissed(false);
            if (pending) return;
            try {
                const binding = ctx.sessions.binding(props.sessionId); if (!binding) throw new Error(tr('The original conversation is no longer open.', '原会话已关闭。'));
                const current = ctx.conversation.input.for(binding.ctx).state.getSnapshot();
                if (['adjudicating', 'submitting'].includes(current.phase)) throw new Error(tr('Wait for the current submission to finish.', '请等待当前提交完成。'));
                files.current = bridge.captureFiles(props.sessionId, current.attachmentIds);
                void controller.start({ viewId, text: current.draft, revision: current.draftRev, attachmentIds: [...current.attachmentIds] }, files.current);
            } catch (error) { setCaptureError(error instanceof Error ? error.message : String(error)); }
        };
        const id = `hapi-park-${viewId}`;
        return <span className="hapi-composer-parking">
            <button type="button" aria-expanded={expanded} aria-controls={id} disabled={state.busy || !state.loaded || !pending && !input.draft.trim() && !input.attachmentIds.length}
                title={tr('Save the current draft and attachments as a note without sending', '将当前草稿和附件保存为笔记，不发送消息')} onClick={park}>
                {state.busy ? tr('Parking…', '正在暂存…') : pending ? tr('Recover parked draft', '恢复暂存草稿') : tr('Park draft', '暂存草稿')}</button>
            {(expanded || !dismissed && (state.error || captureError)) && <section id={id} className="hapi-parking-panel" aria-label={tr('Parked composer draft', '暂存的输入草稿')}>
                <header><strong>{tr('Scratchlist', '备忘录')}</strong><button type="button" aria-label={tr('Close draft details', '关闭草稿详情')} onClick={() => { setExpanded(false); setCaptureError(null); setDismissed(true); }}>×</button></header>
                {journal && <><p className="hapi-source-note-text">{journal.snapshot.text || tr('Attachments only', '仅附件')}</p>
                    <ul>{journal.files.map(file => <li key={file.draftId}>{file.name} · {file.attachment ? tr('Saved on Hub', '已保存到 Hub') : tr('Original bytes kept locally', '原始文件已保存在本地')}</li>)}</ul></>}
                {journal?.state === 'saved' && <p role="status">{state.cleared ? tr('Saved to scratchlist. The parked draft was cleared.', '已保存到备忘录，并清空已暂存的草稿。')
                    : tr('Saved to scratchlist. The current composer was kept because it changed or was reopened.', '已保存到备忘录。当前输入框已变化或重新打开，因此仍予以保留。')}</p>}
                {pending && <p>{tr('The saved snapshot and source note identity are retained. Reopening this view only checks the Hub.', '已保留原始快照和笔记标识，重新打开视图只会查询 Hub。')}</p>}
                {journal?.files.some(file => !file.attachment && ['sending', 'unknown'].includes(file.upload)) && <p>{tr('An upload reply is missing. An explicit retry may create another temporary source attachment; the original bytes remain available.', '一次上传缺少回执。明确重试可能在原 Hub 创建新的临时附件，原始文件仍然保留。')}</p>}
                {(state.error || captureError) && <p role="alert" className="hapi-error">{captureError ?? state.error}</p>}
                <div className="hapi-button-row">
                    {pending && journal?.state !== 'discarding' && <><button type="button" disabled={state.busy} onClick={() => { void controller.inspect(); }}>{tr('Check saved note', '检查已保存笔记')}</button>
                        <button type="button" disabled={state.busy} onClick={() => { void controller.retry(); }}>{tr('Retry this saved draft', '重试这份暂存草稿')}</button></>}
                    {journal && ['preparing', 'discarding'].includes(journal.state) && <button type="button" disabled={state.busy} onClick={() => {
                        if (journal.state === 'discarding' || window.confirm(tr('Discard this saved parking attempt? The current composer and existing notes are kept.', '放弃这次暂存尝试？当前输入框和已有笔记会保留。'))) void controller.discard();
                    }}>{tr('Discard pending park', '放弃暂存尝试')}</button>}
                    <button type="button" onClick={() => { ctx.sidebarRight.openTab('hapi-notes'); setExpanded(false); }}>{tr('Open scratchlist', '打开备忘录')}</button>
                </div>
            </section>}
        </span>;
    };
    const SourceAction = (props: InputProps & { onAttention?(attention: boolean): void }) => {
        const native = props.useProjection('hapi'), observed = props.useProjection('hapiObserved'), projection = native ?? observed;
        const source = useMemo(() => projection ? { sourceSessionId: projection.hapiSessionId, sourceHubId: projection.hubId,
            ...(projection.machineId ? { machineId: projection.machineId } : {}) } : null, [projection?.hapiSessionId, projection?.hubId, projection?.machineId]);
        if (!source || observed?.sidechain) return null;
        return <Action key={props.sessionId} props={props} source={source} onAttention={props.onAttention}/>;
    };
    const style = document.createElement('style'); style.textContent = `
.hapi-composer-parking{position:relative;display:inline-flex}.hapi-composer-parking button{border:1px solid var(--border-secondary,#8885);background:var(--bg-secondary,transparent);color:inherit;border-radius:6px;padding:3px 7px;font:inherit;font-size:12px;white-space:nowrap;cursor:pointer}.hapi-composer-parking button:disabled{opacity:.5;cursor:default}
.hapi-parking-panel{position:static;width:auto;max-height:40dvh;overflow:auto;margin-top:6px;padding:10px;border:1px solid var(--border-secondary,#8886);border-radius:8px;background:var(--bg-primary,#17191d);color:var(--text-primary,inherit);font-size:13px}.hapi-parking-panel header{display:flex;justify-content:space-between;gap:8px}.hapi-parking-panel p{white-space:pre-wrap;overflow-wrap:anywhere}.hapi-parking-panel ul{padding-inline-start:18px}.hapi-parking-panel .hapi-button-row{display:flex;flex-wrap:wrap;gap:6px}.hapi-parking-panel .hapi-error{color:var(--text-error,#d45d62)}
`; document.head.append(style);
    return { Action: SourceAction, dispose() { style.remove(); } };
}
