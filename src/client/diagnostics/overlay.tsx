/** Low-weight "诊断 N" chip and copyable diagnostics drawer.
 *
 * Own overlay only: inline styles, no workspace stylesheet and no transcript
 * node. One overlay exists per browser page; pane graphs report into one buffer.
 * The drawer shows allowlisted operational fields only (no bodies/prompts/URLs).
 */
import { useCallback, useRef, useState, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { diagnosticsBuildContext, type DiagnosticEntry, type DiagnosticsCore, type DiagnosticsSnapshot } from './state.ts'

interface UiText {
  chip: string; title: string; copy: string; copied: string; copyFailed: string
  clear: string; cleared: string; close: string; empty: string
}

const zh = (): boolean => {
  const language = typeof navigator === 'undefined' ? '' : navigator.language
  return language.toLowerCase().startsWith('zh')
}

const text = (): UiText => zh()
  ? { chip: '诊断', title: '诊断', copy: '复制全部', copied: '已复制到剪贴板', copyFailed: '复制失败，请手动选择文本复制',
      clear: '清空', cleared: '已清空', close: '关闭', empty: '暂无诊断记录' }
  : { chip: 'Diagnostics', title: 'Diagnostics', copy: 'Copy all', copied: 'Copied to clipboard', copyFailed: 'Copy failed; select the text manually',
      clear: 'Clear', cleared: 'Cleared', close: 'Close', empty: 'No diagnostics recorded' }

const styles = {
  chip: {
    position: 'fixed', right: '12px', bottom: '12px', zIndex: 2147483000, border: '1px solid var(--dsw-alias-border-l2, #8884)',
    background: 'var(--dsw-alias-bg-base, #fff)', color: 'var(--dsw-alias-label-secondary, #666)', borderRadius: '999px',
    padding: '2px 10px', font: 'inherit', fontSize: '11px', lineHeight: '16px', cursor: 'pointer', opacity: 0.85,
  },
  panel: {
    position: 'fixed', right: '12px', bottom: '40px', zIndex: 2147483001, width: 'min(680px, calc(100vw - 24px))',
    maxHeight: 'min(70vh, 560px)', display: 'flex', flexDirection: 'column', gap: '6px', padding: '10px 12px',
    border: '1px solid var(--dsw-alias-border-l2, #8884)', borderRadius: '10px', background: 'var(--dsw-alias-bg-base, #fff)',
    color: 'var(--dsw-alias-label-primary, #222)', boxShadow: '0 8px 28px #0003', font: 'inherit', fontSize: '12px',
  },
  header: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
  title: { marginRight: 'auto', fontWeight: 600, fontSize: '13px' },
  button: {
    font: 'inherit', fontSize: '12px', lineHeight: '18px', padding: '1px 8px', cursor: 'pointer', borderRadius: '6px',
    border: '1px solid var(--dsw-alias-border-l2, #8884)', background: 'transparent', color: 'inherit',
  },
  meta: { color: 'var(--dsw-alias-label-tertiary, #888)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: 0 },
  list: { overflow: 'auto', margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '4px' },
  entry: { borderTop: '1px solid var(--dsw-alias-border-l1, #8882)', paddingTop: '3px', wordBreak: 'break-word' },
  line: { display: 'flex', gap: '6px', alignItems: 'baseline', flexWrap: 'wrap' },
  time: { color: 'var(--dsw-alias-label-tertiary, #888)', fontVariantNumeric: 'tabular-nums', flex: 'none' },
  source: { color: 'var(--dsw-alias-label-tertiary, #888)', flex: 'none' },
  facts: { color: 'var(--dsw-alias-label-secondary, #666)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: '2px 0 0', fontSize: '11px' },
} as const

function entryFacts(entry: DiagnosticEntry): string[] {
  const identity = entry.identity
  return [
    entry.method && `method=${entry.method}`, entry.route && `route=${entry.route}`,
    entry.status === undefined ? '' : `status=${entry.status}`, entry.code && `code=${entry.code}`,
    entry.requestId && `requestId=${entry.requestId}`, entry.outcome && `outcome=${entry.outcome}`,
    entry.durationMs === undefined ? '' : `durationMs=${entry.durationMs}`,
    entry.timeout ? 'timeout' : '', entry.aborted ? 'aborted' : '',
    entry.retryAfterMs === undefined ? '' : `retryAfterMs=${entry.retryAfterMs}`,
    entry.connection && `connection=${entry.connection}`,
    entry.direction && `direction=${entry.direction}`, entry.beforeAt === undefined ? '' : `beforeAt=${entry.beforeAt}`,
    entry.beforeSeq === undefined ? '' : `beforeSeq=${entry.beforeSeq}`, entry.epoch === undefined ? '' : `epoch=${entry.epoch}`,
    entry.reset === undefined ? '' : `reset=${entry.reset}`, entry.hasMore === undefined ? '' : `hasMore=${entry.hasMore}`,
    entry.errorName && `errorName=${entry.errorName}`,
    identity?.hubId && `hub=${identity.hubId}`, identity?.sessionId && `session=${identity.sessionId}`,
    identity?.hapiSessionId && `source=${identity.hapiSessionId}`, identity?.machineId && `machine=${identity.machineId}`,
    identity?.engine && `engine=${identity.engine}`,
  ].filter((value): value is string => Boolean(value))
}

async function copyText(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(value); return true }
  } catch { /* fall back below */ }
  try {
    const area = document.createElement('textarea')
    area.value = value; area.setAttribute('readonly', ''); area.style.position = 'fixed'; area.style.opacity = '0'
    document.body.append(area); area.select()
    const copied = typeof document.execCommand === 'function' ? document.execCommand('copy') : false
    area.remove()
    return copied
  } catch { return false }
}

export function DiagnosticsOverlay({ core }: { core: DiagnosticsCore }) {
  const snapshot: DiagnosticsSnapshot = useSyncExternalStore(core.subscribe, core.getSnapshot)
  const labels = text()
  const [status, setStatus] = useState<string | null>(null)
  const statusTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flash = useCallback((message: string) => {
    setStatus(message)
    if (statusTimer.current) clearTimeout(statusTimer.current)
    statusTimer.current = setTimeout(() => setStatus(null), 2500)
  }, [])
  const build = diagnosticsBuildContext().join('\n')
  const copy = (): void => { void copyText(core.format()).then(ok => flash(ok ? labels.copied : labels.copyFailed)) }
  const clear = (): void => { core.clear(); flash(labels.cleared) }
  if (!snapshot.drawerOpen) {
    if (!snapshot.entries.length) return null
    return <button type="button" style={styles.chip} data-hapi-diagnostics-chip="" aria-label={`${labels.chip} · ${snapshot.entries.length}`}
      title={`${labels.title} · ${snapshot.entries.length}`} onClick={() => core.openDrawer(true)}>{labels.chip} {snapshot.entries.length}</button>
  }
  return <section style={styles.panel} role="dialog" aria-label={labels.title} data-hapi-diagnostics-drawer="" data-hapi-diagnostics-count={snapshot.entries.length}>
    <header style={styles.header}>
      <strong style={styles.title}>{labels.title} · {snapshot.entries.length}</strong>
      <button type="button" style={styles.button} onClick={copy} data-hapi-diagnostics-copy="">{labels.copy}</button>
      <button type="button" style={styles.button} onClick={clear} data-hapi-diagnostics-clear="">{labels.clear}</button>
      <button type="button" style={styles.button} onClick={() => core.openDrawer(false)} data-hapi-diagnostics-close="">{labels.close}</button>
    </header>
    <p style={styles.meta}>{build}</p>
    {status && <p style={styles.meta} role="status">{status}</p>}
    {snapshot.entries.length === 0
      ? <p style={styles.meta}>{labels.empty}</p>
      : <ul style={styles.list}>{[...snapshot.entries].reverse().map(entry => <li key={entry.id} style={styles.entry} data-hapi-diagnostics-entry={entry.event}>
          <div style={styles.line}>
            <span style={styles.time}>{new Date(entry.time).toLocaleTimeString()}</span>
            <span style={styles.source}>[{entry.source} · {entry.event}]</span>
          </div>
          <p style={styles.facts}>{entryFacts(entry).join(' ') || '—'}</p>
        </li>)}</ul>}
  </section>
}

const OVERLAY_KEY = Symbol.for('hapi-dsh.diagnostics.overlay')

/** Page-global overlay: only the first pane graph mounts it, others just feed the buffer. */
export function mountDiagnosticsOverlay(core: DiagnosticsCore): () => void {
  if (typeof document === 'undefined' || typeof window === 'undefined') return () => {}
  const target = window as unknown as Record<symbol, unknown>
  if (target[OVERLAY_KEY]) return () => {}
  const host = document.createElement('div')
  host.setAttribute('data-hapi-diagnostics-root', '')
  document.body.append(host)
  const root = createRoot(host)
  target[OVERLAY_KEY] = root
  root.render(<DiagnosticsOverlay core={core} />)
  return () => {
    // Diagnostics belongs to the page lifetime, not to one pane graph.
  }
}
