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
import { NativeLibraryPanel, NativeSessionToolsPanel } from './native-library.tsx';
import { SourceSessionToolsPanel } from './source-lifecycle.tsx';
import { SourceHistoryPanel, SourceNotesPanel, SourceSchedulePanel } from './session-extras.tsx';
import { installSourceComposerBridge } from './source-composer.tsx';
import { SourceMigrationPanel } from './source-history.tsx';
import { SourceTitlePanel } from './source-title-panel.tsx';
import { installSourceComposerParking } from './source-composer-parking.tsx';
import { SourceCollaborationPanel } from './source-collaboration.tsx';
import { SourceDshChildPanel } from './source-dsh-child.tsx';
import { installShareReceiver } from './share-receiver.tsx';
import { useSharedWorkspacePane, useWorkspacePane } from './surface/pane-context.tsx';

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
.hapi-source-toolbar{display:inline-flex;align-items:center}.hapi-source-toolbar select{max-width:160px;font-size:12px;padding:3px 6px}
.hapi-source-message{min-width:0;outline-offset:5px;border-radius:6px}.hapi-source-message:focus{outline:none}
.hapi-team-members{display:flex;flex-wrap:wrap;gap:8px;list-style:none;padding:0}.hapi-team-members li{display:flex;gap:6px;flex-wrap:wrap;border:1px solid var(--border-secondary,#8885);border-radius:18px;padding:4px 9px}.hapi-team-members li[data-state=active]{border-color:#3b996b}.hapi-team-members li[data-state=shutdown]{opacity:.65}.hapi-team-tasks,.hapi-team-messages,.hapi-team-events{list-style:none;padding:0;display:grid;gap:12px}.hapi-team-tasks>li,.hapi-team-messages>li,.hapi-team-events>li{border:1px solid var(--border-secondary,#8885);border-radius:8px;padding:10px}.hapi-team-tasks li>div,.hapi-team-messages li>div{display:flex;flex-wrap:wrap;gap:8px;align-items:center}.hapi-team-tasks [data-state=blocked]{border-color:var(--text-error,#d45d62)}.hapi-source-collaboration pre{overflow:auto;max-height:45vh;white-space:pre-wrap;overflow-wrap:anywhere}.hapi-source-collaboration code{overflow-wrap:anywhere}.hapi-source-collaboration time{font-size:11px;opacity:.65}
`;

/** Registers source-specific pages without owning tab layout, retention, menus or renderers. */
export function installHapiTabs(ctx: Context, api: HapiRemoteApi): () => void {
    const disposers: Array<() => void> = [];
    const composer = installSourceComposerBridge(ctx); disposers.push(() => composer.dispose());
    disposers.push(installShareReceiver(ctx, composer));
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
                pane?.revealConversation();
                await navigation.reveal(props.sessionId, messageId, tab.signal);
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
                const removeAdded = await composer.addFiles(props.sessionId, files, tab.signal);
                if (!props.inputActions.insertText(note.text, insertion)) {
                    removeAdded();
                    throw new Error(lang.startsWith('zh') ? '输入框已发生变化，笔记仍保留，请重试。' : 'The composer changed. The note is retained; try inserting it again.');
                }
                props.inputActions.persistDraft(); pane?.revealConversation();
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
    const Tools = (props: PropsRuntime<'conversation.input.left'>) => {
        const lang = useLanguage(); const native = props.useProjection('hapi'); const observed = props.useProjection('hapiObserved');
        const pane = useSharedWorkspacePane();
        const [attention, setAttention] = useState(false);
        if (!native && !observed || observed?.sidechain) return null;
        const chinese = lang.startsWith('zh');
        return <details className="hapi-composer-overflow" data-hapi-composer-overflow="">
            <summary aria-label={chinese ? '更多输入控件' : 'More input controls'}
                title={chinese ? '更多输入控件' : 'More input controls'}>
                <span className="hapi-composer-overflow-glyph" aria-hidden="true">⋯</span>
                {attention && <span className="hapi-composer-overflow-alert" aria-label={chinese ? '暂存草稿需要处理' : 'Parked draft needs attention'}/>}
            </summary>
            <div className="hapi-composer-overflow-panel" role="group" aria-label={chinese ? '更多输入控件' : 'More input controls'}>
                <parking.Action {...props} onAttention={setAttention}/>
                <div className="hapi-composer-overflow-section">
                    <span className="hapi-composer-overflow-title">{chinese ? '会话工具' : 'Conversation tools'}</span>
                    {definitions.map(row => <button type="button" key={row.kind} onClick={() => {
                        if (pane) pane.openTab(row.kind);
                        else ctx.sidebarRight.openTabIn(props.sessionId, row.kind);
                    }}>{title(row.kind)}</button>)}
                </div>
            </div>
        </details>;
    };
    disposers.push(ctx.slots.inject('conversation.input.left', () => ctx.slots.register({ name: 'conversation.input.left', id: 'hapi-dsh/source-tools', order: 95 }, Tools)));
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
