/** Native related-task presentation; read ownership lives in the unchanged state leaf. */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Button, Checkbox, IconChevronDownOutlineRegular, IconChevronLeftOutlineRegular, IconChevronRightOutlineRegular, IconCloseOutlineRegular, IconRefreshOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { NativeHistoryTarget } from './sidebar-search-query.ts'
import { NativeThreadHistory } from './remote-native-history-state.ts'
export { NativeThreadHistory, type NativeThreadHistorySnapshot } from './remote-native-history-state.ts'
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause)

export function RemoteNativeHistoryPanel({ controller, threadId, open, origin, language = 'en', active = true }: {
    controller: NativeThreadHistory; threadId: string; open(target: NativeHistoryTarget): void | Promise<void>
    origin?: NativeHistoryTarget; language?: string; active?: boolean
}) {
    const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot), generation = useRef(0)
    const [opening, setOpening] = useState(false), [error, setError] = useState(''), zh = language.startsWith('zh')
    useEffect(() => { ++generation.current; setOpening(false); setError(''); return () => { ++generation.current } }, [controller, threadId])
    useEffect(() => { if (active && controller.getSnapshot().nativeId !== threadId) void controller.refresh(threadId) }, [controller, threadId, active])
    const run = async (action: () => void | Promise<void>) => {
        const current = generation.current; setOpening(true); setError('')
        try { await action() } catch (cause) { if (current === generation.current) setError(message(cause)) }
        finally { if (current === generation.current) setOpening(false) }
    }
    const tr = (en: string, cn: string) => zh ? cn : en
    const status = (value: string) => ({ completed: tr('Completed', '已完成'), interrupted: tr('Interrupted', '已中断'), failed: tr('Failed', '失败'), inProgress: tr('Running', '执行中'), notLoaded: tr('Saved', '已保存'), active: tr('Running', '执行中'), idle: tr('Idle', '空闲'), systemError: tr('Unavailable', '暂不可用') }[value] ?? tr('Status unavailable', '状态暂不可用'))
    return <section className="hhpi-native-history" aria-label={zh ? '父子任务历史' : 'Related task history'}>
        <header className="hhpi-related-header"><h3>{tr('Related tasks', '父子任务')}</h3><div>
            {state.origin && <Button size="sm" variant="ghost" icon={<IconChevronLeftOutlineRegular size={14}/>} disabled={opening}
                aria-label={tr('Return to conversation', '返回原会话')} onClick={() => { void run(() => controller.returnToOrigin(open)) }}>{tr('Return', '返回')}</Button>}
            <Button size="sm" variant="toolbar" disabled={state.busy} aria-label={tr('Refresh tasks', '刷新任务')} title={tr('Refresh tasks', '刷新任务')}
                onClick={() => { void controller.refresh(threadId) }}><IconRefreshOutlineRegular size={16}/></Button>
        </div></header>
        {state.root && <div className="hhpi-related-current"><p className="hhpi-related-current-title" title={state.root.title}>{state.root.title}</p>
            <p className="hhpi-related-context"><span>{status(state.root.status)}</span><span title={state.root.cwd}>{state.root.cwd}</span></p></div>}
        <div className="hhpi-related-filters">{state.root?.parentThreadId && <Button size="sm" variant="ghost" icon={<IconChevronLeftOutlineRegular size={14}/>} disabled={opening}
            onClick={() => { void run(() => controller.parent(open, origin)) }}>{tr('Parent task', '父任务')}</Button>}
            <Checkbox checked={state.archived} onChange={archived => { void controller.refresh(threadId, archived) }} label={tr('Archived tasks', '已归档任务')}/></div>
        {state.busy && <p role="status">{tr('Loading tasks…', '正在读取任务…')}</p>}
        {(state.error || error) && <p role="alert">{state.error || error}</p>}
        {!state.busy && !state.error && !state.children.length && <p className="hhpi-related-empty">{tr(state.archived ? 'No archived subtasks.' : 'No subtasks.', state.archived ? '没有已归档的子任务。' : '没有子任务。')}</p>}
        {state.detailBusy && <p role="status">{tr('Loading result…', '正在读取结果…')}</p>}
        {state.detailError && <p role="alert">{state.detailError}</p>}
        <ul className="hhpi-related-list">{state.children.map(row => <li key={row.sessionId}>
            <div className="hhpi-related-row"><Button size="sm" variant="ghost" className="hhpi-related-open" disabled={opening}
                aria-label={`${tr('Open task', '打开任务')}: ${row.title}`} onClick={() => { void run(() => controller.open(row, open, origin)) }}>
                <span className="hhpi-related-labels"><strong>{row.title}</strong><span className="hhpi-related-meta">
                    <span>{status(row.status)}</span>{row.nickname && row.nickname !== row.title && <small>{row.nickname}</small>}
                    {row.cwd !== state.root?.cwd && <small title={row.cwd}>{row.cwd}</small>}</span></span><IconChevronRightOutlineRegular size={14}/>
            </Button><Button size="sm" variant="toolbar" disabled={state.detailBusy} title={tr('View result', '查看结果')} aria-label={`${tr('View result', '查看结果')}: ${row.title}`}
                aria-expanded={state.detail?.row.sessionId === row.sessionId} onClick={() => { if (state.detail?.row.sessionId === row.sessionId) controller.closeDetail(); else void run(() => controller.inspect(row)) }}><IconChevronDownOutlineRegular size={16}/></Button></div>
            {state.detail?.row.sessionId === row.sessionId && <section className="hhpi-related-result" aria-label={tr('Task result', '任务结果')}>
                <header><h4>{state.detail.row.title}</h4><Button size="sm" variant="toolbar" aria-label={tr('Close result', '关闭结果')} onClick={() => controller.closeDetail()}><IconCloseOutlineRegular size={14}/></Button></header>
                <p>{state.detail.lastTurn ? `${tr('Latest result: ', '最近结果：')}${status(state.detail.lastTurn.status)}` : tr('No recorded result.', '暂无已记录的结果。')}</p>
                {state.detail.lastTurn?.error && <p role="alert">{state.detail.lastTurn.error}</p>}
                <details><summary>{tr('Technical details', '技术详情')}</summary><dl><dt>{tr('Directory', '目录')}</dt><dd>{state.detail.row.cwd}</dd>
                    <dt>{tr('Native ID', '原生 ID')}</dt><dd><code>{state.detail.row.nativeId}</code></dd><dt>{tr('Source state', '来源状态')}</dt><dd>{state.detail.row.status}</dd></dl></details>
            </section>}
        </li>)}</ul>
        {state.nextCursor && <Button size="sm" variant="ghost" disabled={state.busy} onClick={() => { void controller.next() }}>{tr('More tasks', '更多任务')}</Button>}
    </section>
}

