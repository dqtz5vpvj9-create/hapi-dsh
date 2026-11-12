/** Additive metadata owned by the real source session. The official header,
 * lineage, menus and contributions from every other plugin remain mounted. */
import { useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SourceSession } from '../../remote/protocol.ts'
import type {} from '../remote-sessions.ts'
import { readableEngine, readableHost, readableModel } from '../locales.ts'
import type { AppearanceState } from './state.ts'
import type { HeaderField, HeaderPreferences } from './preferences.ts'

export const HEADER_LABELS: Record<HeaderField, [string, string]> = {
    showLabels: ['Show field labels', '显示字段名称'], agent: ['Agent', '代理'], model: ['Model', '模型'], reasoning: ['Reasoning', '推理强度'],
    fastMode: ['Fast mode', '快速模式'], machine: ['Machine', '机器'], lastActive: ['Last active', '最近活动'],
    createdAt: ['Created', '创建时间'], updatedAt: ['Updated', '更新时间'], worktree: ['Worktree', '工作树'],
}
export const CURRENT_HEADER_FIELDS = ['showLabels', 'agent', 'model', 'reasoning', 'machine', 'updatedAt'] as const satisfies readonly HeaderField[]
export interface HeaderFact { key: Exclude<HeaderField, 'showLabels'>; value: string; absolute?: number }
const SOURCE_AGENT_LABELS: Readonly<Record<string, string>> = {
    codex: 'Codex', claude: 'Claude', dsh: 'DSH', pi: 'Pi', gemini: 'Gemini', cursor: 'Cursor',
    'cursor-acp': 'Cursor ACP', qoder: 'Qoder', opencode: 'OpenCode', 'kimi-cli': 'Kimi CLI',
}
export function sourceHeaderFacts(source: SourceSession | undefined,
    preferences: HeaderPreferences, locale: string): HeaderFact[] {
    if (!source) return []
    const facts: HeaderFact[] = []
    const add = (key: HeaderFact['key'], value: string | null | undefined): void => { if (preferences[key] && value) facts.push({ key, value }) }
    add('agent', SOURCE_AGENT_LABELS[source.engine] ?? readableEngine(source.engine))
    add('machine', readableHost(source.machineId))
    add('model', readableModel(source.codex?.model))
    add('reasoning', readableEngine(source.codex?.reasoningEffort))
    // The source owns this timestamp. A catalog proxy's update time is not
    // evidence of creation, execution completion, or a separate last-active time.
    if (preferences.updatedAt && Number.isFinite(source.updatedAt) && source.updatedAt > 0) facts.push({
        key: 'updatedAt', value: new Date(source.updatedAt).toLocaleString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }), absolute: source.updatedAt,
    })
    return facts
}

export function sourceHeader(ctx: Context, state: AppearanceState) {
    return function SourceHeader({ useProjection }: PropsRuntime<'conversation.session.header.utilities'>) {
        const source = useProjection('hhpiSource')
        const appearance = useSyncExternalStore(state.subscribe, state.getSnapshot)
        const locale = useSyncExternalStore(listener => ctx.locale.subscribe(listener), () => ctx.locale.getSnapshot().active)
        const facts = sourceHeaderFacts(source, appearance.header, locale), chinese = locale.startsWith('zh')
        const mobileSecondary = ['machine', 'model', 'reasoning', 'updatedAt'].find(key => facts.some(fact => fact.key === key))
        if (!facts.length) return null
        return <div className="hapi-source-header-metadata" aria-label={chinese ? '源会话信息' : 'Source session information'}>
            {facts.map(fact => <span key={fact.key} data-hapi-header-field={fact.key} data-hapi-mobile-secondary={fact.key === mobileSecondary ? '' : undefined} title={fact.absolute ? new Date(fact.absolute).toLocaleString(locale) : fact.value}>
                {appearance.header.showLabels && <span className="hapi-source-header-label">{HEADER_LABELS[fact.key][chinese ? 1 : 0]}: </span>}{fact.value}
            </span>)}
        </div>
    }
}
