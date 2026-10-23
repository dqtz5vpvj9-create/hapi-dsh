/** Voice SDKs are loaded on demand through the official package-local chunk API. */
import { useMemo, useState, useSyncExternalStore } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type {} from '@deepseek-ai/dsh-client-ui-settings/client';
import type { HapiRemoteApi } from '../../client-api.ts';
import type { WorkspaceUiScope } from '../workspace-ui.ts';
import type {} from '../workspace-ui.ts';
import { SourceVoiceTransport } from './transport.ts';
import { VoiceCatalog } from './catalog.ts';
import { VoiceCredentialsPanel, VoicePreferencesPanel, words } from './settings.tsx';
import { useWorkspacePane } from '../surface/pane-context.tsx';
import { loadVoiceComposer } from '../client-chunks.ts';
import type { VoiceComposer as VoiceComposerComponent } from './composer.tsx';
type ComposerProps = PropsRuntime<'conversation.input.left'>;

function VoiceComposer(props: Parameters<typeof VoiceComposerComponent>[0]) {
    const [Loaded, setLoaded] = useState<typeof VoiceComposerComponent | null>(null);
    const [busy, setBusy] = useState(false), [error, setError] = useState<string>();
    if (Loaded) return <Loaded {...props} initialOpen/>;
    const label = words(props.language)('Voice and dictation', '语音与听写');
    return <div className="hapi-voice-seat"><button type="button" className="hapi-voice-trigger" aria-haspopup="dialog"
        aria-label={label} title={error ?? label} aria-busy={busy} disabled={busy}
        onMouseDown={event => event.preventDefault()} onClick={() => {
            setBusy(true); setError(undefined);
            void loadVoiceComposer().then(module => setLoaded(() => module.VoiceComposer))
                .catch(reason => setError(String(reason))).finally(() => setBusy(false));
        }}>
        <svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true"><rect x="7" y="2" width="6" height="10" rx="3" fill="none" stroke="currentColor" strokeWidth="1.5"/><path d="M4.5 9a5.5 5.5 0 0 0 11 0M10 14.5V18M6.5 18h7" fill="none" stroke="currentColor" strokeWidth="1.5"/></svg>
    </button></div>;
}

function installVoiceSeats(ctx: Context, api: HapiRemoteApi, shared: WorkspaceUiScope): () => void {
    const transport = new SourceVoiceTransport(api), catalog = new VoiceCatalog(api), disposers: Array<() => void> = [];
    const language = () => ctx.locale.getSnapshot().active;
    const Composer = (props: ComposerProps) => {
        const lang = useSyncExternalStore(listener => ctx.locale.subscribe(listener), language);
        const ui = useWorkspacePane(ctx) ?? shared;
        const native = props.useProjection('hapi'), observed = props.useProjection('hapiObserved'), projection = native ?? observed;
        const source = useMemo(() => projection ? { sourceSessionId: projection.hapiSessionId, sourceHubId: projection.hubId,
            ...(projection.machineId ? { machineId: projection.machineId } : {}) } : null, [projection?.hapiSessionId, projection?.hubId, projection?.machineId]);
        const binding = ctx.sessions.binding(props.sessionId);
        if (!binding || observed?.sidechain) return null;
        return <VoiceComposer key={props.sessionId} ctx={ctx} api={api} transport={transport} catalog={catalog} ui={ui} language={lang}
            binding={binding} source={source} composer={props} readOnly={Boolean(projection?.readOnly)}/>;
    };
    const Settings = (_props: PropsRuntime<'settings.section'>) => {
        const lang = useSyncExternalStore(listener => ctx.locale.subscribe(listener), language);
        const ui = useWorkspacePane(ctx) ?? shared;
        return <section className="hapi-voice-settings" aria-label={words(lang)('Voice and dictation settings', '语音与听写设置')}><h2>{words(lang)('Voice and dictation', '语音与听写')}</h2>
            <VoicePreferencesPanel api={api} store={ui.preferences} catalog={catalog} language={lang}/><VoiceCredentialsPanel api={api} catalog={catalog} language={lang}/></section>;
    };
    disposers.push(ctx.slots.inject('conversation.input.left', () => ctx.slots.register({ name: 'conversation.input.left', id: 'hapi-dsh/voice', order: 85 }, Composer)));
    disposers.push(ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'hapi-voice', order: 36, label: () => words(language())('Voice and dictation', '语音与听写') }, Settings)));
    const style = document.createElement('style'); style.textContent = styles; document.head.append(style);
    return () => { for (const dispose of disposers.reverse()) dispose(); catalog.dispose(); style.remove(); };
}

export function installSourceVoice(ctx: Context, api: HapiRemoteApi): () => void {
    // A graph may not invent a temporary independent microphone coordinator
    // while the shared workspace capability is still starting.
    const scope = ctx.inject(['hapiWorkspaceUi', 'uiSession'], owner => installVoiceSeats(owner, api, owner.hapiWorkspaceUi));
    return () => { void scope.dispose(); };
}

