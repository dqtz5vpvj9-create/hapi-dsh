/** Compatibility view for imported HAPI schemaVersion 2 SessionTerminal IDs.
 * New Files, documents and terminals use unchanged official DSH plugin views.
 * This component preserves the original session-scoped protocol and detach
 * lifetime; it never adopts the old ID as a new machine TerminalHost shell. */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import xtermCss from '@xterm/xterm/css/xterm.css?text';
import { WORKBENCH_TERMINAL_PATH, terminalServerFrameSchema, type WorkbenchSource } from '../workbench-types.ts';
import { TerminalOutputTracker } from './workbench-model.ts';
import { workbenchTranslator, type WorkbenchLanguage } from './workbench-locales.ts';
import { LegacyTerminalInputControls } from './legacy-terminal-input.ts';
import { TouchBar } from './source-terminal/TouchBar.tsx';
import { KeyEditor } from './source-terminal/KeyEditor.tsx';
import { TerminalDialog } from './source-terminal/dialog.tsx';
import { TerminalPreferences } from './source-terminal/preferences.ts';
import { BUILTIN_KEYS } from './source-terminal/keyCatalog.ts';
import { en, zh, type TerminalTranslate } from './source-terminal/locales.ts';
import { terminalStyles } from './source-terminal/styles.ts';
import { copyTerminalText } from './source-terminal/clipboard.ts';
import { createWorkspaceUiPreferences, type WorkspaceUiPreferences } from './ui-preferences.ts';
import { readAppearance } from './appearance/preferences.ts';

