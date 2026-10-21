import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { AssistantActionOwnerProps, TurnTailOwnerProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import { IconCheckOutlineRegular, IconCopyOutlineRegular, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SourceAdminApi } from '../source-admin-types.ts'
import { remoteValue } from '../client-api.ts'
import type { NotifySummary, SourceNotifySummary } from '../hapi-agent/notify-summary.ts'
import type {} from '../codex/projection-types.ts'
import type {} from '../hapi-agent/projection-types.ts'
import type {} from './workspace-ui.ts'
import { SOURCE_SUMMARY_DATA, sourceSummaryDefinition } from './notify-summary-conversation.ts'
import type { SourceSummaryCoordinator } from './notify-summary-state.ts'

type SummaryApi = Pick<SourceAdminApi, 'sourceSummarySettings'>
type TailProps = PropsRuntime<'conversation.chat.turnTail'> & PropsLocale<'chat'> & TurnTailOwnerProps
type ActionProps = PropsRuntime<'conversation.chat.assistant-actions'> & PropsLocale<'chat'> & AssistantActionOwnerProps
const hidden = { getSnapshot: () => false, subscribe: (_listener: () => void) => () => {} }

function useSummaryPreference(coordinator: SourceSummaryCoordinator, api: SummaryApi, hubId: string | undefined): boolean {
    const preference = useMemo(() => hubId ? coordinator.forHub(hubId) : undefined, [coordinator, hubId])
    useEffect(() => preference?.retain(async () => remoteValue(await api.sourceSummarySettings())), [api, preference])
    return useSyncExternalStore(preference?.subscribe ?? hidden.subscribe, preference?.getSnapshot ?? hidden.getSnapshot)
}

const cssString = (value: string): string => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\n\r\f]/g, '\\a ')}"`

/**
 * Compatibility point pinned to DSH 0.2.1-rc.2's MessageIconActions DOM.
 * The upstream Copy has no independent public slot. A completed source turn
 * with our own closing-copy marker hides only that first built-in Copy button.
 * Every other official/plugin action and all ordinary DSH turns stay untouched.
 * There is no DOM inspection, event interception, or upstream component patch.
 */
export function sourceSummaryCopySelector(copy: string, copied: string): string {
    return `[data-turn-tail] [data-clock="end"]:has(> [data-slot="conversation.chat.assistant-actions"] > button[data-hapi-summary-copy="closing"]) > button:first-child:is([aria-label=${cssString(copy)}],[aria-label=${cssString(copied)}])`
}

function SourceCopy({ record, closing, t }: { record: SourceNotifySummary; closing: boolean; t: PropsLocale<'chat'>['t'] }) {
    const [copied, setCopied] = useState(false), pending = useRef(false), alive = useRef(true)
    const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
    useEffect(() => { alive.current = true; return () => { alive.current = false; if (timer.current !== undefined) clearTimeout(timer.current) } }, [])
    const copy = async (): Promise<void> => {
        if (copied || pending.current) return
        pending.current = true
        try {
            if (!await writeClipboard(record.originalText) || !alive.current) return
            setCopied(true)
            timer.current = setTimeout(() => { timer.current = undefined; if (alive.current) setCopied(false) }, 1000)
        } finally { pending.current = false }
    }
    return <>
        {closing && <style>{`${sourceSummaryCopySelector(t('copy'), t('copied'))}{display:none!important}`}</style>}
        <button type="button" className="hapi-summary-copy" data-hapi-summary-copy={closing ? 'closing' : 'footer'}
            aria-label={copied ? t('copied') : t('copy')} title={copied ? t('copied') : t('copy')} onClick={() => { void copy() }}>
            {copied ? <IconCheckOutlineRegular/> : <IconCopyOutlineRegular/>}
        </button>
    </>
}

const presentations: Readonly<Record<string, { en: string; zh: string; tone: string }>> = {
    done: { en: 'Done', zh: '已完成', tone: 'success' }, blocked: { en: 'Blocked', zh: '受阻', tone: 'warning' },
    needs_review: { en: 'Needs review', zh: '需要检查', tone: 'warning' }, needs_decision: { en: 'Needs decision', zh: '需要决定', tone: 'warning' },
    failed: { en: 'Failed', zh: '失败', tone: 'error' }, stalled: { en: 'Stalled', zh: '停滞', tone: 'warning' },
}
function SummaryFooter({ summary, language }: { summary: NotifySummary; language: string }) {
    const text = summary.summary?.trim() ?? '', action = summary.action?.trim() ?? '', status = summary.status?.trim().toLowerCase() ?? ''
    if (!text && !action && !status) return null
    const known = presentations[status], zh = language.startsWith('zh')
    const label = known ? zh ? known.zh : known.en : status ? status.replaceAll('_', ' ').replace(/\b\w/g, value => value.toUpperCase()) : zh ? '摘要' : 'Summary'
    return <div className="hapi-notify-summary" role="status" aria-label={zh ? '任务摘要' : 'Task summary'} data-hapi-summary-footer="true">
        <span className="hapi-summary-status" data-tone={known?.tone} aria-label={label}>
            {status === 'done' ? <span aria-hidden="true">✓</span> : <><span className="hapi-summary-dot" aria-hidden="true"/><span>{label}</span></>}
        </span>
        {text && <span className="hapi-summary-text">{text}</span>}
        {action && action !== text && <><span className="hapi-summary-arrow" aria-hidden="true">→</span><span className="hapi-summary-next">{action}</span></>}
    </div>
}

