/**
 * Pinned HAPI history/migration wire fixture for the real official DSH Web.
 * No native CLI, provider credentials, or file migration is executed here.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { HapiWireFixture, NativeFixture } from './hapi-fixture.ts'
import type { PiHistoryEntry, SourceHistoryReceipt } from '../../src/hapi-agent/history-types.ts'

type Home = { id: string; label: string; path: string; official?: boolean }
type CursorFailure = Extract<NonNullable<SourceHistoryReceipt['cursorResult']>, { ok: false }>
type PiEntry = { machineId: string; summary: PiHistoryEntry; sourceId: string | null }
const json = (response: ServerResponse, value: unknown, status = 200): void => {
  response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value))
}

export class HistoryWireFixture {
  readonly piHistories = new Map<string, PiEntry>()
  readonly imports: Array<{ machineId: string; sessionIds: string[]; cwd?: string }> = []
  readonly reopens: string[] = []
  /** Explicit source-successor fixture; production resolves the returned
   * original identity through its normal HAPI catalog and Agent binding. */
  readonly reopenSuccessors = new Map<string, string>()
  readonly codexMigrations: Array<{ machineId: string; body: Record<string, unknown> }> = []
  readonly cursorMigrations: Array<{ sourceId: string; body: Record<string, unknown> }> = []
  readonly homes = new Map<string, Home[]>()
  readonly cursorRefusals = new Map<string, CursorFailure>()
  readonly divergedPi = new Set<string>()
  readonly privateFieldSentinel = 'fixture-private-field-not-for-public-rpc'
  dropNextImportReply = false
  dropNextCodexMigrationReply = false
  dropNextCursorMigrationReply = false

  addPi(key: string, machineId = 'machine-alpha'): PiHistoryEntry {
    const summary: PiHistoryEntry = { id: `pi-native-${key}`, title: `Pi history ${key}`, lastUserMessage: `Original Pi task ${key}`,
      cwd: `/workspace/pi-${key}`, file: `/fixture/pi/${key}.jsonl`, modifiedAt: Date.now(),
      model: 'fixture-pi', thinkingLevel: 'medium', leafEntryId: `pi-leaf-${key}`, messageCount: 2 }
    this.piHistories.set(summary.id, { machineId, summary, sourceId: null }); return structuredClone(summary)
  }
  addCursor(hapi: HapiWireFixture, key: string, active = false): NativeFixture {
    const fixture = hapi.addObserved('pi', `cursor-${key}`), { session } = fixture
    delete session.metadata!.piSessionId
    Object.assign(session.metadata!, { flavor: 'cursor', name: `Cursor history ${key}`, cursorSessionId: `cursor-native-${key}`,
      cursorSessionProtocol: 'stream-json', lifecycleState: active ? 'running' : 'archived' })
    session.active = active; session.metadataVersion++; session.model = 'fixture-cursor-model'
    // Cursor and Pi both use HAPI's normalized codex message envelope here.
    for (const row of fixture.rows) {
      const envelope = row.content as { role: string; content: { text?: string; data?: { message?: string } } }
      if (envelope.role === 'user') envelope.content.text = `Original Cursor task ${key}`
      else if (envelope.content.data?.message) envelope.content.data.message = `Original Cursor history ${key} in the official DSH Conversation.`
    }
    hapi.emit({ type: 'session-updated', sessionId: session.id }); return fixture
  }
  private importOne(hapi: HapiWireFixture, row: PiEntry) {
    const previous = row.sourceId, key = row.summary.id.slice('pi-native-'.length)
    const fixture = previous ? hapi.require(previous) : hapi.addObserved('pi', `pi-import-${key}`, row.machineId)
    const source = fixture.session, failed = this.divergedPi.has(row.summary.id), now = Date.now()
    row.sourceId = source.id; source.active = false
    Object.assign(source.metadata!, { piSessionId: row.summary.id, name: row.summary.title, path: row.summary.cwd,
      lifecycleState: 'archived', piHistoryLeafEntryId: row.summary.leafEntryId,
      piImportState: { state: failed ? 'diverged' : 'complete', machineId: row.machineId, piSessionId: row.summary.id,
        sourceFile: row.summary.file, startedAt: now, updatedAt: now, leafEntryId: row.summary.leafEntryId,
        ...(failed ? { error: 'Fixture Pi branch diverged from the imported history' } : {}) } })
    source.metadataVersion++; source.updatedAt = now
    row.summary.hapiSessionId = source.id; row.summary.importState = failed ? 'diverged' : 'complete'
    hapi.emit({ type: 'session-updated', sessionId: source.id })
    return { piSessionId: row.summary.id, hapiSessionId: source.id, ...(failed
      ? { error: { code: 'transcript_diverged', message: 'Fixture Pi branch diverged from the imported history' } }
      : { action: previous ? 'unchanged' : 'created', appended: previous ? 0 : 2 }) }
  }

  /** Run after HAPI fixture authentication, before its ordinary machine/session routes. */
  handle(hapi: HapiWireFixture, url: URL, request: IncomingMessage, response: ServerResponse, body: Record<string, unknown>): boolean {
    const parts = url.pathname.split('/').slice(1).map(decodeURIComponent)
    if (url.pathname === '/api/pi/sessions' && request.method === 'GET') {
      const machineId = url.searchParams.get('machineId'), cwd = url.searchParams.get('cwd')
      json(response, { success: true, machineId, sessions: [...this.piHistories.values()].filter(row => row.machineId === machineId
        && (!cwd || row.summary.cwd === cwd)).map(row => row.summary) }); return true
    }
    if (url.pathname === '/api/pi/import-sessions' && request.method === 'POST') {
      const sessionIds = body.sessionIds, machineId = body.machineId
      if (typeof machineId !== 'string' || !Array.isArray(sessionIds) || sessionIds.some(id => typeof id !== 'string')) {
        json(response, { error: 'Invalid Pi fixture import input' }, 400); return true
      }
      this.imports.push({ machineId, sessionIds: [...sessionIds], ...(typeof body.cwd === 'string' ? { cwd: body.cwd } : {}) })
      const results = sessionIds.map(id => {
        const selected = this.piHistories.get(id)
        return selected?.machineId === machineId ? this.importOne(hapi, selected)
          : { piSessionId: id, error: { code: 'not_found', message: 'Pi history is not on the selected fixture Runner' } }
      })
      if (this.dropNextImportReply) { this.dropNextImportReply = false; response.destroy() }
      else json(response, { success: results.every(row => !('error' in row)), machineId, results })
      return true
    }
    if (parts[0] === 'api' && parts[1] === 'machines' && parts[2]) {
      const machineId = parts[2]
      if (parts[3] === 'codex-homes' && this.homes.has(machineId)) {
        json(response, { success: true, homes: this.homes.get(machineId) }); return true
      }
      if (parts[3] === 'codex-thread-migrate' && request.method === 'POST') {
        this.codexMigrations.push({ machineId, body: structuredClone(body) })
        const source = typeof body.sessionId === 'string' ? hapi.sessions.get(body.sessionId)?.session : undefined
        const target = this.homes.get(machineId)?.find(home => home.id === body.targetHomeId && home.path === body.targetHome)
        if (!source || !target || source.metadata?.machineId !== machineId || source.metadata.codexSessionId !== body.threadId
          || source.metadata.codexHome !== body.sourceHome) { json(response, { success: false, error: 'Fixture source thread/home binding differs' }, 409); return true }
        source.active = false; source.metadata.codexHome = target.path; source.metadata.codexHomeId = target.id
        source.metadata.codexStoreId = target.path; source.metadata.codexNativeConnection = 'history'; source.metadataVersion++
        hapi.emit({ type: 'session-updated', sessionId: source.id })
        if (this.dropNextCodexMigrationReply) { this.dropNextCodexMigrationReply = false; response.destroy() }
        else json(response, { success: true, threadId: source.metadata.codexSessionId, journalPath: '/fixture/migration-journal.json',
          warnings: ['This is a wire fixture; no files were migrated.'], privateConfig: this.privateFieldSentinel })
        return true
      }
    }
    if (parts[0] === 'api' && parts[1] === 'sessions' && parts[2]) {
      const sourceId = parts[2], source = hapi.sessions.get(sourceId)?.session
      if (parts[3] === 'reopen' && request.method === 'POST' && source && this.reopenSuccessors.has(sourceId)) {
        const target = hapi.require(this.reopenSuccessors.get(sourceId)!).session
        this.reopens.push(sourceId); source.active = false; source.metadataVersion++
        if (source.metadata) source.metadata.lifecycleState = 'archived'
        target.active = true; target.metadataVersion++
        if (target.metadata) { target.metadata.lifecycleState = 'running'; if (target.metadata.flavor === 'codex') target.metadata.codexNativeConnection = 'attached' }
        hapi.emit({ type: 'session-updated', sessionId: sourceId }); hapi.emit({ type: 'session-updated', sessionId: target.id })
        json(response, { ok: true, sessionId: target.id, resumed: true }); return true
      }
      if (parts[3] === 'reopen' && request.method === 'POST' && source?.metadata?.flavor === 'pi'
        && [...this.piHistories.values()].some(row => row.sourceId === sourceId)) {
        this.reopens.push(sourceId); source.active = true; source.metadata.lifecycleState = 'running'; source.metadataVersion++
        hapi.emit({ type: 'session-updated', sessionId: sourceId })
        json(response, { ok: true, sessionId: sourceId, resumed: true }); return true
      }
      if (parts[3] === 'migrate-to-acp' && request.method === 'POST' && source?.metadata?.flavor === 'cursor') {
        this.cursorMigrations.push({ sourceId, body: structuredClone(body) })
        const failure = this.cursorRefusals.get(sourceId)
        if (failure) { json(response, { ...failure, privateConfig: this.privateFieldSentinel }, 409); return true }
        if (source.active && body.forceArchiveRunning !== true) {
          json(response, { ok: false, sessionId: sourceId, reason: 'running_refused', message: 'Fixture Cursor source is active', durationMs: 1 }, 409); return true
        }
        source.active = false; source.metadata.cursorSessionProtocol = 'acp'; source.metadataVersion++
        hapi.emit({ type: 'session-updated', sessionId: sourceId })
        if (this.dropNextCursorMigrationReply) { this.dropNextCursorMigrationReply = false; response.destroy() }
        else json(response, { ok: true, sessionId: sourceId, acpSessionId: source.metadata.cursorSessionId, replayNotifications: 3,
          durationMs: 1, lastUsedModelPreserved: source.model ?? null, sourceRemoved: body.keepSource !== true,
          privateConfig: this.privateFieldSentinel })
        return true
      }
    }
    return false
  }
}
