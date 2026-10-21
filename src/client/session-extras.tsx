import { randomId } from './random-id.ts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { remoteValue, type HapiRemoteApi, type WorkbenchSource, type SourceAttachment, type SourceNote,
    type SourceOutline, type SessionExtrasResponse } from '../client-api.ts';
import { sourceAttachmentSchema } from '../session-extras-types.ts';
import type { DeliveryView } from '../codex/projection-types.ts';
import { NoteMigration } from './note-migration-ui.tsx';
import { SourceExportPanel } from './source-export.tsx';
import type { SourceExportPreferences } from './source-export-state.ts';
import { resolveSchedule, scheduleError, schedulePresets } from './schedule-selection.ts';
import { localDateTime, readScheduleDraft, saveScheduleDraft, scheduleKey, scheduleRestoredEvent, type ScheduleDraft, type ScheduleIntent } from './schedule-draft.ts';

const words = (language?: string) => (en: string, zh: string): string => language?.startsWith('zh') ? zh : en;
const failureText = (error: unknown): string => error instanceof Error ? error.message : String(error);
function storage(): Storage | undefined { try { return window.localStorage; } catch { return undefined; } }
function identity(source: WorkbenchSource): string { return JSON.stringify([source.sourceHubId, source.sourceSessionId]); }

export interface SourcePanelProps {
    api: HapiRemoteApi; source: WorkbenchSource; sessionId: string; active: boolean; language?: string | undefined;
}
interface NoteDraft { entryId: string; text: string; attachments: SourceAttachment[]; editing: boolean; updatedAt?: number }
function draftKey(source: WorkbenchSource): string { return `hapi-dsh:note-draft:${identity(source)}`; }
function freshDraft(): NoteDraft { return { entryId: randomId(), text: '', attachments: [], editing: false }; }
function readDraft(source: WorkbenchSource): NoteDraft {
    try {
        const value: unknown = JSON.parse(storage()?.getItem(draftKey(source)) ?? 'null');
        if (value && typeof value === 'object' && 'entryId' in value && typeof value.entryId === 'string'
            && 'text' in value && typeof value.text === 'string' && value.text.length <= 10000
            && 'editing' in value && typeof value.editing === 'boolean' && 'attachments' in value && Array.isArray(value.attachments)) {
            const attachments = sourceAttachmentSchema.array().max(128).safeParse(value.attachments);
            if (attachments.success) return { entryId: value.entryId, text: value.text, editing: value.editing, attachments: attachments.data,
                ...('updatedAt' in value && typeof value.updatedAt === 'number' ? { updatedAt: value.updatedAt } : {}) };
        }
    } catch { /* A malformed old browser draft cannot replace the Hub's notes. */ }
    return freshDraft();
}
function persistDraft(source: WorkbenchSource, draft: NoteDraft): boolean {
    try { storage()?.setItem(draftKey(source), JSON.stringify(draft)); return storage() !== undefined; } catch { return false; }
}
async function base64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader(); reader.onerror = () => reject(reader.error ?? new Error('The file could not be read'));
        reader.onload = () => { const result = String(reader.result); resolve(result.slice(result.indexOf(',') + 1)); }; reader.readAsDataURL(file);
    });
}