/** Add owned data and controls through public Conversation list extensions. */
export function installNotifySummaryDisplay(ctx: Context, api: SummaryApi): () => void {
    const scope = ctx.inject(['hapiWorkspaceUi'], owner => {
        const coordinator = owner.hapiWorkspaceUi.sourceSummaries
        const readLanguage = () => owner.locale.getSnapshot().active
        const Tail = (props: TailProps) => {
            const native = props.useProjection('hapi'), observed = props.useProjection('hapiObserved')
            const show = useSummaryPreference(coordinator, api, native?.hubId ?? observed?.hubId)
            const language = useSyncExternalStore(listener => owner.locale.subscribe(listener), readLanguage)
            const source = props.turn.data.source(SOURCE_SUMMARY_DATA), officialTail = props.turn.data.source('turn-tail')
            const records = useSyncExternalStore(source.subscribe, source.getSnapshot)
            const tail = useSyncExternalStore(officialTail.subscribe, officialTail.getSnapshot)
            if (!show || !(native || observed) || !records?.length) return null
            return <div className="hapi-summary-turn" data-hapi-summary-turn={props.turn.turn}>
                {records.map(record => <div key={record.messageId} className="hapi-summary-message" data-hapi-summary-message={record.messageId}>
                    {record.summaries.map(value => <SummaryFooter key={value.blockIndex} summary={value.summary} language={language}/>)}
                    {tail?.closing?.finalNode.messageId !== record.messageId && <SourceCopy record={record} closing={false} t={props.t}/>}
                </div>)}
            </div>
        }
        const Action = (props: ActionProps) => {
            const native = props.useProjection('hapi'), observed = props.useProjection('hapiObserved')
            const show = useSummaryPreference(coordinator, api, native?.hubId ?? observed?.hubId)
            const record = props.useChat(snapshot => {
                for (const turn of snapshot.timeline.turns.values()) {
                    const summary = turn.data.get(SOURCE_SUMMARY_DATA)?.find(value => value.messageId === props.messageId)
                    if (summary) return summary
                }
                return undefined
            })
            return show && (native || observed) && record ? <SourceCopy record={record} closing t={props.t}/> : null
        }
        const disposers = [owner.uiConversation.events.register(sourceSummaryDefinition),
            owner.slots.inject('conversation.chat.turnTail', () => owner.slots.register({
                name: 'conversation.chat.turnTail', id: 'hapi.notify-summary', order: 30, locale: 'chat',
            }, Tail)),
            owner.slots.inject('conversation.chat.assistant-actions', () => owner.slots.register({
                name: 'conversation.chat.assistant-actions', id: 'hapi.notify-summary-copy', order: -10, locale: 'chat',
            }, Action)),
        ]
        const style = document.createElement('style'); style.textContent = styles; document.head.append(style)
        return () => { for (const dispose of disposers.reverse()) dispose(); style.remove() }
    })
    return () => { void scope.dispose() }
}

const styles = `
.hapi-summary-turn{min-width:0;width:100%}.hapi-summary-message{min-width:0}
.hapi-notify-summary{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:start;gap:2px 8px;border-top:1px solid var(--border-secondary,#8883);padding-top:8px;margin-top:8px;line-height:1.5;font-size:13px;overflow-wrap:anywhere}
.hapi-summary-status{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--text-secondary,#888)}.hapi-summary-status[data-tone=success]{color:#36995b}.hapi-summary-status[data-tone=warning]{color:#ba8429}.hapi-summary-status[data-tone=error]{color:#cf5b5b}.hapi-summary-dot{width:5px;height:5px;border-radius:100%;background:currentColor;flex-shrink:0}.hapi-summary-arrow{grid-column:1;color:var(--text-secondary,#888);text-align:center}.hapi-summary-next{grid-column:2;color:var(--text-secondary,#888);font-size:12px}
.hapi-summary-copy{display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;width:26px;height:26px;border:0;background:transparent;color:var(--text-secondary,#888);border-radius:5px;cursor:pointer}.hapi-summary-copy:hover{background:var(--bg-hover,#8882);color:var(--text-primary,inherit)}.hapi-summary-copy svg{width:16px;height:16px}.hapi-summary-message>.hapi-summary-copy{margin-top:4px}
`
