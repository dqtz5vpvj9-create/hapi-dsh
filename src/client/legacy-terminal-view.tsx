/** Original HAPI SessionTerminal transport behind the unchanged official DSH
 * TerminalBody/TerminalTitle and real ClientTerminals.view model. */
import { createElement, useEffect, useMemo, useState, useSyncExternalStore, type ComponentType, type ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { ClientTerminals, type TerminalView, type TerminalViewState } from '@deepseek-ai/dsh-api-terminal-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { HostObservable, InjectFace, PropsRuntime, StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import type { ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client'
import type { TabId } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { HapiRemoteApi } from '../client-api.ts'
import type { LegacyTerminalState } from '../legacy-terminal-types.ts'
import type { WorkbenchSource } from '../workbench-types.ts'
import { legacyTerminalRemote, legacyTerminalSource, LegacyTerminalViews, type LegacyTerminalOccurrence, type LegacyTerminalViewState } from './legacy-terminal-client.ts'
import { LEGACY_TERMINAL_SEAT_ID, LEGACY_TERMINAL_TAB_KIND, canOpenLegacyTerminalAddress, legacyTerminalNavigationParams } from './legacy-session-terminal.tsx'
import { composedTerminalBody, hasTerminalControls, type TerminalBodyFace, type TerminalViewAccessoryState } from './source-terminal/view.tsx'
import { en, zh, type TerminalTranslate } from './source-terminal/locales.ts'
import { readLegacyTerminalCopy } from './source-terminal/snapshot.ts'
import { terminalTheme } from './appearance/terminal-theme.ts'
import { OFFICIAL_TERMINAL_SEAT } from './source-terminal-actions.tsx'
import { followLegacyTerminalSeat } from './legacy-terminal-slots.ts'

export { LEGACY_TERMINAL_SEAT_ID, LEGACY_TERMINAL_TAB_KIND } from './legacy-session-terminal.tsx'
export type { LegacyTerminalOccurrence, LegacyTerminalViewState } from './legacy-terminal-client.ts'
export { legacyTerminalSource } from './legacy-terminal-client.ts'

/** Public renderer capability for plugins deliberately supporting this kind.
 * `view` is the official model, never a replacement terminal implementation. */
export interface LegacyTerminalInjected {
    view(key: string): TerminalView
    legacyTerminal(key: string): LegacyTerminalOccurrence
    readonly keyedHooks: {
        terminal(key: string): HostObservable<TerminalViewState>
        legacyTerminal(key: string): HostObservable<LegacyTerminalViewState>
    }
    readonly hooks: { theme: HostObservable<ThemeSnapshot> }
}
export type LegacyTerminalBodyProps = PropsRuntime<'sidebar.right.pane.tab'> & InjectFace<LegacyTerminalInjected>
export type LegacyTerminalTitleProps = PropsRuntime<'sidebar.right.pane.tab.title'> & InjectFace<LegacyTerminalInjected>

declare module '@deepseek-ai/cordis' { interface Context { hapiLegacyTerminalViews: LegacyTerminalViews } }

const styles = `
.hapi-legacy-terminal{display:flex;flex-direction:column;min-height:0;height:100%;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1)}
.hapi-legacy-terminal>.hapi-terminal-composed{flex:1;min-height:0}
.hapi-legacy-terminal-toolbar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:5px 8px;border-bottom:1px solid var(--dsw-alias-border-l2,#ddd);font-size:11px;flex:none}
.hapi-legacy-terminal-toolbar>[role=status]{flex:1;min-width:90px;overflow-wrap:anywhere}.hapi-legacy-terminal-toolbar button,.hapi-legacy-terminal-loading button{font:inherit;color:inherit;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2,#ddd);border-radius:5px;padding:4px 7px;cursor:pointer}.hapi-legacy-terminal-toolbar button:disabled{opacity:.5;cursor:default}
.hapi-legacy-terminal-compat{flex:none;font-size:11px;line-height:1.5;padding:4px 8px;border-top:1px solid var(--dsw-alias-border-l2,#ddd);max-height:35%;overflow:auto}.hapi-legacy-terminal-compat summary{cursor:pointer}.hapi-legacy-terminal-compat p{margin:5px 0;overflow-wrap:anywhere}.hapi-legacy-terminal-compat dl{display:grid;grid-template-columns:auto minmax(0,1fr);gap:3px 10px;margin:6px 0}.hapi-legacy-terminal-compat dd{margin:0;overflow-wrap:anywhere}.hapi-legacy-terminal-loading{padding:12px;font-size:12px;overflow-wrap:anywhere}.hapi-legacy-terminal [role=alert]{color:var(--dsw-alias-state-error-primary,#b53232);overflow-wrap:anywhere}
`

function LegacyToolbar({ accessory, source, pending, reload, language }: {
    accessory: TerminalViewAccessoryState; source: LegacyTerminalState; pending: boolean; reload(): Promise<void>; language: string
}) {
    const tr = (en: string, zh: string) => language.startsWith('zh') ? zh : en
    const { state } = accessory
    const status = state.phase === 'connected' && source.phase === 'ready'
        ? tr('Connected to source terminal', '已连接源终端')
        : source.phase === 'exited' ? tr('Source terminal exited', '源终端已退出')
            : pending ? tr('Reloading source replay…', '正在重新读取源回放…')
                : `${tr('Source terminal', '源终端')} · ${state.phase}`
    return <div className="hapi-legacy-terminal-toolbar"><span role="status">{status}</span>
        <button type="button" aria-label={tr('Zoom out', '缩小字号')} disabled={accessory.fontSize <= 9} onClick={() => accessory.setFontSize(accessory.fontSize - 1)}>A−</button>
        <button type="button" aria-label={tr('Zoom in', '放大字号')} disabled={accessory.fontSize >= 28} onClick={() => accessory.setFontSize(accessory.fontSize + 1)}>A+</button>
        <button type="button" disabled={pending} onClick={() => { void reload() }}>{tr('Reload terminal view', '重新加载终端视图')}</button>
    </div>
}

function Compatibility({ source, language }: { source: LegacyTerminalState | null; language: string }) {
    const tr = (en: string, zh: string) => language.startsWith('zh') ? zh : en
    return <details className="hapi-legacy-terminal-compat"><summary>{tr('Legacy SessionTerminal transport · source compatibility', '旧版 SessionTerminal 传输 · 源协议说明')}</summary>
        <p>{tr('This is the original session-scoped terminal ID. Opening uses HAPI’s attach-or-create protocol; it does not convert this pane to a new machine terminal.', '此视图保留原会话范围的 terminalId，通过 HAPI 的连接或创建协议打开，不会转换为新的机器终端。')}</p>
        <p>{tr('Input acknowledgement covers the adapter transport only. The original Runner does not acknowledge individual input; uncertain input is never replayed.', '输入确认仅覆盖适配层传输。原 Runner 不确认每条输入，不确定的输入不会自动重放。')}</p>
        <p>{tr('Replay is limited to the tail retained by the source. Closing this pane or tab only releases the view; the source retains its own idle lifetime policy.', '回放仅包含源端仍保留的尾部输出。关闭窗格或标签页只释放视图，源终端仍按自身的空闲生命周期运行。')}</p>
        <p>{tr('The title is an adapter display alias. The original shell executable and initial terminal directory are not reported.', '标题是适配层的显示别名。原 shell 可执行文件和终端初始目录均未报告。')}</p>
        {source && <dl><dt>Hub</dt><dd>{source.source.sourceHubId}</dd><dt>{tr('Source session', '源会话')}</dt><dd>{source.source.sourceSessionId}</dd>
            <dt>{tr('Machine', '机器')}</dt><dd>{source.source.machineId}</dd><dt>terminalId</dt><dd>{source.terminalId}</dd>
            <dt>{tr('Original shell / directory', '原 shell / 目录')}</dt><dd>{tr('Not reported by the source', '源端未报告')}</dd>
            {source.facts.dimensions && <><dt>{tr('Grid', '网格')}</dt><dd>{source.facts.dimensions.cols} × {source.facts.dimensions.rows} · {source.facts.dimensions.basis}</dd></>}
        </dl>}
        {source?.replay.issue && <p role="alert">{tr('Source replay limitation', '源回放限制')}: {source.replay.issue}</p>}
        {source?.delivery.uncertain && <p role="alert">{tr('Some input has an uncertain delivery outcome. It has not been resent.', '部分输入的送达结果不确定，没有自动重新发送。')}</p>}
    </details>
}

/** Install the normal tab definition, independent official model service and
 * borrowed public leaf seats. Every occurrence keeps its real SessionProvider. */
export function installLegacyTerminalView(ctx: Context, api: HapiRemoteApi): () => void {
    const scope = ctx.inject(['slots', 'locale', 'sidebarRight', 'sidebarRightTabs', 'theme', 'remote', 'remote.terminal', 'connection'], owner => {
        const provider = owner.isolate('webTerminals').plugin({ name: 'hapi-legacy-terminal-views', inject: ['remote', 'connection'], apply(providerContext: Context) {
            const models = new ClientTerminals(providerContext, legacyTerminalRemote(api, owner.remote.terminal))
            const views = new LegacyTerminalViews(api, models)
            providerContext.reflect.provide('hapiLegacyTerminalViews', views)
            const disposers: Array<() => void> = []
            const style = document.createElement('style'); style.textContent = styles; document.head.append(style); disposers.push(() => style.remove())
            const language = () => owner.locale.getSnapshot().active
            const terminalCopy: TerminalTranslate = key => language().startsWith('zh') ? zh[key] : en[key]
            disposers.push(owner.sidebarRightTabs.register({ id: LEGACY_TERMINAL_SEAT_ID, kind: LEGACY_TERMINAL_TAB_KIND,
                multiple: true, keepMounted: true, priority: 'fallback', title: () => language().startsWith('zh') ? '原会话终端' : 'Legacy terminal',
                canOpen: canOpenLegacyTerminalAddress,
            }))
            const sync = (): void => views.retainTabs(owner.sidebarRight.openTabs.getSnapshot().filter(tab => tab.kind === LEGACY_TERMINAL_TAB_KIND))
            disposers.push(owner.sidebarRight.openTabs.subscribe(sync)); sync()
            // No close handler is registered: official occurrence destruction
            // releases mount/holds and must never call ClientTerminals.close.
            const occurrence = (sessionId: SessionId, key: string): LegacyTerminalOccurrence => {
                const address = owner.sidebarRight.tabDomain.occurrence(sessionId, { id: key as TabId }).navigation.getSnapshot().address
                return views.occurrence(sessionId, key, address)
            }
            const inject = (entry: StoredEntry, sessionId: SessionId): LegacyTerminalInjected => {
                const face = entry.inject ? (entry.inject as (sessionId: SessionId) => Record<string, unknown>)(sessionId) : {}
                const hooks = face.hooks && typeof face.hooks === 'object' ? face.hooks as Record<string, unknown> : {}
                const keyed = face.keyedHooks && typeof face.keyedHooks === 'object' ? face.keyedHooks as Record<string, unknown> : {}
                const officialTheme = hooks.theme as HostObservable<ThemeSnapshot> | undefined ?? {
                    getSnapshot: () => owner.theme.getTheme(), subscribe: listener => owner.on('theme/change', listener),
                }
                const preferences = owner.get('hapiWorkspaceUi')?.preferences ?? owner.get('hapiWorkspacePane')?.preferences
                return { ...face, view: key => occurrence(sessionId, key).view(), legacyTerminal: key => occurrence(sessionId, key),
                    keyedHooks: { ...keyed, terminal: key => occurrence(sessionId, key).terminal, legacyTerminal: key => occurrence(sessionId, key).state },
                    hooks: { ...hooks, theme: preferences ? terminalTheme(officialTheme, preferences) : officialTheme },
                }
            }
            const Body = (Official: ComponentType<TerminalBodyFace>) => {
                const Screen = hasTerminalControls(Official) ? Official : composedTerminalBody(owner, Official, terminalCopy)
                return function LegacyBody(props: LegacyTerminalBodyProps): ReactNode {
                    const { tab } = props.useTabInfo(), binding = props.legacyTerminal(tab.id)
                    const state = props.useLegacyTerminal(tab.id) ?? binding.state.getSnapshot()
                    const native = props.useProjection('hapi'), observed = props.useProjection('hapiObserved')
                    const lang = useSyncExternalStore(listener => owner.locale.subscribe(listener), language)
                    const parsed = useMemo(() => {
                        try { return { success: true as const, data: legacyTerminalNavigationParams(tab.navigation, props.sessionId) } }
                        catch (error) { return { success: false as const, error: error instanceof Error ? error.message : String(error) } }
                    }, [tab.navigation.address, tab.navigation.params, props.sessionId])
                    let source: WorkbenchSource | null = null, invalid: string | null = null
                    try { if (!parsed.success) throw new Error(parsed.error); source = legacyTerminalSource(parsed.data, native ?? observed, !!observed?.sidechain) }
                    catch (error) { invalid = error instanceof Error ? error.message : String(error) }
                    const [error, setError] = useStateError(invalid)
                    useEffect(() => {
                        if (!source || !parsed.success || invalid) return
                        try { return binding.mount({ sessionId: props.sessionId, source, terminalId: parsed.data.terminalId, cols: 80, rows: 24 }) }
                        catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
                    }, [binding, props.sessionId, source?.sourceHubId, source?.sourceSessionId, source?.machineId, parsed.success ? parsed.data.terminalId : null, invalid])
                    const sourceState = state.source
                    return <section className="hapi-legacy-terminal" data-hapi-legacy-terminal={parsed.success ? parsed.data.terminalId : ''}>
                        {invalid || error || !source ? <p className="hapi-legacy-terminal-loading" role={invalid || error ? 'alert' : 'status'}>{invalid || error || (lang.startsWith('zh') ? '正在等待此窗格的原始源会话身份…' : 'Waiting for this pane’s original source Session identity…')}</p>
                            : sourceState ? <Screen {...props} hapiTerminalActions={{
                                readCopy: (local, signal) => readLegacyTerminalCopy(api, sourceState, local, signal),
                                toolbar: accessory => <LegacyToolbar accessory={accessory} source={sourceState} pending={state.phase === 'opening'} reload={() => binding.reload()} language={lang}/>,
                            }}/>
                                : <div className="hapi-legacy-terminal-loading"><p role={state.error ? 'alert' : 'status'}>{state.error ?? (lang.startsWith('zh') ? '正在连接原会话终端…' : 'Connecting to the original session terminal…')}</p>
                                    {state.phase === 'failed' && <button type="button" onClick={() => { void binding.reload() }}>{lang.startsWith('zh') ? '重新加载终端视图' : 'Reload terminal view'}</button>}</div>}
                        {sourceState && (state.error || sourceState.error) && <p role="alert" className="hapi-legacy-terminal-loading">{state.error || sourceState.error}</p>}
                        <Compatibility source={sourceState} language={lang}/>
                    </section>
                }
            }
            const Title = (Official: ComponentType<LegacyTerminalTitleProps>) => function LegacyTitle(props: LegacyTerminalTitleProps): ReactNode {
                const { tab } = props.useTabInfo(), binding = props.legacyTerminal(tab.id)
                const state = props.useLegacyTerminal(tab.id) ?? binding.state.getSnapshot()
                return state.source ? createElement(Official, props) : <span>{tab.title}</span>
            }
            const borrow = (name: 'sidebar.right.pane.tab' | 'sidebar.right.pane.tab.title'): (() => void) => followLegacyTerminalSeat(owner, name,
                OFFICIAL_TERMINAL_SEAT, LEGACY_TERMINAL_SEAT_ID, inject,
                entry => name === 'sidebar.right.pane.tab' ? Body(entry.component as ComponentType<TerminalBodyFace>) : Title(entry.component as ComponentType<LegacyTerminalTitleProps>))
            for (const name of ['sidebar.right.pane.tab', 'sidebar.right.pane.tab.title'] as const) disposers.push(owner.slots.inject(name, () => borrow(name)))
            providerContext.effect(() => () => {
                for (const dispose of disposers.reverse()) dispose()
                models.retainTabs([]); views.dispose()
            }, 'hapi-legacy-terminal.ui')
        } })
        return () => provider.dispose()
    })
    return () => { void scope.dispose() }
}

/** Keep admission errors local without altering the official model's state. */
function useStateError(invalid: string | null): [string | null, (value: string | null) => void] {
    const [error, setError] = useState<string | null>(null)
    useEffect(() => { setError(null) }, [invalid])
    return [error, setError]
}
