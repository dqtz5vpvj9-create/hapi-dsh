/** HAPI-specific capabilities use the same public tab mechanism as any DSH plugin. */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client';
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client';
import type {} from '../hapi-agent/projection-types.ts';
import type {} from './pane-navigation.ts';
import type {} from './source-navigation.ts';
import { remoteValue, type HapiRemoteApi, type CatalogMachine, type SourceNote } from '../client-api.ts';
import { NativeLibraryPanel, NativeSessionToolsPanel, SourceHistoryPanel, SourceNotesPanel, SourceSchedulePanel, SourceMigrationPanel } from './deferred-panels.tsx';
import { SourceSessionToolsPanel } from './source-lifecycle.tsx';
import { installSourceComposerBridge } from './source-composer.tsx';
import { SourceTitlePanel } from './source-title-panel.tsx';
import { installSourceComposerParking } from './source-composer-parking.tsx';
import { installComposerGoal } from './composer-goal.tsx';
import { SourceCollaborationPanel } from './source-collaboration.tsx';
import { SourceDshChildPanel } from './source-dsh-child.tsx';
import { installShareReceiver } from './share-receiver.tsx';
import { useSharedWorkspacePane, useWorkspacePane } from './surface/pane-context.tsx';
import type { SourceComposerActionsProps } from './composer-picker/slots.ts';

const definitions = [
    { kind: 'hapi-notes', en: 'Scratchlist', zh: '备忘录' },
    { kind: 'hapi-history', en: 'History & export', zh: '历史与导出' },
    { kind: 'hapi-schedule', en: 'Scheduled messages', zh: '定时消息' },
    { kind: 'hapi-session-tools', en: 'Session tools', zh: '会话工具' },
    { kind: 'hapi-library', en: 'History & accounts', zh: '历史与账号' },
    { kind: 'hapi-collaboration', en: 'Team & work ledger', zh: '团队与工作记录' },
] as const;
type Kind = typeof definitions[number]['kind'];
type TabProps = PropsRuntime<'sidebar.right.pane.tab'>;

