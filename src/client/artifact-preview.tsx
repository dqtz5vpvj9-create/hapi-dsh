import { DocumentSelectionButton } from './document-selection.tsx'
/** HAPI artifact source adapter inside the official resource/tab/document lifecycle. */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { CodeBlock, ImageLightbox, languageForPath } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import type { PropsRenderSlots, PropsRuntime, SlotHookFactory, SlotMap } from '@deepseek-ai/dsh-client-ui-slots'
import type { UseSidebarRightTabInfo } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { sessionFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import { ARTIFACT_PROTOCOL, GENERATED_MEDIA_PROTOCOL, ARTIFACT_TAB_ID, ARTIFACT_TAB_KIND, parseSourceDocumentResourceAddress, sessionFileArtifactPath,
    type ArtifactReference, type GeneratedMediaReference, type SourceDocumentReference } from '../workspace/artifacts.ts'
import { artifactPresentation, artifactViewers, loadArtifact, readArtifactBytes, type ArtifactApi, type ArtifactPresentation, type ArtifactViewer, type LoadedArtifact } from './artifact-content.ts'
import { SourceMarkdown, sourceMarkdownLabels } from './source-markdown.tsx'
import { sourcePathAddress } from './source-path-actions.tsx'
import { errorMessage } from './controller.ts'
import { borrowArtifactBodies, DOCUMENT_PREFIX } from './artifact-bodies.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface ResourceProtocolMap { 'hapi-artifact': ArtifactReference; 'hapi-generated-media': GeneratedMediaReference }
    interface SlotMap { 'hapi.artifact.document': SlotMap['sidebar.right.tab.document'] }
}
declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
    interface SidebarRightResourceParamsMap { 'hapi-artifact': { viewer?: ArtifactViewer; wrap?: boolean; line?: number } }
}

type ArtifactBodyProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsRenderSlots<'hapi.artifact.document'>
const tabInfoFactory: SlotHookFactory<'sidebar.right.tab.document', UseSidebarRightTabInfo> = (_standard, reader) => reader

const styles = `
.hapi-artifact{display:flex;flex-direction:column;min-height:0;height:100%;color:inherit}
.hapi-artifact-toolbar{display:flex;align-items:center;flex-wrap:wrap;gap:7px;padding:8px 12px;border-bottom:1px solid var(--border-secondary,#8885);font-size:12px}
.hapi-artifact-toolbar strong{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:60px}
.hapi-artifact button,.hapi-artifact select{font:inherit;color:inherit;background:var(--bg-secondary,transparent);border:1px solid var(--border-secondary,#8886);border-radius:5px;padding:5px 8px;cursor:pointer}
.hapi-artifact button:disabled{opacity:.5;cursor:default}.hapi-artifact-toolbar label{display:flex;align-items:center;gap:4px}
.hapi-artifact-content{min-height:0;flex:1;overflow:auto;position:relative}.hapi-artifact-status{padding:14px;overflow-wrap:anywhere}.hapi-artifact-status[role=alert]{color:var(--text-error,#dc6670)}
.hapi-artifact-content>div[data-pdf-preview],.hapi-artifact-content>iframe[data-html-preview]{height:100%;width:100%;border:0}
.hapi-source-markdown{padding:16px;line-height:1.6;overflow-wrap:anywhere}.hapi-artifact-code{height:100%;min-height:0}.hapi-artifact-source{font-size:11px;opacity:.7;padding:5px 12px;overflow-wrap:anywhere}
.hapi-artifact-image{display:flex;align-items:flex-start;justify-content:center;min-height:100%;padding:16px;box-sizing:border-box}.hapi-artifact-image>button{border:0;padding:0;background:transparent;max-width:100%}.hapi-artifact-image img{max-width:100%;height:auto;display:block}
`