/** HAPI-owned parking notes remain in HAPI; editing a note never sends a chat message. */
export function SourceNotesPanel({ api, source, active, language, onUse, legacyRaw, legacyReadError }: SourcePanelProps & {
    onUse(note: SourceNote, urls: Record<string, string>): Promise<void>;
    legacyRaw?: string | null;
    legacyReadError?: string | null;
}) {
    const tr = words(language); const [data, setData] = useState<SessionExtrasResponse<'sourceNotes'> | null>(null);
    const [draft, setDraft] = useState<NoteDraft>(() => readDraft(source));
    const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState(false);
    const [localSaved, setLocalSaved] = useState(true); const [remove, setRemove] = useState<SourceNote | null>(null);
    const [query, setQuery] = useState(''); const [order, setOrder] = useState<string[]>(() => {
        try { const value: unknown = JSON.parse(storage()?.getItem(`hapi-dsh:note-order:${identity(source)}`) ?? '[]'); return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []; } catch { return []; }
    });
    const gate = useRef(false); const generation = useRef(0);
    const refresh = useCallback(async (): Promise<SessionExtrasResponse<'sourceNotes'> | null> => {
        const revision = ++generation.current;
        try { const next = remoteValue(await api.sourceNotes({ source })); if (revision === generation.current) { setData(next); setError(null); } return next; }
        catch (error) { if (revision === generation.current) setError(failureText(error)); return null; }
    }, [api, source.sourceHubId, source.sourceSessionId, source.machineId]);
    useEffect(() => {
        if (!active) return;
        void refresh(); const timer = setInterval(() => { if (!gate.current) void refresh(); }, 10_000);
        return () => { clearInterval(timer); ++generation.current; };
    }, [active, refresh]);
    useEffect(() => { setLocalSaved(persistDraft(source, draft)); }, [draft, source.sourceSessionId, source.sourceHubId]);
    useEffect(() => {
        const protect = (event: BeforeUnloadEvent) => { if (!localSaved && (draft.text || draft.attachments.length)) { event.preventDefault(); event.returnValue = ''; } };
        window.addEventListener('beforeunload', protect); return () => window.removeEventListener('beforeunload', protect);
    }, [localSaved, draft]);
    const run = async (work: () => Promise<void>) => {
        if (gate.current) return; gate.current = true; setBusy(true); setError(null);
        try { await work(); } catch (error) { setError(failureText(error)); } finally { gate.current = false; setBusy(false); }
    };
    const save = () => run(async () => {
        if (!draft.text.trim() && !draft.attachments.length) return;
        if (draft.editing) {
            const latest = await refresh(); if (!latest) return;
            const current = latest.entries.find(entry => entry.entryId === draft.entryId);
            if (!current || current.updatedAt !== draft.updatedAt) throw new Error(tr('This note changed on another device. Your draft is retained; save it as a new note or reopen the current version.', '这条笔记已在另一设备变更。草稿已保留，可以另存为新笔记，或重新打开最新版本。'));
        }
        const response = remoteValue(await api.sourceNoteWrite({ source, action: { kind: draft.editing ? 'update' : 'create',
            entryId: draft.entryId, text: draft.text, attachments: draft.attachments } }));
        if (!response.entry || response.entry.entryId !== draft.entryId || response.entry.text !== draft.text.trim()
            || JSON.stringify(response.entry.attachments) !== JSON.stringify(draft.attachments)) {
            throw new Error(tr('The original note was recovered but differs from this draft. The draft is retained.', '原笔记已恢复，但与当前草稿不同。草稿已保留。'));
        }
        setDraft(freshDraft()); await refresh();
    });
    const upload = (files: FileList | null) => run(async () => {
        if (!files?.length || !data) return;
        if (draft.attachments.length + files.length > data.limits.maxAttachmentsPerEntry) throw new Error(tr('Too many attachments for one note.', '单条笔记的附件数量超过限制。'));
        const total = draft.attachments.reduce((sum, file) => sum + file.size, 0) + [...files].reduce((sum, file) => sum + file.size, 0);
        if (total > data.limits.maxBytesPerEntry) throw new Error(tr('These attachments exceed the note size limit.', '这些附件超过单条笔记的容量限制。'));
        for (const file of files) {
            const mimeType = file.type || 'application/octet-stream';
            if (file.size > data.limits.maxBytesPerFile || !data.limits.allowedMimeTypes.includes(mimeType)) throw new Error(tr(`Unsupported or oversized attachment: ${file.name}`, `附件格式或大小不受支持：${file.name}`));
            const result = remoteValue(await api.sourceNoteUpload({ source, filename: file.name, mimeType, content: await base64(file) }));
            // Keep each successful upload even when a later file fails.
            setDraft(previous => ({ ...previous, attachments: [...previous.attachments, result.attachment] }));
        }
    });
    const ordered = [...data?.entries ?? []].sort((a, b) => {
        const left = order.indexOf(a.entryId), right = order.indexOf(b.entryId);
        return (left < 0 ? Infinity : left) - (right < 0 ? Infinity : right) || b.createdAt - a.createdAt;
    });
    const move = (entryId: string, delta: number) => {
        const ids = ordered.map(entry => entry.entryId), index = ids.indexOf(entryId), next = index + delta;
        if (index < 0 || next < 0 || next >= ids.length) return;
        [ids[index], ids[next]] = [ids[next]!, ids[index]!]; setOrder(ids);
        try { storage()?.setItem(`hapi-dsh:note-order:${identity(source)}`, JSON.stringify(ids)); } catch { /* In-memory ordering remains usable. */ }
    };
    return <section className="hapi-source-panel" aria-label={tr('Scratchlist', '备忘录')}>
        <header><h2>{tr('Scratchlist', '备忘录')}</h2><button type="button" disabled={busy} onClick={() => { void refresh(); }}>{tr('Refresh', '刷新')}</button></header>
        <p>{tr('Save notes and drafts with this conversation. Use in composer when you are ready.', '将笔记和草稿保存在这条聊天中，需要时再放入输入框。')}</p>
        <NoteMigration api={api} source={source} legacyRaw={legacyRaw} language={language} onRefresh={refresh}/>
        {legacyReadError && <p role="alert" className="hapi-error">{tr('Original browser notes could not be read:', '无法读取原浏览器笔记：')} {legacyReadError}</p>}
        {error && <p role="alert" className="hapi-error">{error}</p>}
        <form onSubmit={event => { event.preventDefault(); void save(); }}>
            <label>{draft.editing ? tr('Edit note', '编辑笔记') : tr('New note', '新笔记')}<textarea rows={5} maxLength={10000} value={draft.text} disabled={busy}
                onChange={event => { const text = event.currentTarget.value; setDraft(previous => ({ ...previous, text })); }}/></label>
            <small>{draft.text.length}/10000 · {localSaved ? tr('Draft saved on this device', '草稿已保存在此设备') : tr('Browser storage unavailable; keep this pane open until saved', '浏览器存储不可用，请保存后再关闭窗格')}</small>
            <ul>{draft.attachments.map(file => <li key={file.id}>{file.filename} <button type="button" disabled={busy} onClick={() => setDraft(previous => ({ ...previous, attachments: previous.attachments.filter(row => row.id !== file.id) }))}>{tr('Remove', '移除')}</button></li>)}</ul>
            <div className="hapi-button-row"><label className="hapi-source-file-pick">{tr('Attach files', '添加附件')}<input type="file" multiple disabled={busy || !data} accept={data?.limits.allowedMimeTypes.join(',')} onChange={event => { const files = event.currentTarget.files; void upload(files); event.currentTarget.value = ''; }}/></label>
                <button type="submit" disabled={busy || !data || (!draft.text.trim() && !draft.attachments.length)}>{tr('Save note', '保存笔记')}</button>
                {draft.editing && <button type="button" disabled={busy} onClick={() => setDraft(previous => ({ ...previous, entryId: randomId(), editing: false }))}>{tr('Save as new', '另存为新笔记')}</button>}
                {(draft.editing || draft.text || draft.attachments.length > 0) && <button type="button" disabled={busy} onClick={() => {
                    if (window.confirm(tr('Discard this local draft?', '放弃当前本地草稿？'))) setDraft(freshDraft());
                }}>{tr('Discard draft', '放弃草稿')}</button>}</div>
        </form>
        <label>{tr('Find notes', '查找笔记')}<input type="search" value={query} onChange={event => setQuery(event.currentTarget.value)}/></label>
        {!data && <p role="status">{tr('Loading notes…', '正在读取笔记…')}</p>}
        <ol className="hapi-source-notes">{ordered.filter(note => note.text.toLowerCase().includes(query.toLowerCase()) || note.attachments.some(file => file.filename.toLowerCase().includes(query.toLowerCase()))).map(note => <li key={note.entryId}>
            <p className="hapi-source-note-text">{note.text}</p><ul>{note.attachments.map(file => <li key={file.id}><a href={data?.attachmentUrls[file.id]} download={file.filename}>{file.filename}</a></li>)}</ul>
            <small>{new Date(note.updatedAt).toLocaleString()}</small><div className="hapi-button-row">
                <button type="button" disabled={busy} onClick={() => { void run(() => onUse(note, data?.attachmentUrls ?? {})); }}>{tr('Use in composer', '放入输入框')}</button>
                <button type="button" disabled={busy} onClick={() => {
                    if ((draft.text || draft.attachments.length) && !window.confirm(tr('Replace the local draft with this saved note?', '使用这条笔记替换当前本地草稿？'))) return;
                    setDraft({ entryId: note.entryId, text: note.text, attachments: note.attachments, editing: true, updatedAt: note.updatedAt });
                }}>{tr('Edit', '编辑')}</button>
                <button type="button" disabled={busy} onClick={() => move(note.entryId, -1)} aria-label={tr('Move up', '上移')}>↑</button>
                <button type="button" disabled={busy} onClick={() => move(note.entryId, 1)} aria-label={tr('Move down', '下移')}>↓</button>
                <button type="button" disabled={busy} onClick={() => setRemove(note)}>{tr('Delete', '删除')}</button>
            </div>{remove?.entryId === note.entryId && <div role="alert"><p>{tr('Delete this saved note from all devices?', '从所有设备删除这条已保存的笔记？')}</p>
                <button type="button" disabled={busy} onClick={() => { void run(async () => { remoteValue(await api.sourceNoteWrite({ source, action: { kind: 'delete', entryId: note.entryId } })); setRemove(null); await refresh(); }); }}>{tr('Delete note', '删除笔记')}</button>
                <button type="button" onClick={() => setRemove(null)}>{tr('Cancel', '取消')}</button></div>}
        </li>)}</ol>
        {data?.entries.length === 0 && <p>{tr('No notes yet.', '还没有笔记。')}</p>}
    </section>;
}

