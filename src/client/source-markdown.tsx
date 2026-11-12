import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-file-drag/client'
/** DSH's Markdown renderer, with paths resolved by the exact source workspace owner. */
import { createElement, useEffect, useMemo, useState, useSyncExternalStore, type ComponentType } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { MarkdownDelegateProvider, MarkdownText, type MarkdownLabels, type FileDragActions } from '@deepseek-ai/dsh-client-ui-primitives'
import { parseFileAddress, sessionFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import type { DocumentPreviewProps } from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import type { LocaleNamespaceMap, StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { isSourceSessionId } from '../remote/protocol.ts'
import { sourceDocumentPath } from './source-document-path.ts'
import { sourceFileAccess, type SourceFileClient, type SourceFileContext } from './source-workspace-provider.ts'
import { readWorkspaceArtifactBytes } from './artifact-content.ts'

export function sourceMarkdownLabels(language: string): MarkdownLabels {
    const zh = language.startsWith('zh')
    return { code: { copyLabel: zh ? '复制' : 'Copy', copiedLabel: zh ? '已复制' : 'Copied',
        toolbarLabels: { codeLabel: zh ? '代码' : 'Code', wrapLabel: zh ? '自动换行' : 'Wrap lines', unwrapLabel: zh ? '取消换行' : 'Unwrap lines' } },
    footnotes: zh ? '脚注' : 'Footnotes' }
}

export function SourceMarkdown({ text, complete, context, documentPath, language, openFile, fileDrag }: {
    text: string; complete: boolean; context: SourceFileContext; documentPath?: string; language: string; fileDrag: FileDragActions; openFile(path: string, line?: number): void
}) {
    const labels = useMemo(() => sourceMarkdownLabels(language), [language]), zh = language.startsWith('zh')
    const [, changed] = useState(0)
    // The published Markdown API resolves image URLs synchronously. Collect its
    // requested paths during rendering, then read through SourceFiles after commit.
    const images = useMemo(() => ({ stop: new AbortController(), requested: new Set<string>(), loading: new Set<string>(), urls: new Map<string, string>(), failures: new Map<string, string>() }), [context, documentPath])
    const pathImages = useMemo(() => ({ resolve: (value: string) => {
        const path = sourceDocumentPath(value, documentPath)
        if (path === undefined) return undefined
        images.requested.add(path)
        return images.urls.get(path)
    } }), [images, images.urls.size])
    useEffect(() => () => { images.stop.abort(); for (const url of images.urls.values()) URL.revokeObjectURL(url) }, [images])
    useEffect(() => {
        for (const path of images.requested) {
            if (images.loading.has(path) || images.urls.has(path) || images.failures.has(path)) continue
            images.loading.add(path)
            const signal = images.stop.signal, resource = { target: context.owner.binding.target, document: { kind: 'file' as const, path } }
            void context.services.documents.open(resource.document, sourceFileAccess(context.owner, signal)).then(async metadata => {
                signal.throwIfAborted()
                if (!metadata.mimeType.startsWith('image/')) throw new Error('This source dependency is not an image.')
                const bytes = await readWorkspaceArtifactBytes({ resource, metadata, context }, signal); signal.throwIfAborted()
                images.urls.set(path, URL.createObjectURL(new Blob([bytes], { type: metadata.mimeType })))
            }).catch(error => { if (!signal.aborted) images.failures.set(path, String(error)) }).finally(() => { images.loading.delete(path); if (!signal.aborted) changed(value => value + 1) })
        }
    })
    const navigate = (value: string, options?: { line?: number }): void => {
        const path = sourceDocumentPath(value, documentPath)
        if (path !== undefined) openFile(path, options?.line)
    }
    return <><MarkdownDelegateProvider openFile={navigate} fileImages={{ fileDrag, resolve: pathImages.resolve,
        resourceAddress: path => sessionFileAddress(context.owner.binding.target.sessionId, sourceDocumentPath(path, documentPath) ?? path),
        labels: { dialog: zh ? '源图片' : 'Source image', close: zh ? '关闭' : 'Close', open: zh ? '打开源图片' : 'Open source image', loading: zh ? '正在读取源图片…' : 'Loading source image…', failed: zh ? '源图片读取失败' : 'Source image could not be loaded' },
    }}><MarkdownText text={text} streaming={!complete} labels={labels} pathImages={pathImages}/></MarkdownDelegateProvider>
        {!!images.failures.size && <p role="alert">{[...images.failures].map(([path, error]) => `${path}: ${error}`).join('\n')} <button type="button" onClick={() => { images.failures.clear(); changed(value => value + 1) }}>{zh ? '重试源图片' : 'Retry source images'}</button></p>}</>
}

export function installSourceMarkdown(ctx: Context, client: SourceFileClient = ctx.sourceFiles): () => void {
    return ctx.slots.inject('sidebar.right.tab.document', () => {
        const key = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/markdown'
        let original: StoredEntry | undefined, wrapped: ComponentType<DocumentPreviewProps> | undefined, remove: (() => void) | undefined
        let changing = false
        const update = (): void => {
            if (changing) return
            const entry = ctx.slots.entries('sidebar.right.tab.document').find(value => value.options.key === key && value.component !== wrapped)
            if (entry === original) return
            changing = true
            try {
                remove?.(); remove = undefined; original = entry
                if (!entry || entry.store || entry.children) return
                const Official = entry.component as ComponentType<DocumentPreviewProps>
                const BoundMarkdown = (props: DocumentPreviewProps) => {
                    const metadata = props.useResource<'file'>(props.resourceAddress).value
                    const language = useSyncExternalStore(listener => ctx.locale.subscribe(listener), () => ctx.locale.getSnapshot().active)
                    const [context, setContext] = useState<SourceFileContext>(), [error, setError] = useState('')
                    useEffect(() => {
                        const stop = new AbortController(); setContext(undefined); setError('')
                        let release = () => {}
                        void client.resolve(props.sessionId, stop.signal).then(value => {
                            if (stop.signal.aborted) return
                            const access = ctx.hhpiSessions.captureWorkspaceAccess(props.sessionId)
                            access.assertCurrent(); access.signal.throwIfAborted()
                            if (access.scope !== value.owner.scope) throw new Error('The document account changed. Reopen its original reference.')
                            const revoke = () => { setContext(undefined); setError('The account or source permission changed. Reopen its original reference.') }
                            access.signal.addEventListener('abort', revoke, { once: true }); release = () => access.signal.removeEventListener('abort', revoke)
                            setContext(value)
                        }).catch(failure => { if (!stop.signal.aborted) setError(String(failure)) })
                        return () => { stop.abort(); release() }
                    }, [props.sessionId])
                    const file = parseFileAddress(props.resourceAddress)
                    if (error) return <p role="alert">{error}</p>
                    if (!context) return <p role="status">{language.startsWith('zh') ? '正在读取源文档…' : 'Loading source document…'}</p>
                    if (file?.scope !== 'session' || file.sessionId !== props.sessionId) return <p role="alert">{language.startsWith('zh') ? '此文档的原始会话地址不可用。' : 'This document’s original source session is unavailable.'}</p>
                    if (props.content.kind !== 'text') return null
                    return <div className="hapi-source-markdown" data-document-markdown><SourceMarkdown text={props.content.text} complete={props.content.eof}
                        context={context} fileDrag={ctx.fileDrag.actions} {...(metadata?.absolutePath ? { documentPath: metadata.absolutePath } : {})} language={language}
                        openFile={(path, line) => ctx.sidebarRight.openResourceIn(props.sessionId, sessionFileAddress(props.sessionId, path), line === undefined ? {} : { params: { line } })}/></div>
                }
                wrapped = props => isSourceSessionId(props.sessionId) ? <BoundMarkdown {...props}/> : createElement(Official, props)
                const inject = entry.inject as ((sessionId: SessionId) => Record<string, unknown>) | undefined
                remove = ctx.slots.register({ name: 'sidebar.right.tab.document', key, priority: (entry.options.priority ?? 0) - 1,
                    ...(entry.locale ? { locale: entry.locale as keyof LocaleNamespaceMap } : {}), inject: (sessionId: SessionId) => inject?.(sessionId) ?? {},
                }, wrapped)
            } finally { changing = false }
        }
        const unsubscribe = ctx.slots.subscribe('sidebar.right.tab.document', update)
        update()
        return () => { unsubscribe(); remove?.() }
    })
}
