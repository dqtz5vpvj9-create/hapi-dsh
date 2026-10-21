import { useCallback, useEffect, useRef, useState } from 'react';
import { remoteValue, type SessionExtrasResponse, type SourceWorkEvent, type SourceWorkLink, type SourceTeam } from '../client-api.ts';
import type { SourcePanelProps } from './session-extras.tsx';

function externalLink(value: string | undefined): string | undefined {
    if (!value) return undefined;
    try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined; } catch { return undefined; }
}
const showJson = (value: unknown): string => JSON.stringify(value, null, 2);
function displayDate(timestamp: number, language?: string): { label: string; iso?: string } {
    const value = new Date(timestamp);
    return Number.isFinite(value.getTime()) ? { label: value.toLocaleString(language), iso: value.toISOString() } : { label: String(timestamp) };
}
export function SourceCollaborationPanel({ api, source, active, language, team, teamError, onOpenSource }: SourcePanelProps & {
    team: SourceTeam | null; teamError?: string | null | undefined; onOpenSource(id: string): Promise<void>;
}) {
    const tr = (en: string, zh: string): string => language?.startsWith('zh') ? zh : en;
    const [messagesShown, setMessagesShown] = useState(5), [filter, setFilter] = useState('');
    const [ledger, setLedger] = useState<SessionExtrasResponse<'sourceWorkGraph'> | null>(null), [limit, setLimit] = useState(100);
    const [links, setLinks] = useState<Record<string, SourceWorkLink[]>>({}), [busyEvent, setBusyEvent] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null), [loading, setLoading] = useState(false);
    const generation = useRef(0), activeRead = useRef<number | null>(null);
    const refresh = useCallback(async () => {
        if (activeRead.current !== null) return;
        const revision = ++generation.current; activeRead.current = revision; setLoading(true); setError(null);
        try { const result = remoteValue(await api.sourceWorkGraph({ source, limit })); if (revision === generation.current) setLedger(result); }
        catch (error) { if (revision === generation.current) setError(error instanceof Error ? error.message : String(error)); }
        finally { if (activeRead.current === revision) activeRead.current = null; if (revision === generation.current) setLoading(false); }
    }, [api, source.sourceHubId, source.sourceSessionId, source.machineId, limit]);
    useEffect(() => {
        if (!active) return;
        void refresh(); const timer = setInterval(() => { void refresh(); }, 10_000);
        return () => { clearInterval(timer); ++generation.current; activeRead.current = null; };
    }, [active, refresh]);
    const inspect = async (event: SourceWorkEvent) => {
        if (busyEvent) return; setBusyEvent(event.id); setError(null);
        try { const result = remoteValue(await api.sourceWorkGraphLinks({ source, eventId: event.id })); setLinks(previous => ({ ...previous, [event.id]: result.links })); }
        catch (error) { setError(error instanceof Error ? error.message : String(error)); }
        finally { setBusyEvent(null); }
    };
    const open = async (id: string) => { try { await onOpenSource(id); } catch (error) { setError(error instanceof Error ? error.message : String(error)); } };
    const members = team?.members ?? [], tasks = team?.tasks ?? [], messages = team?.messages ?? [];
    const statusText = (status: string | undefined): string => ({ active: tr('Active', '活跃'), idle: tr('Idle', '空闲'), shutdown: tr('Shut down', '已关闭'),
        pending: tr('Pending', '待处理'), in_progress: tr('In progress', '进行中'), completed: tr('Completed', '已完成'), blocked: tr('Blocked', '受阻') })[status ?? ''] ?? tr('Unknown', '未知');
    return <section className="hapi-source-panel hapi-source-collaboration" aria-label={tr('Team & work ledger', '团队与工作记录')}>
        <header><h2>{team ? `${tr('Team', '团队')}: ${team.teamName}` : tr('Team & work ledger', '团队与工作记录')}</h2>
            <button type="button" disabled={loading} onClick={() => { void refresh(); }}>{tr('Refresh ledger', '刷新工作记录')}</button></header>
        {teamError && <p role="alert" className="hapi-error">{teamError}</p>}
        {team ? <>
            {team.description && <p>{team.description}</p>}
            <p role="status">{members.length} {tr('members', '个成员')} · {members.filter(member => member.status === 'active').length} {tr('active', '个活跃')} · {tasks.filter(task => task.status === 'completed').length}/{tasks.length} {tr('tasks completed', '项任务完成')}</p>
            <h3>{tr('Members', '成员')}</h3><ul className="hapi-team-members">{members.map((member, index) => <li key={`${member.name}:${index}`} data-state={member.status}>
                <strong>{member.name}</strong>{member.agentType && <span>{member.agentType}</span>}<span>{statusText(member.status)}</span></li>)}</ul>
            <h3>{tr('Tasks', '任务')}</h3><label>{tr('Find tasks', '查找任务')}<input type="search" value={filter} onChange={event => setFilter(event.currentTarget.value)}/></label>
            <ol className="hapi-team-tasks">{tasks.filter(task => [task.title, task.description, task.owner, task.id].some(text => text?.toLowerCase().includes(filter.toLowerCase()))).map(task => <li key={task.id} data-state={task.status}>
                <div><strong>{task.title}</strong><span>{statusText(task.status)}</span>{task.owner && <span>{tr('Owner', '负责人')}: {task.owner}</span>}</div>
                {task.description && <p className="hapi-source-note-text">{task.description}</p>}<small>{task.id}</small></li>)}</ol>
            <h3>{tr('Team messages', '团队消息')}</h3><ol className="hapi-team-messages">{messages.slice(-messagesShown).map((message, index) => <li key={`${message.timestamp}:${index}`}>
                <div><strong>{message.from} → {message.to}</strong><span>{message.type}</span></div><p className="hapi-source-note-text">{message.summary}</p>
                <small>{displayDate(message.timestamp, language).label}</small></li>)}</ol>
            {messages.length > messagesShown && <button type="button" onClick={() => setMessagesShown(count => Math.min(messages.length, count + 25))}>{tr('Show earlier team messages', '显示更早的团队消息')}</button>}
        </> : !teamError && <p>{tr('The source session has no active team.', '原会话当前没有活跃团队。')}</p>}
        <h3>{tr('Work ledger', '工作记录')}</h3>
        {error && <p role="alert" className="hapi-error">{error}</p>}
        {!ledger && loading && <p role="status">{tr('Reading the original Hub ledger…', '正在读取原 Hub 的工作记录…')}</p>}
        {ledger && !ledger.available && <p>{tr('This Hub does not advertise the work ledger capability.', '此 Hub 尚未声明工作记录能力。')}</p>}
        {ledger?.available && <>
            {ledger.events.length === 0 && <p>{tr('No work events are linked to this source conversation.', '这条原会话还没有关联的工作事件。')}</p>}
            <ol className="hapi-team-events">{ledger.events.map(event => <li key={event.id}>
                <header><strong>{event.eventType}</strong><time dateTime={displayDate(event.ts, language).iso}>{displayDate(event.ts, language).label}</time></header>
                {event.summary && <p className="hapi-source-note-text">{event.summary}</p>}
                <p><code>{event.sourceKind}: {event.sourceRef}</code>{event.sinkRef && <> → <code>{event.sinkKind}: {event.sinkRef}</code></>}</p>
                {event.tags.length > 0 && <p>{event.tags.join(' · ')}</p>}
                <p>{tr('Principal', '执行身份')}: {event.principal.kind} / {event.principal.id}{'on_behalf_of' in event.principal && <> · {tr('On behalf of', '代表')}: {event.principal.on_behalf_of}</>}</p>
                <div className="hapi-button-row"><button type="button" disabled={busyEvent !== null} onClick={() => { void inspect(event); }}>{tr('Inspect event links', '查看事件关联')}</button>
                    {event.sourceKind === 'session' && event.sourceRef !== source.sourceSessionId && <button type="button" onClick={() => { void open(event.sourceRef); }}>{tr('Open source conversation', '打开来源会话')}</button>}
                    {event.sinkKind === 'session' && event.sinkRef && event.sinkRef !== source.sourceSessionId && <button type="button" onClick={() => { void open(event.sinkRef!); }}>{tr('Open destination conversation', '打开目标会话')}</button>}</div>
                {links[event.id] && <ul aria-label={tr('Event links', '事件关联')}>{links[event.id]!.map(link => <li key={link.id}><code>{link.fromEventId}</code> — {link.relationType} → <code>{link.toEventId}</code>
                    {link.metadataJson !== null && <details><summary>{tr('Link metadata', '关联元数据')}</summary><pre>{showJson(link.metadataJson)}</pre></details>}</li>)}</ul>}
                {event.artifactRefs.length > 0 && <ul>{event.artifactRefs.map((artifact, index) => <li key={index}>
                    {externalLink(artifact.url) ? <a href={externalLink(artifact.url)} target="_blank" rel="noopener noreferrer">{artifact.title ?? artifact.url}</a> : <span>{artifact.title ?? artifact.ref ?? artifact.kind}</span>}
                    {artifact.ref && <code>{artifact.ref}</code>}</li>)}</ul>}
                <details><summary>{tr('Original event details', '原始事件详情')}</summary><pre>{showJson(event)}</pre></details>
            </li>)}</ol>
            {ledger.events.length >= ledger.requestedLimit && limit < 1000 && <button type="button" disabled={loading} onClick={() => setLimit(value => Math.min(1000, value + 100))}>{tr('Read more source events', '读取更多原始事件')}</button>}
            {ledger.events.length >= 1000 && <p>{tr('Showing up to 1,000 original source events. The Hub endpoint has no cursor for earlier pages.', '最多显示 1,000 条原始事件，当前 Hub 接口不提供更早页面的游标。')}</p>}
        </>}
    </section>;
}
