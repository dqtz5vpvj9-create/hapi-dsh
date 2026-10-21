/** Additive metadata owned by the real source session. The official header,
 * lineage, menus and contributions from every other plugin remain mounted. */
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { HapiProjection } from '../../codex/projection-types.ts'
import type { HapiObservedProjection } from '../../hapi-agent/projection-types.ts'
import type { WorkspaceCatalogRow } from '../controller.ts'
import { sourceIdentity } from '../../workspace/legacy.ts'
import type { AppearanceState } from './state.ts'
import type { HeaderField, HeaderPreferences } from './preferences.ts'
import type {} from '../pane-navigation.ts'

const emptySubscribe = (): (() => void) => () => {}
const noRow = (): undefined => undefined
export const HEADER_LABELS: Record<HeaderField, [string, string]> = {
    showLabels: ['Show field labels', '显示字段名称'], agent: ['Agent', '代理'], model: ['Model', '模型'], reasoning: ['Reasoning', '推理强度'],
    fastMode: ['Fast mode', '快速模式'], machine: ['Machine', '机器'], lastActive: ['Last active', '最近活动'],
    createdAt: ['Created', '创建时间'], updatedAt: ['Updated', '更新时间'], worktree: ['Worktree', '工作树'],
}
export interface HeaderFact { key: Exclude<HeaderField, 'showLabels'>; value: string; absolute?: number }
/** HAPI's DSH model identifier is an opaque [provider, model] pair. Only its
 * display label is formatted; selection and execution keep the original id. */
export function sourceHeaderModel(value: string | null, flavor: string): string | null {
    if (value === null || flavor !== 'dsh') return value
    try {
        const pair: unknown = JSON.parse(value)
        if (Array.isArray(pair) && pair.length === 2 && pair.every(part => typeof part === 'string')) {
            const [provider, model] = pair as [string, string]
            return `${model.replace(/^deepseek/i, 'DeepSeek').replace(/-v(\d)/i, '-V$1').replace(/-flash$/i, '-Flash')} · ${provider}`
        }
    } catch { /* Bare source model ids remain valid. */ }
    return value
}
const SOURCE_AGENT_LABELS: Readonly<Record<string, string>> = {
    codex: 'Codex', claude: 'Claude', dsh: 'DSH', pi: 'Pi', gemini: 'Gemini', cursor: 'Cursor',
    'cursor-acp': 'Cursor ACP', qoder: 'Qoder', opencode: 'OpenCode', 'kimi-cli': 'Kimi CLI',
}
export function sourceHeaderFacts(native: HapiProjection, observed: HapiObservedProjection, catalog: WorkspaceCatalogRow | undefined,
    preferences: HeaderPreferences, locale: string, now = Date.now()): HeaderFact[] {
    const source = native ?? observed
    if (!source || observed?.sidechain) return []
    const identity = catalog && sourceIdentity(catalog)
    const row = identity?.hubId === source.hubId && identity.sessionId === source.hapiSessionId ? catalog : undefined
    const facts: HeaderFact[] = []
    const add = (key: HeaderFact['key'], value: string | null | undefined): void => { if (preferences[key] && value) facts.push({ key, value }) }
    const flavor = native ? 'codex' : observed?.flavor ?? ''
    add('agent', SOURCE_AGENT_LABELS[flavor] ?? flavor)
    add('machine', source.machineName ?? source.machineId)
    add('model', sourceHeaderModel(source.model, flavor))
    add('reasoning', native?.reasoningEffort ?? observed?.effort)
    if (row?.sourceRowState?.serviceTier === 'fast') add('fastMode', 'FAST')
    const lastActive = row?.sourceLastActiveAt
    if (preferences.lastActive && typeof lastActive === 'number' && Number.isFinite(lastActive) && lastActive > 0) {
        const seconds = (lastActive - now) / 1000, magnitude = Math.abs(seconds)
        const [divisor, unit] = magnitude < 60 ? [1, 'second'] : magnitude < 3600 ? [60, 'minute']
            : magnitude < 86400 ? [3600, 'hour'] : [86400, 'day']
        facts.push({ key: 'lastActive', value: new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(Math.round(seconds / Number(divisor)), unit as Intl.RelativeTimeFormatUnit), absolute: lastActive })
    }
    for (const key of ['createdAt', 'updatedAt'] as const) {
        const value = key === 'createdAt' ? row?.sourceCreatedAt : row?.updatedAt
        if (preferences[key] && typeof value === 'number' && Number.isFinite(value) && value > 0) facts.push({
            key, value: new Date(value).toLocaleString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }), absolute: value,
        })
    }
    add('worktree', row?.sourceWorktree?.branch)
    return facts
}

export function sourceHeader(ctx: Context, state: AppearanceState) {
    return function SourceHeader({ useProjection }: PropsRuntime<'conversation.session.header.utilities'>) {
        const native = useProjection('hapi'), observed = useProjection('hapiObserved')
        const appearance = useSyncExternalStore(state.subscribe, state.getSnapshot)
        const locale = useSyncExternalStore(listener => ctx.locale.subscribe(listener), () => ctx.locale.getSnapshot().active)
        const navigation = ctx.get('hapiWorkspacePane'), catalog = useSyncExternalStore(navigation?.catalog.subscribe ?? emptySubscribe, navigation?.catalog.getSnapshot ?? noRow)
        const [now, setNow] = useState(Date.now)
        useEffect(() => {
            if (!appearance.header.lastActive) return
            const timer = setInterval(() => { setNow(Date.now()) }, 60_000)
            return () => { clearInterval(timer) }
        }, [appearance.header.lastActive])
        const facts = sourceHeaderFacts(native ?? null, observed ?? null, catalog, appearance.header, locale, now), chinese = locale.startsWith('zh')
        const mobileSecondary = ['machine', 'lastActive', 'model', 'reasoning', 'fastMode', 'createdAt', 'updatedAt', 'worktree'].find(key => facts.some(fact => fact.key === key))
        if (!facts.length) return null
        return <div className="hapi-source-header-metadata" aria-label={chinese ? '源会话信息' : 'Source session information'}>
            {facts.map(fact => <span key={fact.key} data-hapi-header-field={fact.key} data-hapi-mobile-secondary={fact.key === mobileSecondary ? '' : undefined} title={fact.absolute ? new Date(fact.absolute).toLocaleString(locale) : fact.value}>
                {appearance.header.showLabels && <span className="hapi-source-header-label">{HEADER_LABELS[fact.key][chinese ? 1 : 0]}: </span>}{fact.value}
            </span>)}
        </div>
    }
}