const styles = `
.hapi-voice-seat{display:inline-flex;align-items:center}.hapi-voice-trigger{display:inline-flex;align-items:center;gap:4px;border:0;background:transparent;color:inherit;padding:5px;border-radius:6px;cursor:pointer;font:inherit;font-size:11px}.hapi-voice-live{color:var(--text-link,#537dce);background:color-mix(in srgb,currentColor 12%,transparent)}
.hapi-voice-dialog{color:var(--text-primary,inherit);background:var(--bg-primary,Canvas);border:1px solid var(--border-secondary,#8886);border-radius:14px;width:min(680px,calc(100vw - 24px));max-height:calc(100dvh - 32px);padding:0;box-sizing:border-box;box-shadow:0 16px 70px #0005}.hapi-voice-dialog::backdrop{background:#0006}.hapi-voice-dialog>header{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid var(--border-secondary,#8885);position:sticky;top:0;background:var(--bg-primary,Canvas);z-index:1}.hapi-voice-dialog h2,.hapi-voice-settings h2{font-size:18px;margin:0}.hapi-voice-dialog>header button{border:0;background:transparent;font-size:24px;padding:2px 8px;color:inherit;cursor:pointer}.hapi-voice-body{padding:16px 18px;font-size:14px;line-height:1.5}
.hapi-voice-settings{font-size:14px;line-height:1.5;color:inherit}.hapi-voice-settings h3{font-size:15px;margin:22px 0 10px}.hapi-voice-settings h4{font-size:14px;margin:14px 0 8px}.hapi-voice-body label,.hapi-voice-settings label{display:grid;gap:5px;margin:10px 0}.hapi-voice-body input:not([type=checkbox]):not([type=range]),.hapi-voice-body textarea,.hapi-voice-body select,.hapi-voice-settings input:not([type=checkbox]):not([type=range]),.hapi-voice-settings textarea,.hapi-voice-settings select{width:100%;min-width:0;box-sizing:border-box;font:inherit;color:inherit;background:var(--bg-input,transparent);border:1px solid var(--border-secondary,#8886);border-radius:6px;padding:8px}.hapi-voice-body textarea,.hapi-voice-settings textarea{resize:vertical}.hapi-voice-body button,.hapi-voice-settings button{color:inherit;background:var(--bg-secondary,transparent);border:1px solid var(--border-secondary,#8886);border-radius:6px;padding:6px 10px;font:inherit;cursor:pointer}.hapi-voice-body button:disabled,.hapi-voice-settings button:disabled{opacity:.5;cursor:default}.hapi-voice-body button[aria-pressed=true]{border-color:var(--text-link,#537dce);background:color-mix(in srgb,var(--text-link,#537dce) 12%,transparent)}
.hapi-voice-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:10px 0}.hapi-voice-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 14px}.hapi-voice-settings fieldset{border:0;margin:0;padding:0;min-width:0}.hapi-voice-settings .hapi-voice-check{display:flex;align-items:center;gap:8px}.hapi-voice-settings small,.hapi-voice-body small{opacity:.72}.hapi-voice-settings details,.hapi-voice-body details{margin:12px 0}.hapi-voice-settings summary,.hapi-voice-body summary{cursor:pointer}.hapi-voice-settings pre,.hapi-voice-body pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:280px;overflow:auto;font-size:12px}.hapi-voice-secret{border-bottom:1px solid var(--border-secondary,#8884);padding:6px 0 10px}.hapi-voice-credentials{border-top:1px solid var(--border-secondary,#8885);margin-top:20px;padding-top:5px}.hapi-voice-settings audio{max-width:100%;height:34px}.hapi-voice-error{color:var(--text-error,#d45d62);overflow-wrap:anywhere}.hapi-voice-warning{border:1px solid var(--border-secondary,#8886);border-radius:8px;padding:10px}.hapi-voice-session{font-size:12px;opacity:.75;margin:0 0 12px;overflow-wrap:anywhere}.hapi-voice-caption{border-left:3px solid var(--text-link,#537dce);padding:8px 12px;white-space:pre-wrap}.hapi-voice-body article{margin:10px 0;padding:10px;border:1px solid var(--border-secondary,#8884);border-radius:7px;font-size:12px}.hapi-voice-body code{overflow-wrap:anywhere}.hapi-voice-transcript{border:1px solid var(--border-secondary,#8885);padding:10px;border-radius:7px}
@media(max-width:540px){.hapi-voice-grid{grid-template-columns:1fr}.hapi-voice-dialog{max-height:calc(100dvh - 12px);width:calc(100vw - 12px);border-radius:10px}.hapi-voice-body{padding:12px}.hapi-voice-body button,.hapi-voice-settings button{min-height:36px}.hapi-voice-settings input,.hapi-voice-settings select,.hapi-voice-settings textarea{font-size:16px!important}}
`;
