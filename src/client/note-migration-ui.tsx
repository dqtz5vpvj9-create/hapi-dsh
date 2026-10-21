import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { SessionExtrasApi, WorkbenchSource } from '../client-api.ts';
import { NoteMigrationController } from './note-migration.ts';

function browserStorage(): Storage | undefined { try { return window.localStorage; } catch { return undefined; } }
export function NoteMigration({ api, source, legacyRaw, language, onRefresh }: {
    api: SessionExtrasApi; source: WorkbenchSource; legacyRaw?: string | null | undefined; language?: string | undefined; onRefresh(): Promise<unknown>;
}) {
    const tr = (en: string, zh: string): string => language?.startsWith('zh') ? zh : en;
    const controller = useMemo(() => new NoteMigrationController(api, source, browserStorage()), [api, source.sourceHubId, source.sourceSessionId]);
    const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot), journal = state.journal;
    const fileRef = useRef<HTMLInputElement>(null);
    const [fileError, setFileError] = useState<string>();
    useEffect(() => { if (!controller.getSnapshot().journal && legacyRaw) controller.prepare(legacyRaw); }, [controller, legacyRaw]);
    const completed = journal?.rows.filter(row => ['saved', 'kept'].includes(row.state)).length ?? 0;
    const backup = () => {
        if (!journal) return;
        const url = URL.createObjectURL(new Blob([journal.raw], { type: 'application/json' }));
        const link = document.createElement('a'); link.href = url; link.download = `hapi-scratchlist-${source.sourceSessionId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
    };
    return <div className="hapi-note-migration">
        <div className="hapi-button-row"><button type="button" disabled={state.busy} onClick={() => fileRef.current?.click()}>{tr('Import original notes', '导入原有笔记')}</button>
            <input ref={fileRef} hidden type="file" accept=".json,application/json" aria-label={tr('Original HAPI notes JSON', '原 HAPI 笔记 JSON')} onChange={event => {
                const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (!file) return;
                if (journal && completed < journal.rows.length && !window.confirm(tr('Replace the current import preview? Keep its original backup file before continuing.', '替换当前导入预览？继续前请保留它的原始备份文件。'))) return;
                setFileError(undefined);
                if (file.size > 5_000_000) { setFileError(tr('The original notes file exceeds the 5 MB import limit. The current preview is retained.', '原有笔记文件超过 5 MB 导入上限，当前预览已保留。')); return; }
                void file.text().then(raw => controller.prepare(raw)).catch(error => setFileError(error instanceof Error ? error.message : tr('The selected file could not be read.', '无法读取所选文件。')));
            }}/></div>
        {fileError && <p role="alert" className="hapi-error">{fileError}</p>}
        {state.error && <p role="alert" className="hapi-error">{state.error}</p>}
        {journal && !journal.dismissed && <section aria-label={tr('Original notes migration', '原有笔记迁移')}>
            <h3>{tr('Bring your original notes into this conversation', '将原有笔记带入当前会话')}</h3>
            <p>{tr('These notes will be saved to', '这些笔记将保存到')} <code>{source.sourceHubId} / {source.sourceSessionId}</code>.
                {' '}{tr('The original browser cache and file stay available. Notes are never sent as chat messages.', '原浏览器缓存和文件会保留。笔记不会作为聊天消息发送。')}</p>
            <p role="status">{completed} / {journal.rows.length} {tr('resolved', '已处理')}{state.busy ? ` · ${tr('Working…', '处理中…')}` : ''}</p>
            <div className="hapi-button-row"><button type="button" disabled={state.busy || completed === journal.rows.length} onClick={() => { void controller.import().then(onRefresh); }}>{tr('Import remaining notes', '导入剩余笔记')}</button>
                <button type="button" disabled={state.busy} onClick={() => { void controller.inspect().then(onRefresh); }}>{tr('Check saved notes', '检查已保存笔记')}</button>
                <button type="button" onClick={backup}>{tr('Download original backup', '下载原始备份')}</button>
                {completed === journal.rows.length && <button type="button" onClick={() => controller.dismiss()}>{tr('Dismiss import summary', '关闭导入摘要')}</button>}</div>
            {journal.issues.length > 0 && <div role="alert"><p>{tr('Some entries need manual repair; their original contents remain in the backup.', '部分条目需要手动修复，原始内容完整保留在备份中。')}</p><ul>{journal.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul></div>}
            <ol className="hapi-source-notes">{journal.rows.filter(row => !['saved', 'kept'].includes(row.state)).map(row => <li key={row.original.id}>
                <p className="hapi-source-note-text">{row.original.text}</p><small>{new Date(row.original.createdAt).toLocaleString()} · {row.state}</small>
                <ul>{row.original.attachments.map(file => <li key={file.id}>{file.filename}</li>)}</ul>
                {row.error && <p role="alert" className="hapi-error">{row.error}</p>}
                {row.state === 'conflict' && <><details><summary>{tr('Compare existing Hub version', '对比 Hub 中已有的版本')}</summary>
                    <p className="hapi-source-note-text">{row.sourceVersion?.text}</p><ul>{row.sourceVersion?.attachments.map(file => <li key={file.id}>{file.filename}</li>)}</ul></details>
                    <div className="hapi-button-row"><button type="button" disabled={state.busy} onClick={() => controller.resolve(row.original.id, 'separate')}>{tr('Keep both as separate notes', '作为独立笔记保留两份')}</button>
                        <button type="button" disabled={state.busy} onClick={() => controller.resolve(row.original.id, 'keep-source')}>{tr('Use Hub version; keep local backup', '使用 Hub 版本，保留本地备份')}</button></div></>}
            </li>)}</ol>
        </section>}
    </div>;
}
