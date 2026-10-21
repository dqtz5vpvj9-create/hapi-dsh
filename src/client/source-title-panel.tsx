import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { SourcePanelProps } from './session-extras.tsx';
import { SourceTitleController } from './source-title.ts';

function storage(): Storage | undefined { try { return window.localStorage; } catch { return undefined; } }
export function SourceTitlePanel({ api, source, active, language, onRename }: SourcePanelProps & { onRename(title: string): Promise<void> }) {
    const tr = (en: string, zh: string): string => language?.startsWith('zh') ? zh : en;
    const controller = useMemo(() => new SourceTitleController(api, source, onRename, storage()), [api, source.sourceHubId, source.sourceSessionId, source.machineId]);
    const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
    useEffect(() => { if (active) void controller.refresh(); }, [active, controller]);
    return <section aria-label={tr('Conversation title', '会话标题')}>
        <h3>{tr('Conversation title', '会话标题')}</h3>
        <form onSubmit={event => { event.preventDefault(); void controller.apply(); }}>
            <label>{tr('Title', '标题')}<input maxLength={255} value={state.draft?.title ?? state.data?.title ?? ''} disabled={state.busy || state.draft?.pending}
                onChange={event => controller.setTitle(event.currentTarget.value)}/></label>
            <div className="hapi-button-row">
                <button type="submit" disabled={state.busy || !state.draft?.title.trim()}>{state.draft?.pending ? tr('Retry this title update', '重试这次标题修改') : tr('Save title', '保存标题')}</button>
                {state.data?.suggestionAvailable && <button type="button" disabled={state.busy || state.draft?.pending} onClick={() => { void controller.suggest(); }}>{tr('Suggest a title', '建议标题')}</button>}
                <button type="button" disabled={state.busy} onClick={() => { void controller.refresh(); }}>{tr('Check source title', '查看原会话标题')}</button>
            </div>
        </form>
        {state.busy && <p role="status">{tr('Working…', '处理中…')}</p>}
        {state.draft?.pending && <p role="status">{tr('The previous update has not been confirmed. Refreshing checks the original title without sending another update.', '上次修改尚未确认，刷新只查看原会话标题，不会再次修改。')}</p>}
        {state.status !== 'idle' && <p role="status">{state.status === 'confirmed' ? tr('Title saved by the original Hub.', '原 Hub 已保存标题。') : tr('The requested title is now visible on the original Hub.', '已在原 Hub 中看到请求的标题。')}</p>}
        {state.error && <p role="alert" className="hapi-error">{state.error}</p>}
    </section>;
}
