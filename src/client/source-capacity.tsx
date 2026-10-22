import { useEffect, useState } from 'react'
import type { HapiProjection } from '../codex/projection-types.ts'
type Runtime = NonNullable<HapiProjection>['execution']
import type { WorkspaceTranslate } from './locales.ts'
import { translate } from './diagnostics/index.ts'

export function currentCapacity(execution: Runtime | undefined) {
    const recovery = execution?.capacityRecovery
    return recovery && recovery.turnId === execution?.turnId && ['active', 'systemError'].includes(execution.status)
        && (recovery.phase !== 'retrying' || execution.status === 'active') ? recovery : null
}
/** A display timer only. Cancellation goes to the same native Agent as Stop. */
export function CapacityRecoveryStatus({ execution, stop, t }: {
    execution: Runtime; stop: (() => Promise<unknown>) | undefined; t: WorkspaceTranslate
}) {
    const recovery = currentCapacity(execution), [now, setNow] = useState(Date.now), [busy, setBusy] = useState(false), [error, setError] = useState('')
    useEffect(() => {
        setError(''); setNow(Date.now())
        if (recovery?.phase !== 'waiting') return
        const timer = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(timer)
    }, [recovery?.turnId, recovery?.phase, recovery?.retryAt])
    if (!recovery) return null
    const phases = { waiting: ['Waiting to retry', '等待重试'], retrying: ['Retrying', '正在重试'],
        continuing: ['Continuing native goal', '正在继续原生目标'], failed: ['Recovery stopped', '恢复已停止'] } as const
    const phase = phases[recovery.phase]
    return <section data-hapi-capacity={recovery.phase} role="status">
        <strong>{translate(t, 'Source capacity recovery', '源端容量恢复')}</strong>
        <p>{translate(t, phase[0], phase[1])}{recovery.retryAt && recovery.phase === 'waiting' ? ` · ${Math.max(0, Math.ceil((recovery.retryAt - now) / 1000))}s` : ''}
            {recovery.attempt ? ` · ${recovery.attempt}/${recovery.maxAttempts ?? '—'}` : ''}</p>
        {recovery.reason && <p>{translate(t, { exhausted: 'Retry limit reached', unverified: 'Continuation could not be verified', unconfirmed: 'Source acceptance is unconfirmed' }[recovery.reason],
            { exhausted: '已达到重试上限', unverified: '无法核实继续条件', unconfirmed: '源端尚未确认接收' }[recovery.reason])}</p>}
        {stop && ['waiting', 'continuing'].includes(recovery.phase) && <button type="button" disabled={busy} onClick={() => {
            setBusy(true); setError(''); void stop().catch(reason => setError(String(reason))).finally(() => setBusy(false))
        }}>{translate(t, busy ? 'Awaiting source' : 'Cancel recovery', busy ? '等待源端确认' : '取消恢复')}</button>}
        {error && <p role="alert">{error}</p>}
    </section>
}
