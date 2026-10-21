import type { CatalogMachine } from '../client-api.ts'
import type { SourceMachineHealth } from '../source-machine-types.ts'
import { machineHealthPresentation } from './machine-health.ts'

export function MachineHealthStats({ health, platform, online, language }: {
    health: SourceMachineHealth | null | undefined; platform: string | undefined; online: boolean; language: string
}) {
    const presentation = machineHealthPresentation(health, platform), zh = language.startsWith('zh')
    const tr = (en: string, cn: string) => zh ? cn : en
    if (!presentation) return <p>{tr('The Runner has not reported a health sample.', 'Runner 尚未上报健康数据。')}</p>
    const statuses = { ok: tr('Normal', '正常'), warn: tr('Elevated load', '负载较高'), critical: tr('High load', '高负载'), unknown: tr('Not reported', '未上报') }
    return <div className="hapi-machine-health" data-health-tone={presentation.tone} style={{ fontSize: '12px', padding: '6px 0', overflowWrap: 'anywhere' }}>
        <p style={{ margin: '0 0 5px' }}>{online ? statuses[presentation.tone] : tr('Offline · last reported sample', '离线 · 最后上报的数据')}</p>
        <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'minmax(4rem,auto) minmax(0,1fr)', gap: '4px 8px' }}>
            {presentation.metrics.map(metric => <div key={metric.id} style={{ display: 'contents' }}><dt>{metric.label}</dt><dd style={{ margin: 0 }}>
                {metric.percent}% <meter aria-label={`${metric.label} ${tr('usage', '使用率')}`} min={0} max={100} value={metric.percent} low={75} high={90} optimum={0} style={{ width: '70px', maxWidth: '100%' }}/>
            </dd></div>)}
            {presentation.load !== null && <><dt>{tr('Load / cores', '负载 / 核心')}</dt><dd style={{ margin: 0 }}>{presentation.load}</dd></>}
            {presentation.uptime !== null && <><dt>{tr('Uptime', '运行时间')}</dt><dd style={{ margin: 0 }}>{presentation.uptime}</dd></>}
            <dt>{tr('Sample time', '采样时间')}</dt><dd style={{ margin: 0 }}><time dateTime={new Date(presentation.collectedAt).toISOString()}>{new Date(presentation.collectedAt).toLocaleString()}</time></dd>
        </dl>
    </div>
}

export function MachineHealthRow({ machine, language }: { machine: CatalogMachine; language: string }) {
    const tr = (en: string, cn: string) => language.startsWith('zh') ? cn : en
    const presentation = machineHealthPresentation(machine.health, machine.platform)
    return <details className="hapi-machine-row" data-source-machine={machine.id} style={{ padding: '5px 0' }}>
        <summary style={{ cursor: 'pointer', overflowWrap: 'anywhere' }}><span className={`hapi-dot hapi-dot-${machine.online ? 'running' : 'offline'}`}/>{machine.label}
            <small style={{ marginInlineStart: '6px' }}>{machine.online ? tr('Online', '在线') : tr('Offline', '离线')}</small>
            {!!presentation?.metrics.length && <span style={{ display: 'block', fontSize: '11px', opacity: 0.8 }}>{presentation.metrics.map(row => `${row.label} ${row.percent}%`).join(' · ')}</span>}
        </summary>
        <div style={{ display: 'block', paddingInlineStart: '10px' }}>
            {machine.host && machine.host.toLocaleLowerCase() !== machine.label.toLocaleLowerCase() && <p>{machine.host}</p>}
            {(machine.platform || machine.version) && <p style={{ fontSize: '12px' }}>{[machine.platform, machine.version ? `HAPI ${machine.version}` : ''].filter(Boolean).join(' · ')}</p>}
            <MachineHealthStats health={machine.health} platform={machine.platform} online={machine.online} language={language}/>
            {machine.lastSeenAt !== undefined && <p style={{ fontSize: '11px' }}>{tr('Last seen', '最后在线')} · {new Date(machine.lastSeenAt).toLocaleString()}</p>}
        </div>
    </details>
}