function ArtifactImage({ data, mimeType, name, language, visible }: { data: Uint8Array<ArrayBuffer>; mimeType: string; name: string; language: string; visible: boolean }) {
    const [url, setUrl] = useState<string | null>(null), [open, setOpen] = useState(false)
    const close = useCallback(() => setOpen(false), [])
    useEffect(() => { const next = URL.createObjectURL(new Blob([data], { type: mimeType })); setUrl(next); return () => { URL.revokeObjectURL(next) } }, [data, mimeType])
    useEffect(() => { if (!visible) setOpen(false) }, [visible])
    const zh = language.startsWith('zh')
    return url ? <div className="hapi-artifact-image"><button type="button" aria-label={zh ? '打开原始图片' : 'Open original image'} onClick={() => setOpen(true)}><img src={url} alt={name} draggable={false}/></button>
        {open && visible && <ImageLightbox src={url} alt={name} onClose={close} labels={{ dialog: zh ? '源图片' : 'Source image', close: zh ? '关闭' : 'Close' }}/>}</div> : null
}

/** Keep metadata, download bytes and view selection tied to the actual occurrence lifetime. */
function ArtifactContent(props: ArtifactBodyProps & { ctx: Context; api: ArtifactApi; reference: SourceDocumentReference; language: string }) {
    const { ctx, api, reference, language } = props, { tab } = props.useTabInfo(), zh = language.startsWith('zh')
    const address = tab.contentId
    const [revision, setRevision] = useState(0), [loaded, setLoaded] = useState<LoadedArtifact | null>(null)
    const [presentation, setPresentation] = useState<ArtifactPresentation | null>(null), [error, setError] = useState<string | null>(null)
    const [loading, setLoading] = useState(true), [downloading, setDownloading] = useState(false)
    const download = useRef<AbortController | null>(null), scrollport = useRef<HTMLElement | null>(null)
    const definitions = useSyncExternalStore(ctx.documentPreviews.subscribe, ctx.documentPreviews.getSnapshot)
    const choice = tab.navigation.params && 'viewer' in tab.navigation.params ? tab.navigation.params.viewer : undefined
    const wrap = tab.navigation.params && 'wrap' in tab.navigation.params ? tab.navigation.params.wrap !== false : true
    const choices = loaded ? artifactViewers(loaded.metadata, ctx.documentPreviews.candidates(loaded.metadata.fileName)) : []
    const viewer = choice && choices.includes(choice) ? choice : choices[0]
    const refresh = useCallback(() => setRevision(value => value + 1), [])
    useEffect(() => tab.actions.bindCommands({ refresh }), [tab.actions, refresh])
    useEffect(() => {
        const controller = new AbortController(), signal = AbortSignal.any([controller.signal, tab.signal])
        setLoading(true); setLoaded(null); setPresentation(null); setError(null)
        void loadArtifact(api, reference, signal).then(value => { if (!signal.aborted) setLoaded(value) }, failure => { if (!signal.aborted) { setError(errorMessage(failure)); setLoading(false) } })
        return () => { controller.abort(); download.current?.abort() }
    }, [address, revision, api, tab.signal])
    useEffect(() => {
        if (!loaded) return
        if (!viewer) { setLoading(false); return }
        const controller = new AbortController(), signal = AbortSignal.any([controller.signal, tab.signal])
        setLoading(true); setPresentation(null); setError(null)
        void artifactPresentation(api, loaded, viewer, location.href, signal).then(value => {
            if (!signal.aborted) { setPresentation(value); setLoading(false) }
        }, failure => { if (!signal.aborted) { setError(errorMessage(failure)); setLoading(false) } })
        return () => { controller.abort() }
    }, [loaded, viewer, api, tab.signal])
    // A provider's selected definition may hot-reload without changing the bytes.
    void definitions
    const downloadOriginal = async (): Promise<void> => {
        if (!loaded || download.current) return
        const controller = new AbortController(); download.current = controller; setDownloading(true)
        const signal = AbortSignal.any([controller.signal, tab.signal])
        try {
            const bytes = await readArtifactBytes(loaded.metadata.downloadUrl, location.href, signal)
            signal.throwIfAborted()
            const url = URL.createObjectURL(new Blob([bytes], { type: loaded.metadata.mimeType })), link = document.createElement('a')
            link.href = url; link.download = loaded.metadata.fileName; link.click()
            setTimeout(() => URL.revokeObjectURL(url), 30_000)
        } catch (failure) { if (!signal.aborted) setError(errorMessage(failure)) }
        finally { if (download.current === controller) { download.current = null; if (!signal.aborted) setDownloading(false) } }
    }
    const choose = (next: { viewer?: ArtifactViewer; wrap?: boolean }): void => ctx.sidebarRight.tabDomain.navigate(props.sessionId, tab.id,
        { address, params: { ...(choice ? { viewer: choice } : {}), wrap, ...next } })
    const labels = sourceMarkdownLabels(language)
    const viewerName = (value: ArtifactViewer): string => ({ pdf: 'PDF', markdown: 'Markdown', code: zh ? '代码' : 'Code', text: zh ? '原文' : 'Source text', image: zh ? '图片' : 'Image', html: zh ? 'HTML 静态预览' : 'Static HTML' })[value]
    const body = (): ReactNode => {
        if (!presentation || !loaded) return null
        const { content } = presentation
        // A `session-file:` artifact names a real path on the source machine, so
        // its Markdown keeps the original relative-image and link base. An
        // opaque artifact has no filesystem base and must not guess one.
        const artifactPath = reference.document.kind === 'artifact' ? sessionFileArtifactPath(reference.document.artifactId) : null
        if (presentation.viewer === 'markdown' && content.kind === 'text') return <div className="hapi-source-markdown" data-document-markdown><SourceMarkdown text={content.text} complete={content.eof}
            source={reference.source} {...(artifactPath === null ? {} : { documentPath: artifactPath })} language={language}
            openFile={(path, line) => tab.actions.openResource(sessionFileAddress(props.sessionId, path), line === undefined ? {} : { params: { line } })}/></div>
        if (presentation.viewer === 'code' && content.kind === 'text') return <CodeBlock className="hapi-artifact-code" code={content.text} lang={languageForPath(loaded.metadata.fileName)} streaming={false}
            lineNumbers wrap={wrap} copyLabel={labels.code.copyLabel} copiedLabel={labels.code.copiedLabel} toolbarLabels={labels.code.toolbarLabels}/>
        if (presentation.viewer === 'image' && content.kind === 'bytes') return <ArtifactImage data={content.data} mimeType={loaded.metadata.mimeType} name={loaded.metadata.fileName} language={language} visible={tab.visible}/>
        const key = `${DOCUMENT_PREFIX}${presentation.viewer}`
        return props.renderSlot('hapi.artifact.document', { content, resourceAddress: address, wrap,
            addResource: resource => ctx.resources.pin(resource, tab.signal), setResources: resources => { for (const resource of resources) ctx.resources.pin(resource, tab.signal) },
            scrollportRef: element => { scrollport.current = element },
        }, { entryKey: key, hookContext: props.useTabInfo,
            fallback: <p role="alert" className="hapi-artifact-status">{zh ? '此官方文档插件尚未加载；可以下载源文件。' : 'This official document plugin is unavailable. The original document can still be downloaded.'}</p>,
        })
    }
    return <section className="hapi-artifact" data-hapi-artifact-source={reference.source.sourceSessionId}>
        <header className="hapi-artifact-toolbar"><DocumentSelectionButton sessionId={props.sessionId} source={reference.source} path={reference.document.kind === 'artifact' ? `artifact:${reference.document.artifactId}` : `generated-media:${reference.document.imageId}`} version={loaded?.metadata.hash} zh={zh}/><strong title={loaded?.metadata.fileName ?? reference.document.fileName}>{loaded?.metadata.fileName ?? reference.document.fileName}</strong>
            {choices.length > 1 && <select aria-label={zh ? '文档显示方式' : 'Document viewer'} value={viewer} onChange={event => choose({ viewer: event.currentTarget.value as ArtifactViewer })}>{choices.map(value => <option key={value} value={value}>{viewerName(value)}</option>)}</select>}
            {(viewer === 'code' || viewer === 'text') && <label><input type="checkbox" checked={wrap} onChange={event => choose({ wrap: event.currentTarget.checked })}/>{zh ? '换行' : 'Wrap'}</label>}
            <button type="button" onClick={refresh} disabled={loading}>{zh ? '重新读取' : 'Reload'}</button>
            <button type="button" disabled={!loaded || downloading} onClick={() => { void downloadOriginal() }}>{downloading ? zh ? '正在下载…' : 'Downloading…' : zh ? '下载原件' : 'Download original'}</button>
        </header>
        {presentation?.converted && <div className="hapi-artifact-source">{zh ? '由原 HAPI 文档转换服务生成 PDF；下载保留原始文件。' : 'PDF produced by the original HAPI document conversion service. Download keeps the original file.'}</div>}
        {viewer === 'html' && <div className="hapi-artifact-source">{zh ? '官方 HTML 静态预览；此 artifact 没有可推断的工作目录依赖。' : 'Official static HTML preview. This artifact has no inferred workspace dependency directory.'}</div>}
        <div className="hapi-artifact-content">{error && <p role="alert" className="hapi-artifact-status">{error}</p>}
            {loading ? <p role="status" className="hapi-artifact-status">{zh ? '正在读取源文档…' : 'Loading source document…'}</p> : !viewer && loaded ? <p className="hapi-artifact-status">{zh ? '此文件没有可用的文档预览器；可下载原始文件。' : 'No document preview is available for this file. Download the original file.'}</p> : body()}
        </div>
    </section>
}