const styles = `
.hapi-source-panel{height:100%;min-height:0;overflow:auto;padding:16px;box-sizing:border-box;color:inherit;font-size:14px;line-height:1.5}
.hapi-source-panel header{display:flex;align-items:center;justify-content:space-between;gap:12px}
.hapi-source-panel h2{font-size:17px;margin:0 0 12px}.hapi-source-panel h3{font-size:15px;margin:24px 0 12px}
.hapi-source-panel label{display:grid;gap:5px;margin:10px 0}.hapi-source-panel input:not([type=checkbox]),.hapi-source-panel textarea,.hapi-source-panel select{width:100%;min-width:0;box-sizing:border-box;color:inherit;background:var(--bg-input,transparent);border:1px solid var(--border-secondary,#8886);border-radius:6px;padding:8px;font:inherit}
.hapi-source-panel textarea{resize:vertical}.hapi-source-panel button,.hapi-source-toolbar select{font:inherit;cursor:pointer;border:1px solid var(--border-secondary,#8886);border-radius:6px;padding:5px 10px;background:var(--bg-secondary,transparent);color:inherit}.hapi-source-panel button:disabled{opacity:.5;cursor:default}
.hapi-source-panel .hapi-button-row{display:flex;flex-wrap:wrap;gap:7px;align-items:center;margin:10px 0}.hapi-source-panel .hapi-button-row select{width:auto}
.hapi-source-panel button[aria-pressed=true]{border-color:var(--text-link,#6888db);background:color-mix(in srgb,var(--text-link,#6888db) 16%,transparent)}
.hapi-source-panel small{opacity:.7}.hapi-source-panel .hapi-error{color:var(--text-error,#d45d62);overflow-wrap:anywhere}.hapi-source-panel a{color:var(--text-link,#6888db)}
.hapi-source-notes,.hapi-source-outline{padding:0;list-style:none;display:grid;gap:14px}.hapi-source-notes>li{border:1px solid var(--border-secondary,#8885);border-radius:8px;padding:12px}.hapi-source-note-text{white-space:pre-wrap;overflow-wrap:anywhere;max-width:100%}
.hapi-source-outline>li{display:grid;gap:3px}.hapi-source-outline button{text-align:start;overflow-wrap:anywhere;white-space:pre-wrap}.hapi-source-file-pick{max-width:100%;font-size:12px}.hapi-source-panel .hapi-source-file-pick input{font-size:12px;padding:4px}
/* Match the workspace chrome rather than browser-default form styling. */
.hapi-source-panel{font:var(--hapi-font-body,14px/22px system-ui);padding:16px 20px;overscroll-behavior:contain}
.hapi-source-panel header{margin-bottom:12px}.hapi-source-panel header h2{margin:0;font-weight:600}
.hapi-source-panel>p{color:var(--hapi-secondary);margin:8px 0 16px}
.hapi-source-panel fieldset{min-width:0;margin:18px 0 8px;padding:12px;border:0;border-radius:10px;background:var(--hapi-muted,#f6f7f8)}
.hapi-source-panel legend{padding:0;font-weight:500}.hapi-source-panel label{margin:12px 0;gap:6px}
.hapi-source-panel input:not([type=checkbox]),.hapi-source-panel textarea,.hapi-source-panel select{border-color:var(--hapi-border,#d8dedf);border-radius:8px;background:var(--hapi-bg,#fff);padding:9px 10px}
.hapi-source-panel button{min-height:34px;border-color:transparent;border-radius:7px;background:var(--hapi-muted,#f6f7f8);padding:6px 10px;line-height:20px}
.hapi-source-panel button:hover:not(:disabled){background:var(--hapi-hover,#eef2f1)}
.hapi-source-panel :is(button,input,select,textarea):focus-visible{outline:2px solid var(--hapi-accent,#359b6c);outline-offset:2px}
.hapi-source-panel button[aria-pressed=true]{color:var(--hapi-accent);border-color:var(--hapi-accent);background:color-mix(in srgb,var(--hapi-accent) 9%,transparent)}
.hapi-source-panel button[type=submit],.hapi-source-panel .hapi-panel-primary{color:var(--hapi-bg,#fff);background:var(--hapi-accent,#359b6c)}
.hapi-source-panel .hapi-button-row{gap:6px;margin:8px 0;align-items:center}.hapi-source-panel .hapi-button-row>label{margin:0}
.hapi-source-panel small{opacity:1;color:var(--hapi-secondary);font-size:11px}
.hapi-source-panel ul:empty{display:none}.hapi-source-notes{margin-top:16px;gap:10px}.hapi-source-notes>li{border-color:var(--hapi-border,#d8dedf);border-radius:10px;padding:12px}.hapi-source-note-text{margin:0 0 8px}
.hapi-source-panel .hapi-source-file-pick{flex:1;min-width:140px}.hapi-source-panel .hapi-source-file-pick input{border:0;padding:0;background:transparent}
.hapi-source-file-pick input::file-selector-button{font:inherit;border:0;border-radius:6px;background:var(--hapi-muted,#f6f7f8);color:inherit;padding:8px;margin-right:8px;cursor:pointer}
.hapi-source-outline button{border:0;background:transparent;padding:7px 0}.hapi-source-outline>li{padding:7px 0;border-bottom:1px solid var(--hapi-border,#d8dedf)}
.hapi-plugin-view-shell .hapi-source-panel-title{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.hapi-plugin-view-shell .hapi-source-panel>header:has(>.hapi-source-panel-title){justify-content:flex-end;margin-bottom:0}
@media(max-width:600px){.hapi-source-panel{padding:12px 16px}.hapi-source-panel button,.hapi-source-file-pick input::file-selector-button{min-height:40px}}
@media(pointer:coarse){.hapi-source-panel button,.hapi-source-file-pick input::file-selector-button{min-height:44px}.hapi-source-panel button[aria-label]{min-width:44px}}
.hapi-source-toolbar{display:inline-flex;align-items:center}.hapi-source-toolbar select{max-width:160px;font-size:12px;padding:3px 6px}
.hapi-source-message{min-width:0;outline-offset:5px;border-radius:6px}.hapi-source-message:focus{outline:none}
.hapi-team-members{display:flex;flex-wrap:wrap;gap:8px;list-style:none;padding:0}.hapi-team-members li{display:flex;gap:6px;flex-wrap:wrap;border:1px solid var(--border-secondary,#8885);border-radius:18px;padding:4px 9px}.hapi-team-members li[data-state=active]{border-color:#3b996b}.hapi-team-members li[data-state=shutdown]{opacity:.65}.hapi-team-tasks,.hapi-team-messages,.hapi-team-events{list-style:none;padding:0;display:grid;gap:12px}.hapi-team-tasks>li,.hapi-team-messages>li,.hapi-team-events>li{border:1px solid var(--border-secondary,#8885);border-radius:8px;padding:10px}.hapi-team-tasks li>div,.hapi-team-messages li>div{display:flex;flex-wrap:wrap;gap:8px;align-items:center}.hapi-team-tasks [data-state=blocked]{border-color:var(--text-error,#d45d62)}.hapi-source-collaboration pre{overflow:auto;max-height:45vh;white-space:pre-wrap;overflow-wrap:anywhere}.hapi-source-collaboration code{overflow-wrap:anywhere}.hapi-source-collaboration time{font-size:11px;opacity:.65}
`;

