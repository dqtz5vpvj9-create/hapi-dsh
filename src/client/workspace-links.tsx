import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { WorkspaceUiPreferences } from './ui-preferences.ts'
import { readWorkspaceLinkOpening, workspaceExternalHref, WorkspaceLinkNavigation, type WorkspaceLinkOpening } from './link-opening.ts'
import type {} from './workspace-ui.ts'

/** Capture belongs to our layout, not to a patched or re-registered DSH renderer. */
export function useWorkspaceLinks(preferences: WorkspaceUiPreferences | undefined, prepare: (() => Promise<void>) | undefined) {
    const latest = useRef(prepare); latest.current = prepare
    const navigator = useMemo(() => new WorkspaceLinkNavigation({
        prepare: async () => { if (!latest.current) throw new Error('The workspace editors are not ready.'); await latest.current() },
        assign: href => window.location.assign(href), open: href => { window.open(href, '_blank', 'noopener,noreferrer') },
    }), [])
    useEffect(() => () => { navigator.dispose() }, [navigator])
    const state = useSyncExternalStore(navigator.subscribe, navigator.getSnapshot)
    const capture = (event: MouseEvent<HTMLDivElement>): void => {
        if (!preferences) return
        const mode = readWorkspaceLinkOpening(preferences)
        if (mode === 'dsh' || !(event.target instanceof Element)) return
        const anchor = event.target.closest<HTMLAnchorElement>('a[href]')
        // Dialog portals and unrelated plugin/settings pages retain their owner.
        if (!anchor || !event.currentTarget.contains(anchor) || !anchor.closest('.hapi-pane-body')) return
        const href = workspaceExternalHref({ href: anchor.getAttribute('href'), target: anchor.getAttribute('target'),
            download: anchor.hasAttribute('download'), native: Boolean(anchor.closest('[data-hapi-link-behavior="native"]')),
            button: event.button, defaultPrevented: event.defaultPrevented, ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey, altKey: event.altKey })
        if (!href) return
        event.preventDefault(); event.stopPropagation()
        navigator.open(href, mode)
    }
    return { state, capture, cancel: navigator.cancel }
}

export function WorkspaceLinkNotice({ links, language }: { links: ReturnType<typeof useWorkspaceLinks>; language: string }) {
    if (links.state.phase === 'idle') return null
    const zh = language.startsWith('zh')
    return <div className="hapi-notice" role={links.state.phase === 'failed' ? 'alert' : 'status'} data-hapi-link-status>
        <span>{links.state.phase === 'saving' ? zh ? '正在保存工作区草稿，然后打开链接…' : 'Saving workspace drafts before opening the link…'
            : `${zh ? '草稿尚未保存，当前页面已保留：' : 'Drafts could not be saved; this page remains open: '}${links.state.error}`}</span>
        <button type="button" onClick={links.cancel}>{zh ? '留在工作区' : 'Stay in workspace'}</button>
    </div>
}

export function installWorkspaceLinkSettings(ctx: Context): () => void {
    const scope = ctx.inject(['hapiWorkspaceUi', 'slots', 'locale'], owner => {
        const preferences = owner.hapiWorkspaceUi.preferences
        function Section() {
            const mode = useSyncExternalStore(preferences.subscribe, () => readWorkspaceLinkOpening(preferences))
            const language = useSyncExternalStore(listener => owner.locale.subscribe(listener), () => owner.locale.getSnapshot().active)
            const zh = language.startsWith('zh'), [error, setError] = useState<string | null>(null)
            const tr = (en: string, cn: string) => zh ? cn : en
            const write = (value: WorkspaceLinkOpening): void => {
                try {
                    if (value === 'dsh') preferences.setItem('hapi-dsh-link-opening', 'dsh')
                    else {
                        if (value === 'new-tab') preferences.setItem('hapi-open-external-links-in-new-tab', 'true')
                        else preferences.removeItem('hapi-open-external-links-in-new-tab')
                        preferences.removeItem('hapi-dsh-link-opening')
                    }
                    setError(null)
                } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
            }
            return <section className="hapi-appearance-settings" aria-label={tr('Workspace links', '工作区链接')}>
                <h2>{tr('Workspace links', '工作区链接')}</h2>
                <label>{tr('Open web links', '打开网页链接')}<select value={mode} onChange={event => write(event.currentTarget.value as WorkspaceLinkOpening)}>
                    <option value="same-tab">{tr('Current browser tab', '当前浏览器标签页')}</option>
                    <option value="new-tab">{tr('New browser tab', '新浏览器标签页')}</option>
                    <option value="dsh">{tr('Follow DSH and plugin settings', '跟随 DSH 与插件设置')}</option>
                </select></label>
                <p>{tr('Applies to ordinary web links inside workspace panes. Current-tab navigation saves supported drafts first. Modified clicks and downloads keep their browser behavior.',
                    '作用于工作区窗格内的普通网页链接。同页导航会先保存支持此功能的草稿；修饰键点击和下载保留浏览器原有行为。')}</p>
                {error && <p role="alert">{tr('The change applies here but could not be saved: ', '修改已在本页生效，但无法持久保存：')}{error}</p>}
            </section>
        }
        return owner.slots.inject('settings.section', () => owner.slots.register({ name: 'settings.section', id: 'hapi-workspace-links', order: 33,
            label: () => owner.locale.getSnapshot().active.startsWith('zh') ? '工作区链接' : 'Workspace links',
        }, Section))
    })
    return () => { void scope.dispose() }
}
