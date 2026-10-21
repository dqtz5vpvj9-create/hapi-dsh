/** Source thresholds and uptime formatting adapted from HAPI web/src/lib/machineHealth.ts
 * at 0f8ef697, AGPL-3.0-only. No local machine sampling is performed here. */
import type { SourceMachineHealth } from '../source-machine-types.ts'
export type HealthTone = 'ok' | 'warn' | 'critical' | 'unknown'
const percentTone = (value: number): HealthTone => value >= 90 ? 'critical' : value >= 75 ? 'warn' : 'ok'

export function machineUptime(totalSeconds: number): string | null {
    if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return null
    const seconds = Math.floor(totalSeconds), days = Math.floor(seconds / 86_400), hours = Math.floor(seconds % 86_400 / 3600), minutes = Math.floor(seconds % 3600 / 60)
    return days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes}m` : minutes ? `${minutes}m` : `${seconds}s`
}
export function machineHealthPresentation(health: SourceMachineHealth | null | undefined, platform?: string) {
    if (!health) return null
    const metrics: Array<{ id: 'cpu' | 'ram'; label: string; percent: number; tone: HealthTone }> = []
    if (health.cpuPercent !== undefined) metrics.push({ id: 'cpu', label: 'CPU', percent: health.cpuPercent, tone: percentTone(health.cpuPercent) })
    if (health.memoryPercent !== undefined) metrics.push({ id: 'ram', label: 'RAM', percent: health.memoryPercent, tone: percentTone(health.memoryPercent) })
    const load = platform !== 'win32' ? health.load1m : undefined
    const tones = metrics.map(row => row.tone)
    if (load !== undefined) { const ratio = load / (health.cpuCount ?? 1); tones.push(ratio >= 1.5 ? 'critical' : ratio >= 1 ? 'warn' : 'ok') }
    const tone: HealthTone = tones.includes('critical') ? 'critical' : tones.includes('warn') ? 'warn' : tones.length ? 'ok' : 'unknown'
    return { metrics, tone, collectedAt: health.collectedAt,
        load: load === undefined ? null : `${load.toFixed(1)}${health.cpuCount ? `/${health.cpuCount}` : ''}`,
        uptime: health.uptimeSeconds === undefined ? null : machineUptime(health.uptimeSeconds), cpuCount: health.cpuCount,
    }
}