/** Registers source-specific pages without owning tab layout, retention, menus or renderers. */
export function installHapiTabs(ctx: Context, api: HapiRemoteApi): () => void {
    const disposers: Array<() => void> = [];
    const composer = installSourceComposerBridge(ctx); disposers.push(() => composer.dispose());
    disposers.push(installShareReceiver(ctx, composer));
    disposers.push(installComposerGoal(ctx, api));
    const parking = installSourceComposerParking(ctx, api, composer);
    disposers.push(() => parking.dispose());
    const language = (): string => ctx.locale.getSnapshot().active;
    const title = (kind: Kind): string => { const item = definitions.find(row => row.kind === kind)!; return language().startsWith('zh') ? item.zh : item.en; };
    const style = document.createElement('style'); style.textContent = styles; document.head.append(style); disposers.push(() => style.remove());
    const useLanguage = () => useSyncExternalStore(listener => ctx.locale.subscribe(listener), language);
    const Library = ({ active, onOpen }: { active: boolean; onOpen(sessionId: string): void }) => {
        const lang = useLanguage(); const [machines, setMachines] = useState<CatalogMachine[]>([]); const [error, setError] = useState<string | null>(null);
        useEffect(() => { if (!active) return; let disposed = false;
            void api.catalog().then(remoteValue).then(result => { if (!disposed) { setMachines(result.machines); setError(null); } }, failure => { if (!disposed) setError(failure instanceof Error ? failure.message : String(failure)); });
            return () => { disposed = true; };
        }, [active]);
        return <>{error && <p role="alert" className="hapi-error">{error}</p>}<NativeLibraryPanel api={api} machines={machines} onOpen={onOpen} language={lang}/></>;
    };
    for (const definition of definitions) {
        const id = `hapi-dsh/${definition.kind}`;
        disposers.push(ctx.sidebarRightTabs.register({ id, kind: definition.kind, keepMounted: true, title: () => title(definition.kind),
            ...(definition.kind === 'hapi-library' ? { guide: [{ id: 'hapi-library', order: 90, title: () => title(definition.kind) }] } : {}) }));
        const Body = (props: TabProps) => {
            const { tab } = props.useTabInfo(); const lang = useLanguage();
            const pane = useWorkspacePane(ctx);
            const openConversation = (sessionId: string) => {
                if (pane) pane.openSession(sessionId);
                else ctx.uiWorkspace.openSession(sessionId as SessionId);
            };
            const openSuccessor = (sessionId: string) => {
                if (!pane) { ctx.get('hapiWorkspaceUi')?.handoffs.report(new Error('Open the original conversation in a workspace pane before moving its draft.')); return; }
                void pane.openSuccessor(sessionId).catch(error => pane.handoffs.report(error));
            };
            const native = props.useProjection('hapi'); const observed = props.useProjection('hapiObserved'); const projection = native ?? observed;
            const source = useMemo(() => projection ? { sourceSessionId: projection.hapiSessionId, sourceHubId: projection.hubId,
                ...(projection.machineId ? { machineId: projection.machineId } : {}) } : undefined,
            [projection?.hapiSessionId, projection?.hubId, projection?.machineId]);
            if (definition.kind === 'hapi-library') return <Library active={tab.visible} onOpen={openConversation}/>;
            if (observed?.dshChild) return <section className="hapi-source-panel">
                <SourceDshChildPanel api={api} sessionId={props.sessionId} initialState={observed.dshChild} active={tab.visible} language={lang}/>
                <button type="button" onClick={() => openConversation(observed.dshChild!.parentSessionId)}>{lang.startsWith('zh') ? '打开父会话' : 'Open parent conversation'}</button>
            </section>;
            if (observed?.sidechain) return <section className="hapi-source-panel"><p>{lang.startsWith('zh')
                ? '这是原始子任务的只读历史。会话操作和备忘录属于父会话。'
                : 'This is the original subtask’s read-only history. Session operations and notes belong to its parent conversation.'}</p>
                <button type="button" onClick={() => openConversation(observed.sidechain!.parentSessionId)}>{lang.startsWith('zh') ? '打开父会话' : 'Open parent conversation'}</button></section>;
            if (!source || !projection) return <section className="hapi-source-panel"><p>{lang.startsWith('zh') ? '请从统一侧边栏打开一条 HAPI 会话。' : 'Open a HAPI conversation from the unified sidebar.'}</p></section>;
            const shared = { api, source, sessionId: props.sessionId, active: tab.visible, language: lang };
            if (definition.kind === 'hapi-collaboration') return <SourceCollaborationPanel key={props.sessionId} {...shared} team={projection.team ?? null} teamError={projection.teamError} onOpenSource={async sourceId => {
                const catalog = remoteValue(await api.catalog());
                if (catalog.hubId !== source.sourceHubId) throw new Error('This work event belongs to another source Hub.');
                const target = catalog.sessions.find(session => session.hapiSessionId === sourceId);
                if (!target) throw new Error(lang.startsWith('zh') ? '目标会话尚未出现在原 Hub 目录中。' : 'The target conversation is not present in the original Hub catalog.');
                openConversation(target.id);
            }}/>;
            if (definition.kind === 'hapi-session-tools') return <section className="hapi-source-panel">
                <SourceTitlePanel key={`title:${source.sourceHubId}:${source.sourceSessionId}`} {...shared} onRename={async title => {
                    const binding = ctx.sessions.binding(props.sessionId); if (!binding) throw new Error('The original conversation is no longer open.');
                    remoteValue(await binding.session.rename(title));
                }}/>
                {native ? <NativeSessionToolsPanel api={api} sessionId={props.sessionId} machineId={projection.machineId ?? undefined} onOpen={openConversation} onSuccessor={openSuccessor} language={lang}/>
                    : <SourceSessionToolsPanel key={props.sessionId} api={api} sessionId={props.sessionId} onOpen={openConversation} onSuccessor={openSuccessor} language={lang} active={tab.visible}/>}
                <SourceMigrationPanel key={`history:${props.sessionId}`} api={api} sessionId={props.sessionId} onOpen={openConversation} onSuccessor={openSuccessor} language={lang} active={tab.visible}/>
            </section>;
            if (definition.kind === 'hapi-schedule') return <SourceSchedulePanel key={props.sessionId} {...shared} readOnly={projection.readOnly} delivery={projection.delivery} draftStorage={ctx.get('hapiWorkspaceUi')?.sourceScheduleDrafts}/>;
            if (definition.kind === 'hapi-history') return <SourceHistoryPanel key={props.sessionId} {...shared} exportPreferences={ctx.get('hapiWorkspaceUi')?.preferences} onJump={async messageId => {
                const navigation = ctx.get('hapiMessageNavigation'); if (!navigation) throw new Error('Conversation navigation is not ready.');
                if (pane) pane.focusConversation({ kind: 'message', messageId, origin: 'search' });
                else await navigation.reveal(props.sessionId, messageId, tab.signal);
            }}/>;
            const useNote = async (note: SourceNote, urls: Record<string, string>) => {
                const insertion = props.inputActions.captureInsertion();
                const binding = ctx.sessions.binding(props.sessionId); if (!binding) throw new Error('This conversation is no longer open.');
                const files: File[] = [];
                for (const attachment of note.attachments) {
                    const url = urls[attachment.id]; if (!url) throw new Error(`Attachment is unavailable: ${attachment.filename}`);
                    const response = await fetch(url, { signal: tab.signal, cache: 'no-store' });
                    if (!response.ok) throw new Error(`Attachment download failed: HTTP ${response.status}`);
                    const blob = await response.blob();
                    if (blob.size !== attachment.size) throw new Error(`The source attachment changed: ${attachment.filename}`);
                    files.push(new File([blob], attachment.filename, { type: attachment.mimeType }));
                }
                if (ctx.sessions.binding(props.sessionId) !== binding) throw new Error('The source conversation changed while reading its note.');
                if (pane) {
                    const targetPane = pane.focusConversation();
                    await pane.shareInbox.insertOriginal({ kind: 'hapi', hubId: source.sourceHubId, sessionId: source.sourceSessionId }, targetPane,
                        { title: '', text: note.text, url: '', files: files.map(file => ({ name: file.name, type: file.type, blob: file })), createdAt: Date.now() }, tab.signal);
                    return;
                }
                const removeAdded = await composer.addFiles(props.sessionId, files, tab.signal);
                if (!props.inputActions.insertText(note.text, insertion)) {
                    removeAdded();
                    throw new Error(lang.startsWith('zh') ? '输入框已发生变化，笔记仍保留，请重试。' : 'The composer changed. The note is retained; try inserting it again.');
                }
                props.inputActions.persistDraft();
                ctx.conversation.input.for(binding.ctx).focus();
            };
            // Only the notes tab asks the root browser for its one original
            // source-session key; isolated plugin storage stays isolated.
            let legacyRaw: string | null = null, legacyReadError: string | null = null;
            try { legacyRaw = pane?.readLegacyScratchlist(source.sourceSessionId) ?? null; }
            catch (error) { legacyReadError = error instanceof Error ? error.message : String(error); }
            return <SourceNotesPanel key={props.sessionId} {...shared} onUse={useNote} legacyRaw={legacyRaw} legacyReadError={legacyReadError}/>;
        };
        disposers.push(ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: id }, Body)));
    }
    // One compact overflow entry replaces the old inline tool select and the
    // separate Park-draft seat: official attach/editor/Send stay untouched.
    const Tools = ({ source: props, onAttention, onClose }: SourceComposerActionsProps) => {
        const lang = useLanguage(); const native = props.useProjection('hapi'); const observed = props.useProjection('hapiObserved');
        const pane = useSharedWorkspacePane();
        if (!native && !observed || observed?.sidechain) return null;
        const chinese = lang.startsWith('zh');
        return <>
                <parking.Action {...props} onAttention={onAttention}/>
                <div className="hapi-composer-overflow-section">
                    <span className="hapi-composer-overflow-title">{chinese ? '会话工具' : 'Conversation tools'}</span>
                    {definitions.map(row => <button type="button" key={row.kind} onClick={() => {
                        if (pane) pane.openTab(row.kind, { title: title(row.kind), reuseTabs: definitions.map(item => item.kind) });
                        else ctx.sidebarRight.openTabIn(props.sessionId, row.kind);
                        onClose();
                    }}>{title(row.kind)}</button>)}
                </div>
        </>;
    };
    disposers.push(ctx.slots.inject('hapi.source.composer-actions', () => ctx.slots.register({ name: 'hapi.source.composer-actions' }, Tools)));
    const TeamShortcut = (props: PropsRuntime<'conversation.session.header.utilities'>) => {
        const native = props.useProjection('hapi'), observed = props.useProjection('hapiObserved'), team = (native ?? observed)?.team; const lang = useLanguage();
        const pane = useSharedWorkspacePane();
        if (!team || observed?.sidechain) return null;
        return <button type="button" className="hapi-team-shortcut" onClick={() => {
            if (pane) pane.openTab('hapi-collaboration');
            else ctx.sidebarRight.openTabIn(props.sessionId, 'hapi-collaboration');
        }}
            aria-label={`${lang.startsWith('zh') ? '打开团队' : 'Open team'}: ${team.teamName}`}>{team.teamName} · {team.members?.length ?? 0}</button>;
    };
    disposers.push(ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({ name: 'conversation.session.header.utilities', id: 'hapi-dsh/team', order: 90 }, TeamShortcut)));
    return () => { for (const dispose of disposers.reverse()) dispose(); };
}