export function SourceHistoryPanel({ api, source, active, language, onJump, exportPreferences }: SourcePanelProps & {
    onJump(messageId: string): Promise<void>; exportPreferences?: SourceExportPreferences | undefined;
}) {
    const tr = words(language); const [outline, setOutline] = useState<SourceOutline | null>(null);
    const [query, setQuery] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
    const generation = useRef(0);
    const load = useCallback(async (older = false) => {
        const current = ++generation.current; setBusy(true); setError(null);
        try {
            const cursor = older ? outline?.page.beforeCursor : undefined;
            const page = remoteValue(await api.sourceOutline({ source, query: { limit: 100,
                ...(cursor && outline ? { beforeAt: cursor.at, beforeSeq: cursor.seq, epoch: outline.page.epoch } : {}) } }));
            if (current !== generation.current) return;
            setOutline(previous => !older || !previous || page.page.reset || previous.page.epoch !== page.page.epoch ? page : {
                ...page, entries: [...new Map([...previous.entries, ...page.entries].map(row => [row.messageId, row])).values()],
            });
        } catch (failure) { if (current === generation.current) setError(failureText(failure)); }
        finally { if (current === generation.current) setBusy(false); }
    }, [api, source.sourceHubId, source.sourceSessionId, source.machineId, outline]);
    const latest = useRef(load); latest.current = load;
    useEffect(() => { if (active && !outline) void latest.current(); return () => { ++generation.current; }; }, [active]);
    return <section className="hapi-source-panel" aria-label={tr('Conversation history', '聊天历史')}>
        <header><h2>{tr('Conversation history', '聊天历史')}</h2><button type="button" disabled={busy} onClick={() => { void load(); }}>{tr('Refresh', '刷新')}</button></header>
        {error && <p className="hapi-error" role="alert">{error}</p>}
        <label>{tr('Find in loaded outline', '搜索已加载的大纲')}<input type="search" value={query} onChange={event => setQuery(event.currentTarget.value)}/></label>
        <ol className="hapi-source-outline">{outline?.entries.filter(entry => entry.label.toLowerCase().includes(query.toLowerCase())).map(entry => <li key={entry.messageId}>
            <button type="button" disabled={busy} onClick={() => { setBusy(true); setError(null); void onJump(entry.messageId).catch(error => setError(failureText(error))).finally(() => setBusy(false)); }}>{entry.label || tr('User message', '用户消息')}</button>
            <small>{new Date(entry.createdAt).toLocaleString()}</small></li>)}</ol>
        {outline?.page.indexing && <p role="status">{tr('The source is indexing earlier messages. Refresh to read more.', '原会话正在索引较早的消息，刷新后可以继续读取。')}</p>}
        {outline?.page.unreadable && <p role="alert">{tr('Some original messages are unreadable; the outline may be incomplete.', '部分原始消息无法读取，大纲可能不完整。')}</p>}
        {outline?.page.hasMore && <button type="button" disabled={busy} onClick={() => { void load(true); }}>{tr('Load earlier', '加载更早的消息')}</button>}
        {busy && <p role="status">{tr('Loading…', '读取中…')}</p>}
        <SourceExportPanel api={api} source={source} language={language} preferences={exportPreferences}/>
    </section>;
}

