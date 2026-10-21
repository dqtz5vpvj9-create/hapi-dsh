/** A source-address adapter over DSH's published Markdown renderer and navigation provider. */
import { createElement, useMemo, useSyncExternalStore, type ComponentType } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { MarkdownDelegateProvider, MarkdownText, type MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import { parseFileAddress, sessionFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import type { DocumentPreviewProps } from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import type { LocaleNamespaceMap, StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkbenchSource } from '../workbench-types.ts'
import { sourcePathAddress } from './source-path-actions.tsx'
import { sourceDocumentImageUrl, sourceDocumentPath } from './source-document-path.ts'

export function sourceMarkdownLabels(language: string): MarkdownLabels {
    const zh = language.startsWith('zh')
    return { code: { copyLabel: zh ? '复制' : 'Copy', copiedLabel: zh ? '已复制' : 'Copied',
        toolbarLabels: { codeLabel: zh ? '代码' : 'Code', wrapLabel: zh ? '自动换行' : 'Wrap lines', unwrapLabel: zh ? '取消换行' : 'Unwrap lines' } },
    footnotes: zh ? '脚注' : 'Footnotes' }
}

export function SourceMarkdown({ text, complete, source, documentPath, language, openFile }: {
    text: string; complete: boolean; source: WorkbenchSource; documentPath?: string; language: string; openFile(path: string, line?: number): void
}) {
    const labels = useMemo(() => sourceMarkdownLabels(language), [language]), zh = language.startsWith('zh')
    const pathImages = useMemo(() => ({ resolve: (value: string) => sourceDocumentImageUrl(source, value, location.href, documentPath) }),
        [source.sourceSessionId, source.sourceHubId, source.machineId, documentPath])
    const navigate = (value: string, options?: { line?: number }): void => {
        const path = sourceDocumentPath(value, documentPath)
        if (path !== undefined) openFile(path, options?.line)
    }
    return <MarkdownDelegateProvider openFile={navigate} fileImages={{ resolve: pathImages.resolve,
        labels: { dialog: zh ? '源图片' : 'Source image', close: zh ? '关闭' : 'Close', open: zh ? '打开源图片' : 'Open source image', loading: zh ? '正在读取源图片…' : 'Loading source image…', failed: zh ? '源图片读取失败' : 'Source image could not be loaded' },
    }}><MarkdownText text={text} streaming={!complete} labels={labels} pathImages={pathImages}/></MarkdownDelegateProvider>
}

/**
 * Only the source-owned Markdown body needs a different path vocabulary.
 * Ordinary DSH views keep the original component, props, locale and inject.
 */
export function installSourceMarkdown(ctx: Context): () => void {
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
                wrapped = function SourceAwareMarkdown(props) {
                    const native = props.useProjection('hapi'), observed = props.useProjection('hapiObserved')
                    const metadata = props.useResource<'file'>(props.resourceAddress).value
                    const language = useSyncExternalStore(listener => ctx.locale.subscribe(listener), () => ctx.locale.getSnapshot().active)
                    if (!native && !observed) return createElement(Official, props)
                    const source = sourcePathAddress(native ?? observed), file = parseFileAddress(props.resourceAddress)
                    if (!source || file?.scope !== 'session' || file.sessionId !== props.sessionId) return <p role="alert">{language.startsWith('zh') ? '此文档的原始会话地址不可用。' : 'This document’s original source session is unavailable.'}</p>
                    if (props.content.kind !== 'text') return null
                    return <div className="hapi-source-markdown" data-document-markdown><SourceMarkdown text={props.content.text} complete={props.content.eof}
                        source={source} {...(metadata?.absolutePath ? { documentPath: metadata.absolutePath } : {})} language={language}
                        openFile={(path, line) => ctx.sidebarRight.openResourceIn(props.sessionId, sessionFileAddress(props.sessionId, path), line === undefined ? {} : { params: { line } })}/></div>
                }
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