/** Optional dependency: disabling a document plugin never disables the workspace shell. */
export function installArtifactPreview(ctx: Context, api: ArtifactApi): () => void {
    const scope = ctx.inject(['resources', 'documentPreviews'], child => {
        const disposers: Array<() => void> = []
        const style = document.createElement('style'); style.textContent = styles; document.head.append(style); disposers.push(() => style.remove())
        for (const protocol of [ARTIFACT_PROTOCOL, GENERATED_MEDIA_PROTOCOL] as const) disposers.push(child.resources.register({ protocol, async *open(address, { signal }) {
            if (signal.aborted) return
            const reference = parseSourceDocumentResourceAddress(address)
            if (!reference) { yield { ok: false, error: new RemoteError('gateway/internal', 'Invalid original HAPI source document address', {}) }; return }
            // This protocol exposes source identity. Its owner separately reads
            // authenticated bytes; no absolutePath is invented for the resource.
            yield { ok: true, value: reference }
        } }))
        disposers.push(child.sidebarRightTabs.register({ id: ARTIFACT_TAB_ID, kind: ARTIFACT_TAB_KIND, keepMounted: true,
            patterns: [ARTIFACT_PROTOCOL, GENERATED_MEDIA_PROTOCOL].map(protocol => `dsh-resource://${protocol}/[\\s\\S]+`), priority: 'fallback',
            canOpen: address => parseSourceDocumentResourceAddress(address) !== null,
            title: address => parseSourceDocumentResourceAddress(address)?.document.fileName || 'Source document',
        }))
        const Body = (props: ArtifactBodyProps) => {
            const { tab } = props.useTabInfo(), state = props.useResource<'hapi-artifact' | 'hapi-generated-media'>(tab.contentId)
            const native = props.useProjection('hapi'), observed = props.useProjection('hapiObserved')
            const source = sourcePathAddress(native ?? observed), reference = state.value
            const language = useSyncExternalStore(listener => child.locale.subscribe(listener), () => child.locale.getSnapshot().active)
            if (!reference) return <p className="hapi-artifact-status" role={state.status === 'failed' ? 'alert' : 'status'}>{state.failure?.message ?? (language.startsWith('zh') ? '正在解析源文档…' : 'Resolving source document…')}</p>
            if (!source || source.sourceSessionId !== reference.source.sourceSessionId || reference.source.sourceHubId && source.sourceHubId !== reference.source.sourceHubId
                || reference.source.machineId && source.machineId !== reference.source.machineId) return <p role="alert" className="hapi-artifact-status">{language.startsWith('zh') ? '此 artifact 的原始机器或会话与当前窗格不匹配；引用已保留。' : 'This artifact’s original machine or session does not match the current pane. Its source reference is preserved.'}</p>
            return <ArtifactContent key={tab.contentId} {...props} ctx={child} api={api} reference={reference} language={language}/>
        }
        disposers.push(child.slots.inject('sidebar.right.pane.tab', () => child.slots.register({ name: 'sidebar.right.pane.tab', key: ARTIFACT_TAB_ID,
            children: { 'hapi.artifact.document': { kind: 'keyed', scope: 'session', inject: { hooks: { tabInfo: tabInfoFactory } } } },
        }, Body)))
        disposers.push(child.slots.inject('hapi.artifact.document', () => borrowArtifactBodies(child)))
        return () => { for (const dispose of disposers.reverse()) dispose() }
    })
    return () => { void scope.dispose() }
}
