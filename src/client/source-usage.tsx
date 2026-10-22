import { useEffect, useState, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { IconDatabaseOutlineRegular, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { formatSourceTokens, sourceUsageModel, type SourceUsageModel } from './source-usage-model.ts'
import { useWorkspacePane } from './surface/pane-context.tsx'

const emptySubscribe = () => () => {}
const visibleSnapshot = () => true

function UsageReading({ model, zh, visible }: { model: SourceUsageModel; zh: boolean; visible: boolean }) {
    const [open, setOpen] = useState(false)
    useEffect(() => { if (!visible) setOpen(false) }, [visible])
    const tr = (en: string, cn: string) => zh ? cn : en
    const scope = model.scope === 'session' ? tr('Total', '累计') : tr('Last reported', '最近上报')
    const reading = model.total === null
        ? `${scope} ${tr('in', '输入')} ${formatSourceTokens(model.input)} / ${tr('out', '输出')} ${formatSourceTokens(model.output)}`
        : `${scope} ${formatSourceTokens(model.total)} tok`
    const parts = [reading]
    if (model.cacheHit !== null) parts.push(`${tr('Cache hit', '缓存命中')} ${model.cacheHit}%`)
    if (model.contextPercent !== null) parts.push(`${tr('Context', '上下文')} ${model.contextPercent}%`)
    const exact = (n: number) => n.toLocaleString(zh ? 'zh-CN' : 'en-US')
    return <>
        <button type="button" className="hapi-source-usage-trigger" aria-haspopup="dialog" aria-expanded={open && visible}
            onClick={() => setOpen(true)} title={parts.join(' · ')}>
            <IconDatabaseOutlineRegular/><span>{parts.join(' · ')}</span>
        </button>
        <Modal open={open && visible} onClose={() => setOpen(false)} title={tr('Token usage', 'Token 用量')}
            closeLabel={tr('Close', '关闭')} className="hapi-source-usage-dialog">
            <p>{scope}{model.total !== null && ` · ${exact(model.total)} tok`}</p>
            <dl className="hapi-source-usage-details">
                <dt>{tr('Input (source count)', '输入（源端计数）')}</dt><dd>{exact(model.input)}</dd>
                <dt>{tr('Output', '输出')}</dt><dd>{exact(model.output)}</dd>
                {model.cached !== null && <><dt>{tr('Cache read', '缓存读取')}</dt><dd>{exact(model.cached)}</dd></>}
                {model.cacheWrite !== null && <><dt>{tr('Cache write', '缓存写入')}</dt><dd>{exact(model.cacheWrite)}</dd></>}
                {model.cacheHit !== null && <><dt>{tr('Cache hit', '缓存命中')}</dt><dd>{model.cacheHit}%</dd></>}
                {model.contextWindow !== null && <><dt>{tr('Context used', '上下文已用')}</dt>
                    <dd>{exact(model.contextTokens)} / {exact(model.contextWindow)}</dd></>}
            </dl>
        </Modal>
    </>
}

/** A public dock contribution keeps the official Conversation and all other
 * plugins intact. Ordinary DSH sessions retain their official statistics. */
export function installSourceUsage(ctx: Context): () => void {
    const Usage = ({ sessionId, useProjection }: PropsRuntime<'conversation.composer.dock'>) => {
        const native = useProjection('hapi'), observed = useProjection('hapiObserved')
        const language = useSyncExternalStore(listener => ctx.locale.subscribe(listener), () => ctx.locale.getSnapshot().active)
        const pane = useWorkspacePane(ctx)
        const visible = useSyncExternalStore(pane?.state.subscribe ?? emptySubscribe,
            pane ? () => pane.state.getSnapshot().visible : visibleSnapshot)
        if (!native && !observed) return null
        const model = sourceUsageModel(native?.usage, observed?.usage)
        return <span data-hapi-source-usage="" className="hapi-source-usage">
            {model && <UsageReading key={sessionId} model={model} zh={language.startsWith('zh')} visible={visible}/>}
        </span>
    }
    const stop = ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
        name: 'conversation.composer.dock', id: 'hapi.source-usage', order: 0,
    }, Usage))
    const style = document.createElement('style'); style.textContent = styles; document.head.append(style)
    return () => { stop(); style.remove() }
}

const styles = `
[data-composer-dock]:has([data-hapi-source-usage]) :is([data-composer-stat="activity"],[data-composer-stat="usage"]){display:none!important}
.hapi-source-usage{display:inline-flex;min-width:0;max-width:100%}.hapi-source-usage:empty{display:none}
.hapi-source-usage-trigger{display:inline-flex;align-items:center;gap:6px;min-width:0;max-width:100%;border:0;border-radius:4px;padding:1px 8px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:13px;line-height:20px;cursor:pointer;font-variant-numeric:tabular-nums}
.hapi-source-usage-trigger svg{width:14px;height:14px;flex:none}.hapi-source-usage-trigger span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hapi-source-usage-trigger:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.hapi-source-usage-dialog{width:min(360px,calc(100vw - 24px))!important}
.hapi-source-usage-details{display:grid;grid-template-columns:auto auto;gap:8px;font-size:13px}.hapi-source-usage-details dd{margin:0;text-align:right;font-variant-numeric:tabular-nums}
@media(pointer:coarse){.hapi-source-usage-trigger{min-height:44px}}
`