export interface LegacySessionTerminalProps {
    resource: { kind: 'terminal'; sessionId: string; terminalId: string; sourceSessionId?: string; sourceHubId?: string };
    sourceSessionId: string | null;
    sourceHubId?: string;
    focused: boolean;
    visible: boolean;
    language?: WorkbenchLanguage;
    preferences?: WorkspaceUiPreferences | undefined;
}
const css = `
.hapi-workbench{display:flex;flex-direction:column;width:100%;height:100%;min-height:0;min-width:0;color:var(--hapi-fg,var(--dsw-alias-label-primary,#22272c));background:var(--hapi-bg,var(--dsw-alias-bg-layer-1,#fff));font:13px/1.5 system-ui,sans-serif;overflow:hidden}
.hapi-workbench *{box-sizing:border-box}.hapi-workbench button{font:inherit;color:inherit;background:var(--hapi-muted,var(--dsw-alias-bg-layer-2,#f6f7f8));border:1px solid var(--hapi-border,#d8dedf);border-radius:5px;padding:5px 8px;cursor:pointer}.hapi-workbench button:hover:not(:disabled){background:var(--hapi-hover,#eef2f1)}.hapi-workbench button:disabled{opacity:.45;cursor:default}
.hapi-wb-toolbar{display:flex;align-items:center;gap:6px;padding:8px;border-bottom:1px solid var(--hapi-border,#d8dedf);flex-wrap:wrap;flex:none}.hapi-wb-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}.hapi-wb-error{padding:8px 12px;white-space:pre-wrap;overflow-wrap:anywhere;background:color-mix(in srgb,var(--hapi-danger,#d75c5c) 10%,transparent);color:var(--hapi-danger,#b53232);border-bottom:1px solid var(--hapi-border,#d8dedf)}.hapi-wb-path{padding:5px 10px;overflow-wrap:anywhere;font:11px/1.5 ui-monospace,monospace;opacity:.7}.hapi-wb-terminal{flex:1;min-height:0;padding:6px;background:#101317;overflow:hidden}.hapi-wb-terminal .xterm{height:100%}
`;
function Styles(): JSX.Element { return <style>{xtermCss + css + terminalStyles}</style>; }
function message(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message;
    return 'The source operation could not be completed.';
}
function url(path: string): string { return new URL(path.replace(/^\//, ''), document.baseURI).href; }
function useSource(sourceSessionId: string, sourceHubId?: string): WorkbenchSource {
    return useMemo(() => ({ sourceSessionId, ...(sourceHubId === undefined ? {} : { sourceHubId }) }), [sourceSessionId, sourceHubId]);
}

export function LegacySessionTerminal(props: LegacySessionTerminalProps): JSX.Element {
    const t = workbenchTranslator(props.language), sourceId = props.sourceSessionId ?? props.resource.sourceSessionId;
    if (!sourceId) return <div className="hapi-workbench"><Styles/><div className="hapi-wb-error">{t('This pane has no verified native source session. Restore its source identity before opening the resource.')}</div></div>;
    const sourceHubId = props.sourceHubId ?? props.resource.sourceHubId;
    return <NativeTerminal key={`${sourceHubId ?? ''}/${sourceId}/${props.resource.terminalId}`} sourceSessionId={sourceId} {...(sourceHubId === undefined ? {} : { sourceHubId })} terminalId={props.resource.terminalId} focused={props.focused} visible={props.visible} language={props.language ?? 'en'} preferences={props.preferences}/>;
}

function NativeTerminal({ sourceSessionId, sourceHubId, terminalId, focused, visible, language, preferences: sharedPreferences }: { sourceSessionId: string; sourceHubId?: string; terminalId: string; focused: boolean; visible: boolean; language: WorkbenchLanguage; preferences?: WorkspaceUiPreferences | undefined }): JSX.Element {
    const t = workbenchTranslator(language);
    const tr: TerminalTranslate = key => (language === 'zh' ? zh : en)[key];
    const source = useSource(sourceSessionId, sourceHubId);
    const surface = useRef<HTMLDivElement>(null);
    const terminal = useRef<Terminal | null>(null);
    const fit = useRef<FitAddon | null>(null);
    const reconnect = useRef<(() => void) | null>(null);
    const sendInput = useRef<((data: string) => boolean) | null>(null), sendResize = useRef<(() => void) | null>(null);
    const readyForInput = useRef(false), visibleRef = useRef(visible); visibleRef.current = visible;
    const [writable, setWritable] = useState(false);
    const controls = useMemo(() => new LegacyTerminalInputControls({
        writable: () => readyForInput.current && visibleRef.current,
        applicationCursor: () => terminal.current?.modes.applicationCursorKeysMode ?? false,
        bracketedPaste: () => terminal.current?.modes.bracketedPasteMode ?? false,
        write: data => sendInput.current?.(data) ?? false,
    }), []);
    const keyboard = useSyncExternalStore(controls.subscribe, controls.getSnapshot);
    const storage = useMemo(() => {
        if (sharedPreferences) return { value: sharedPreferences, dispose() {} };
        let local: Storage | undefined; try { local = window.localStorage; } catch { /* Retain an unsaved view rather than exposing a different source. */ }
        const value = createWorkspaceUiPreferences(local, window); return { value, dispose: () => value.dispose() };
    }, [sharedPreferences]);
    const preferences = useMemo(() => new TerminalPreferences(storage.value), [storage]);
    const saved = useSyncExternalStore(preferences.subscribe, preferences.getSnapshot);
    const baseFont = useSyncExternalStore(storage.value.subscribe, () => { const appearance = readAppearance(storage.value); return appearance.enabled ? appearance.terminalFont ?? 13 : 13; });
    // Shared HAPI appearance owns the base. View zoom, like the official
    // terminal's pinch zoom, is local and resets when that base changes.
    const [zoom, setZoom] = useState<{ base: number; size: number } | null>(null);
    const fontSize = zoom?.base === baseFont ? zoom.size : baseFont;
    const [status, setStatus] = useState('Connecting to the owning Runner…');
    const [error, setError] = useState('');
    const commandInput = useRef<HTMLInputElement>(null), copyText = useRef<HTMLPreElement>(null);
    const alive = useRef(true), [customize, setCustomize] = useState(false), [more, setMore] = useState(false), [snippets, setSnippets] = useState(false);
    const [commandMode, setCommandMode] = useState(false), [command, setCommand] = useState(''), [paste, setPaste] = useState<string | null>(null), [copy, setCopy] = useState<string | null>(null);
    const focus = (): void => { if (visibleRef.current) terminal.current?.focus(); };
    const blur = (): void => { terminal.current?.blur(); };
    useEffect(() => { alive.current = true; return () => { alive.current = false; controls.dispose(); }; }, [controls]);
    useEffect(() => () => { preferences.dispose(); storage.dispose(); }, [preferences, storage]);
    useLayoutEffect(() => {
        if (!surface.current) return;
        const term = new Terminal({ cursorBlink: true, fontSize, scrollback: 10_000, allowProposedApi: false });
        const addon = new FitAddon(); term.loadAddon(addon); term.open(surface.current); terminal.current = term; fit.current = addon;
        const tracker = new TerminalOutputTracker();
        let socket: WebSocket | null = null;
        let disposed = false;
        let retry: ReturnType<typeof setTimeout> | undefined;
        let retryDelay = 1000;
        let ready = false;
        let exited = false;
        let parsing = 0;
        const updateWritable = (): void => {
            const value = !disposed && !exited && ready && Boolean(tracker.cursor) && !tracker.blocked && parsing === 0 && socket?.readyState === WebSocket.OPEN;
            readyForInput.current = value; setWritable(value);
            // Parsing an ordinary output chunk is a temporary admission gate,
            // not a disconnection. Sticky modifiers survive source output.
            if (disposed || exited || !ready || tracker.blocked || socket?.readyState !== WebSocket.OPEN) controls.clear();
        };
        const resizeSource = (): void => { if (socket?.readyState === WebSocket.OPEN && ready && tracker.cursor && !tracker.blocked) socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })); };
        sendResize.current = resizeSource;
        const fitNow = (): void => { if (!disposed && surface.current && surface.current.clientWidth > 0 && surface.current.clientHeight > 0) { addon.fit(); resizeSource(); } };
        const theme = (): void => {
            if (!surface.current || disposed) return;
            const styles = getComputedStyle(surface.current);
            term.options.theme = { background: styles.getPropertyValue('--hapi-bg').trim() || '#fff', foreground: styles.getPropertyValue('--hapi-fg').trim() || '#22272c', cursor: styles.getPropertyValue('--hapi-accent').trim() || '#359b6c' };
        };
        theme();
        const themeObserver = new MutationObserver(theme); themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
        const open = (): void => {
            if (disposed || exited) return;
            ready = false; tracker.reconnect(); updateWritable(); setStatus('Connecting to the owning Runner…');
            const endpoint = new URL(url(WORKBENCH_TERMINAL_PATH)); endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
            const next = new WebSocket(endpoint); socket = next;
            next.onopen = () => { if (disposed) { next.close(); return; } fitNow(); next.send(JSON.stringify({ type: 'open', source, terminalId, cols: term.cols, rows: term.rows, ...(tracker.cursor === undefined ? {} : { outputCursor: tracker.cursor }) })); };
            next.onmessage = event => {
                let data: unknown; try { data = JSON.parse(String(event.data)); } catch { setError('Invalid terminal transport response.'); next.close(); return; }
                const result = terminalServerFrameSchema.safeParse(data);
                if (!result.success) { setError('Incompatible terminal transport response.'); next.close(); return; }
                const frame = result.data;
                if (frame.type === 'output') {
                    tracker.receive(frame.data, frame.stream, output => { if (disposed) return false; parsing++; term.write(output, () => { parsing--; if (!disposed) updateWritable(); }); return true; });
                    updateWritable();
                    if (tracker.blocked) { setError('Terminal output has a gap or incompatible replay. Reload the view before typing.'); setStatus('Input paused'); }
                    else if (tracker.issue === 'truncated') setStatus('Connected · earlier scrollback was trimmed by the source');
                    else if (ready && tracker.cursor) setStatus('Connected to source terminal');
                } else if (frame.type === 'ready') {
                    if (frame.replayProtocol !== 1) { ready = false; updateWritable(); setError('This source does not support the required terminal replay protocol.'); return; }
                    ready = true; retryDelay = 1000;
                    if (!tracker.blocked) { setError(''); setStatus(tracker.cursor ? 'Connected to source terminal' : 'Waiting for source replay…'); resizeSource(); }
                    updateWritable();
                } else if (frame.type === 'exit') { ready = false; exited = true; updateWritable(); setStatus(`Terminal exited${frame.code === null ? '' : ` (${frame.code})`}${frame.signal ? ` · ${frame.signal}` : ''}`); }
                else { setError(frame.message); if (frame.code !== 'input-not-delivered') ready = false; updateWritable(); }
            };
            next.onerror = () => { if (!disposed) setStatus('Terminal transport unavailable'); };
            next.onclose = () => {
                if (socket !== next || disposed || exited) return;
                ready = false; updateWritable(); setStatus('Disconnected · reconnecting from accepted output');
                retry = setTimeout(open, retryDelay); retryDelay = Math.min(5000, retryDelay * 2);
            };
        };
        reconnect.current = () => { if (retry) clearTimeout(retry); const previous = socket; socket = null; previous?.close(); tracker.reset(); term.reset(); ready = false; exited = false; setError(''); open(); };
        const deliverInput = (data: string): boolean => {
            if (!socket || socket.readyState !== WebSocket.OPEN || !readyForInput.current || !visibleRef.current) { setError('Input was not delivered. Wait for the source terminal and replay to be ready.'); return false; }
            if (socket.bufferedAmount > 128 * 1024) { setError('Input was not delivered because the terminal transport is backlogged.'); return false; }
            try { for (let offset = 0; offset < data.length; offset += 65_536) socket.send(JSON.stringify({ type: 'write', data: data.slice(offset, offset + 65_536) })); return true; }
            catch (failure) { setError(`Terminal input delivery is uncertain; it has not been replayed. ${message(failure)}`); return false; }
        };
        sendInput.current = deliverInput;
        const input = term.onData(data => { controls.type(data); });
        const resize = new ResizeObserver(fitNow); resize.observe(surface.current); open();
        return () => { disposed = true; readyForInput.current = false; controls.clear(); if (retry) clearTimeout(retry); reconnect.current = null; sendInput.current = null; sendResize.current = null; themeObserver.disconnect(); resize.disconnect(); input.dispose(); socket?.close(); term.dispose(); terminal.current = null; fit.current = null; };
    }, [source, terminalId, controls]);
    useEffect(() => { if (visible) { fit.current?.fit(); sendResize.current?.(); if (focused) focus(); } else controls.clear(); }, [visible, focused, controls]);
    useEffect(() => { if (terminal.current) { terminal.current.options.fontSize = fontSize; fit.current?.fit(); sendResize.current?.(); } }, [fontSize]);
    const readPaste = (): void => {
        if (!controls.writable) return;
        if (!navigator.clipboard?.readText) { setPaste(''); blur(); return; }
        void navigator.clipboard.readText().then(text => { if (alive.current && controls.paste(text)) focus(); }).catch(() => { if (alive.current) { setPaste(''); blur(); } });
    };
    const snippetsKeys = saved.keys.filter(key => key.row === 0 && key.send || key.id.startsWith('custom-') && key.send);
    return <div className="hapi-workbench" aria-label={t("Native terminal")} data-hapi-legacy-terminal={terminalId} data-terminal-font={fontSize}><Styles />
        <div className="hapi-wb-toolbar"><span className="hapi-wb-title" role="status">{t(status)}</span><button aria-label={t('Zoom out')} onClick={() => setZoom({ base: baseFont, size: Math.max(9, fontSize - 1) })}>A−</button><button aria-label={t('Zoom in')} onClick={() => setZoom({ base: baseFont, size: Math.min(28, fontSize + 1) })}>A+</button><button onClick={() => reconnect.current?.()}>{t("Reload terminal view")}</button></div>
        {error && <div className="hapi-wb-error" role="alert">{t(error)}</div>}<div className="hapi-wb-terminal" ref={surface} />
        {commandMode && <form className="hapi-terminal-command" onSubmit={event => { event.preventDefault(); if (controls.command(command)) setCommand(''); }}>
            <input ref={commandInput} aria-label={tr('terminal.command.inputLabel')} placeholder={tr('terminal.command.placeholder')} value={command} onChange={event => setCommand(event.currentTarget.value)} autoCapitalize="none" autoComplete="off" autoCorrect="off" spellCheck={false}/>
            <button type="submit" disabled={!writable || !visible || !command}>{tr('terminal.command.run')}</button></form>}
        <TouchBar t={tr} keys={saved.keys} settings={saved.settings} disabled={!writable || !visible} readOnlyActionsAvailable={visible} modifiers={keyboard.modifiers} lockedModifiers={keyboard.locked}
            onToggleModifier={modifier => controls.toggle(modifier)} onLockModifier={modifier => controls.toggle(modifier, true)}
            onPress={data => { controls.press(data); }} resolveSequence={data => controls.resolve(data)} onRepeat={data => { controls.repeat(data); }} onResetModifiers={() => {}}
            onSnippets={() => { setSnippets(true); blur(); }} onMoreKeys={() => { setMore(true); blur(); }} onCustomize={() => { setCustomize(true); blur(); }}
            commandMode={commandMode} onCommand={() => { setCommandMode(value => !value); blur(); setTimeout(() => commandInput.current?.focus(), 0); }}
            onCopy={() => { setCopy(terminal.current?.getSelection() ?? ''); blur(); }} onPaste={readPaste}
            onKeyboard={() => { if (commandMode) setCommandMode(false); const input = terminal.current?.textarea; if (input === document.activeElement) blur(); else focus(); }}/>
        {saved.error && <p className="hapi-terminal-preference-error" role="alert">{saved.error}</p>}
        <KeyEditor t={tr} error={saved.error} open={customize} keys={saved.keys} settings={saved.settings} onChange={keys => { preferences.updateKeys(keys); }} onSettingsChange={settings => { preferences.updateSettings(settings); }} onClose={() => { setCustomize(false); focus(); }}/>
        <TerminalDialog open={more} title={tr('terminal.keys.more')} closeLabel={tr('button.close')} onClose={() => { setMore(false); focus(); }}>
            <div className="hapi-terminal-more">{BUILTIN_KEYS.filter(key => key.send && !saved.keys.some(saved => saved.row !== 0 && saved.send === key.send && !saved.action && !saved.modifier)).map(key =>
                <button type="button" key={key.id} disabled={!writable || !visible} onClick={() => { controls.press(key.send); }}>{key.label}</button>)}</div>
        </TerminalDialog>
        <TerminalDialog open={snippets} title={tr('terminal.keys.snippets')} closeLabel={tr('button.close')} onClose={() => { setSnippets(false); focus(); }}>
            <div className="hapi-terminal-more">{snippetsKeys.length ? snippetsKeys.map(key => <button type="button" key={key.id} disabled={!writable || !visible} onClick={() => { if (controls.press(key.send)) { setSnippets(false); focus(); } }}>{key.label}</button>) : <p>{tr('terminal.keys.emptySnippets')}</p>}</div>
            <button type="button" onClick={() => { setSnippets(false); setCustomize(true); }}>{tr('terminal.keys.edit')}</button>
        </TerminalDialog>
        <TerminalDialog open={copy !== null} title={tr('terminal.copy.title')} closeLabel={tr('button.close')} onClose={() => { setCopy(null); focus(); }}>
            <p>{t('Copy selection')}</p><pre ref={copyText} tabIndex={0} aria-label={tr('terminal.copy.textLabel')}>{copy ?? ''}</pre>
            <button type="button" disabled={!copy} onClick={() => { if (copy && copyText.current) void copyTerminalText(copy, copyText.current).then(ok => { if (!ok && alive.current) setError(tr('terminal.copy.failed')); }); }}>{tr('button.copy')}</button>
        </TerminalDialog>
        <TerminalDialog open={paste !== null} title={tr('terminal.paste.fallbackTitle')} description={tr('terminal.paste.fallbackDescription')} closeLabel={tr('button.close')} onClose={() => { setPaste(null); focus(); }}>
            <textarea aria-label={tr('terminal.paste.fallbackTitle')} placeholder={tr('terminal.paste.placeholder')} value={paste ?? ''} onChange={event => setPaste(event.currentTarget.value)} autoCapitalize="none" autoCorrect="off" spellCheck={false}/>
            <button type="button" disabled={!writable || !visible || !paste} onClick={() => { if (paste && controls.paste(paste)) { setPaste(null); focus(); } }}>{tr('button.paste')}</button>
        </TerminalDialog>
        <div className="hapi-wb-path">{t("Closing this pane detaches the view. The source terminal follows HAPI’s existing lifetime policy.")}</div></div>;
}