export function SourceSchedulePanel({ api, source, sessionId, language, readOnly, delivery, active = true, draftStorage }: SourcePanelProps & {
    readOnly: boolean; delivery: readonly DeliveryView[]; draftStorage?: import('./schedule-draft.ts').ScheduleStorage | undefined;
}) {
    const store = useMemo(() => draftStorage ?? storage(), [draftStorage]);
    const [initial] = useState(() => readScheduleDraft(store, source, sessionId));
    const tr = words(language); const [text, setText] = useState(initial.text); const [at, setAt] = useState(initial.at);
    const [selection, setSelection] = useState(initial.selection), [localSaved, setLocalSaved] = useState(true);
    const [intent, setIntent] = useState<ScheduleIntent | null>(initial.intent);
    const [receipt, setReceipt] = useState<DeliveryView | null>(initial.receipt); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
    const gate = useRef(false);
    // A source projection can overtake the initial POST's dispatching response.
    // Its current queue observation always wins while that entry is present.
    const observed = intent ? delivery.find(item => item.messageId === `hapi-schedule:${intent.operationId}`) : undefined;
    const currentReceipt = observed ?? receipt;
    const draftRef = useRef<ScheduleDraft>(initial); draftRef.current = { text, at, selection, intent, receipt: currentReceipt };
    // Persist editor gestures synchronously so a cancellation's CAS can never
    // race ahead of a newer React draft that has not committed its effect yet.
    const applyDraft = (patch: Partial<ScheduleDraft>) => {
        const next = { ...draftRef.current, ...patch }; draftRef.current = next;
        setLocalSaved(saveScheduleDraft(store, source, sessionId, next));
        setText(next.text); setAt(next.at); setSelection(next.selection); setIntent(next.intent); setReceipt(next.receipt);
    };
    useEffect(() => { setLocalSaved(saveScheduleDraft(store, source, sessionId, { text, at, selection, intent, receipt: currentReceipt })); }, [store, source.sourceHubId, source.sourceSessionId, sessionId, text, at, selection, intent, currentReceipt]);
    useEffect(() => {
        const key = scheduleKey(source, sessionId);
        const changed = (eventKey: unknown) => {
            if (eventKey !== key) return;
            const next = readScheduleDraft(store, source, sessionId); draftRef.current = next;
            setText(next.text); setAt(next.at); setSelection(next.selection); setIntent(next.intent); setReceipt(next.receipt); setError(null);
        };
        const restore = (event: Event) => { changed(event instanceof StorageEvent ? event.key : event instanceof CustomEvent ? event.detail?.key : undefined); };
        const unsubscribe = store?.subscribe?.(changed);
        window.addEventListener(scheduleRestoredEvent, restore); window.addEventListener('storage', restore);
        return () => { unsubscribe?.(); window.removeEventListener(scheduleRestoredEvent, restore); window.removeEventListener('storage', restore); };
    }, [store, source.sourceHubId, source.sourceSessionId, sessionId]);
    useEffect(() => {
        const protect = (event: BeforeUnloadEvent) => { if (!localSaved && (text || intent)) { event.preventDefault(); event.returnValue = ''; } };
        window.addEventListener('beforeunload', protect); return () => window.removeEventListener('beforeunload', protect);
    }, [localSaved, text, intent]);
    useEffect(() => {
        if (!intent || !active) return; let disposed = false; let timer: ReturnType<typeof setTimeout> | undefined;
        const read = async () => {
            let complete = false;
            try {
                const value = remoteValue(await api.nativeScheduleRead({ sessionId, operationId: intent.operationId }));
                if (!disposed && value) setReceipt(value);
                complete = value !== null && ['invoked', 'cancelled', 'rejected'].includes(value.state);
            } catch { /* A read cannot change submission ownership; the explicit check reports errors. */ }
            if (!disposed && !complete) timer = setTimeout(() => { void read(); }, 2000);
        };
        void read();
        return () => { disposed = true; clearTimeout(timer); };
    }, [api, sessionId, intent?.operationId, active]);
    const inspect = async () => {
        if (!intent || gate.current) return; gate.current = true; setBusy(true); setError(null);
        try {
            const value = remoteValue(await api.nativeScheduleRead({ sessionId, operationId: intent.operationId }));
            if (value) setReceipt(value);
            else setError(tr('The Host has not recorded this submission. You can retry the identical request.', 'Host 尚未记录这次提交，可以重试同一请求。'));
        } catch (failure) { setError(failureText(failure)); } finally { gate.current = false; setBusy(false); }
    };
    const submit = async () => {
        if (gate.current) return;
        const now = Date.now(), scheduledAt = resolveSchedule(selection, now);
        if (!intent && (!text.trim() || scheduleError(scheduledAt, now))) {
            setError(tr('Choose a time in the next seven days and enter a message.', '请输入消息，并选择未来七天内的时间。')); return;
        }
        const request = intent ?? { sessionId, operationId: randomId(), text, scheduledAt };
        if (!saveScheduleDraft(store, source, sessionId, { text, at, selection, intent: request, receipt })) {
            setLocalSaved(false); setError(tr('This browser could not retain the submission identity. Nothing was sent; keep the draft and free some browser storage before trying again.', '浏览器无法保存本次提交身份，尚未发送任何内容。请保留草稿并释放浏览器存储后重试。')); return;
        }
        setIntent(request); gate.current = true; setBusy(true); setError(null);
        try { setReceipt(remoteValue(await api.nativeSchedule(request))); }
        catch (failure) { setError(failureText(failure)); } finally { gate.current = false; setBusy(false); }
    };
    const acknowledged = currentReceipt && !['dispatching', 'indeterminate'].includes(currentReceipt.state);
    return <section className="hapi-source-panel" aria-label={tr('Scheduled messages', '定时消息')}>
        <h2>{tr('Scheduled messages', '定时消息')}</h2><p>{tr('The original Hub owns the schedule. You can close this browser after it confirms the queue.', '由原 Hub 保存定时计划，确认入队后可以关闭浏览器。')}</p>
        {error && <p className="hapi-error" role="alert">{error}</p>}
        <label>{tr('Message', '消息')}<textarea rows={6} value={text} disabled={readOnly || busy || Boolean(intent)} onChange={event => applyDraft({ text: event.currentTarget.value })}/></label>
        <fieldset disabled={readOnly || busy || Boolean(intent)}><legend>{tr('When to send', '何时发送')}</legend>
            <div className="hapi-button-row" role="group" aria-label={tr('Relative schedule', '相对时间')}>{schedulePresets.map(preset => <button type="button" key={preset} aria-pressed={selection.type === 'preset' && selection.preset === preset} onClick={() => { applyDraft({ selection: { type: 'preset', preset } }); setError(null); }}>{preset}</button>)}</div>
            {selection.type === 'preset' && <small>{tr('This delay starts when you press Schedule message.', '从点击“添加定时消息”的时刻开始计算此延迟。')}</small>}
            <label>{tr('Send at (your local time)', '发送时间（本地时间）')}<input type="datetime-local" value={at} min={localDateTime(Date.now() - 30_000)} max={localDateTime(Date.now() + 7 * 86400_000)} onChange={event => {
                const value = event.currentTarget.value; applyDraft({ at: value, selection: { type: 'absolute', ms: new Date(value).getTime() } }); setError(null);
            }}/></label>
            <button type="button" aria-pressed={selection.type === 'absolute'} onClick={() => applyDraft({ selection: { type: 'absolute', ms: new Date(at).getTime() } })}>{tr('Use this date and time', '使用此日期和时间')}</button>
        </fieldset>
        <small>{localSaved ? tr('Draft saved on this device', '草稿已保存在此设备') : tr('Browser storage unavailable; the submission is blocked until its identity can be saved.', '浏览器存储不可用，在提交身份可保存前不能发送。')}</small>
        <div className="hapi-button-row"><button type="button" disabled={busy || (!intent && readOnly) || Boolean(acknowledged)} onClick={() => { void (intent ? inspect() : submit()); }}>{intent ? tr('Check this submission', '检查本次提交') : tr('Schedule message', '添加定时消息')}</button>
            {intent && !currentReceipt && error && <button type="button" disabled={busy || readOnly} onClick={() => { void submit(); }}>{tr('Retry the same request', '重试同一请求')}</button>}
            {acknowledged && <button type="button" disabled={busy} onClick={() => applyDraft({ intent: null, receipt: null, text: '' })}>{tr('New scheduled message', '新建定时消息')}</button>}</div>
        {currentReceipt && <p role="status">{currentReceipt.state}{currentReceipt.error ? ` · ${currentReceipt.error}` : ''}</p>}
        {readOnly && <p>{tr('Resume this session with its original owner before scheduling a message.', '请先在原执行端恢复这条会话，再添加定时消息。')}</p>}
        <ul>{delivery.filter(item => item.scheduledAt != null && !['cancelled', 'rejected'].includes(item.state)).map(item => <li key={item.localId}>
            <time dateTime={new Date(item.scheduledAt!).toISOString()}>{new Date(item.scheduledAt!).toLocaleString()}</time><p className="hapi-source-note-text">{item.text}</p><small>{item.state}</small>
            {item.state !== 'invoked' && <button type="button" disabled={busy} onClick={() => {
                setBusy(true); void api.nativeCancel({ sessionId, localId: item.localId }).then(remoteValue).catch(failure => setError(failureText(failure))).finally(() => setBusy(false));
            }}>{tr('Cancel scheduled message', '取消定时消息')}</button>}
        </li>)}</ul>
    </section>;
}
