import { openStore } from './store.mjs'
import { startSpan, finishSpan } from './profile.mjs'

/** Opt-in inherited by profile run; ordinary test commands retain their behavior. */
export function beginTestProfile(label) {
  if (!process.env.HHPI_PROFILE_RUN) return null
  const store = openStore()
  try {
    const id = startSpan(store, { run: process.env.HHPI_PROFILE_RUN, node: process.env.HHPI_PROFILE_NODE || null,
      agent: process.env.HHPI_PROFILE_AGENT || 'unattributed', parent: process.env.HHPI_PROFILE_PARENT || null, kind: 'product-test', label })
    return { store, id }
  } catch (error) { store.close(); throw error }
}

export function endTestProfile(handle, report) {
  if (!handle || handle.closed) return
  handle.closed = true
  try {
    finishSpan(handle.store, handle.id, { status: report.status === 'passed' ? 'passed' : report.status === 'failed' ? 'failed' : 'not-run',
      data: { mode: report.mode, selection: report.plan?.selection, selectionReason: report.plan?.reason,
        nodeFiles: report.plan?.node, experienceFiles: report.plan?.experience, phases: report.phases,
        durationMs: report.durationMs, result: report.status } })
  } finally { handle.store.close() }
}