export const nativeHistoryStyles = `
.hhpi-native-history{padding:12px;min-width:0;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary)}
.hhpi-related-header,.hhpi-related-header>div,.hhpi-related-filters,.hhpi-related-row,.hhpi-related-result>header{display:flex;align-items:center;gap:8px}
.hhpi-related-header{justify-content:space-between;position:sticky;top:0;z-index:1;background:var(--dsw-alias-bg-base);padding:4px 0 8px}
.hhpi-related-header h3,.hhpi-related-result h4{margin:0;font-size:14px;font-weight:600;min-width:0;overflow-wrap:anywhere}
.hhpi-native-history p{margin:5px 0;white-space:pre-wrap;overflow-wrap:anywhere}
.hhpi-related-current{margin-bottom:10px}.hhpi-related-current-title{font-weight:500;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}
.hhpi-related-context{display:flex;gap:8px;color:var(--dsw-alias-label-secondary);font-size:12px}.hhpi-related-context>span:last-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hhpi-related-filters{justify-content:space-between;min-height:28px;margin-bottom:4px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.hhpi-related-list{padding:0;margin:0;list-style:none}.hhpi-related-list>li{padding:3px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}
.hhpi-related-row{gap:4px}.hhpi-related-open{flex:1;min-width:0;height:auto!important;min-height:44px;justify-content:flex-start!important;text-align:left;padding:6px 8px!important}
.hhpi-related-open>svg{flex:none;margin-inline-start:auto}.hhpi-related-labels{display:flex;flex:1;flex-direction:column;min-width:0;gap:1px}.hhpi-related-labels>strong{font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hhpi-related-meta{display:flex;gap:8px;align-items:center;font-size:12px;color:var(--dsw-alias-label-secondary);min-width:0}.hhpi-related-meta small{font:inherit;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hhpi-related-result{margin:2px 8px 8px;padding:10px 12px;border-radius:10px;background:var(--dsw-alias-bg-l1,var(--dsw-alias-bg-base));font-size:12px}.hhpi-related-result>header{justify-content:space-between}.hhpi-related-result h4{font-size:12px}
.hhpi-related-result details{margin-top:8px;color:var(--dsw-alias-label-secondary)}.hhpi-related-result summary{cursor:pointer}.hhpi-related-result dl{margin:8px 0}.hhpi-related-result dt{font-weight:500;margin-top:6px}.hhpi-related-result dd{margin:0;overflow-wrap:anywhere}.hhpi-related-result code{font-size:11px}
.hhpi-related-empty{color:var(--dsw-alias-label-secondary);padding:8px}.hhpi-native-history [role=alert]{color:var(--dsw-alias-label-error,var(--text-error))}
`
