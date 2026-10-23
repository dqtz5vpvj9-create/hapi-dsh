/** Optional views use the official loader; their controllers keep their owner. */
import { useEffect, useState, type ComponentType } from 'react'
import { loadNativePanels, loadSessionPanels, loadAdministrationPanel } from './client-chunks.ts'

type PanelProps = { language?: string | undefined; active?: boolean | undefined }

function deferredPanel<P extends PanelProps>(load: () => Promise<ComponentType<P>>): ComponentType<P> {
    let cached: ComponentType<P> | null = null
    return function DeferredPanel(props: P) {
        const [Loaded, setLoaded] = useState(() => cached)
        const [error, setError] = useState<string>()
        const [attempt, retry] = useState(0)
        useEffect(() => {
            if (Loaded || props.active === false) return
            let mounted = true
            setError(undefined)
            void load().then(Component => {
                cached = Component
                if (mounted) setLoaded(() => Component)
            }, reason => { if (mounted) setError(reason instanceof Error ? reason.message : String(reason)) })
            return () => { mounted = false }
        }, [Loaded, props.active, attempt])
        if (Loaded) return <Loaded {...props}/>
        if (props.active === false) return null
        const zh = props.language?.startsWith('zh')
        return error ? <div role="alert" className="hapi-error">{error} <button type="button" onClick={() => retry(value => value + 1)}>{zh ? '重试' : 'Retry'}</button></div>
            : <p role="status">{zh ? '正在打开…' : 'Opening…'}</p>
    }
}

export const NativeLibraryPanel = deferredPanel(() => loadNativePanels().then(module => module.NativeLibraryPanel))
export const NativeSessionToolsPanel = deferredPanel(() => loadNativePanels().then(module => module.NativeSessionToolsPanel))
export const SourceMigrationPanel = deferredPanel(() => loadNativePanels().then(module => module.SourceMigrationPanel))
export const SourceHistoryPanel = deferredPanel(() => loadSessionPanels().then(module => module.SourceHistoryPanel))
export const SourceNotesPanel = deferredPanel(() => loadSessionPanels().then(module => module.SourceNotesPanel))
export const SourceSchedulePanel = deferredPanel(() => loadSessionPanels().then(module => module.SourceSchedulePanel))
export const Administration = deferredPanel(() => loadAdministrationPanel().then(module => module.Administration))
