/** Offline only: selected snapshots, exact identity lookup and resumable private recovery material. */
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { createInterface } from 'node:readline'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from 'node:sqlite'
import { appSourceRouteSchema, type AppSourceRoute } from '../../../src/workspace/app-service-types.ts'
import { offlineRequestSchema, recoveryObjectSchema, type ExactIdentityMatch, type ExactTarget, type NativeLocator, type OfflineRequest,
    type RecoveryIndex, type RecoveryInputIndex, type RecoveryObject, type RecoveryObjectIndex, type SnapshotInput } from './contracts.ts'
export * from './contracts.ts'

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const inside = (root: string, path: string) => { const part = relative(root, path); return part !== '' && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part) }
const targetKey = (target: AppSourceRoute) => JSON.stringify([target.kind, target.hostId, target.sessionId,
    ...(target.kind === 'hhpi' ? [target.identity.machineId, target.identity.sourceId, target.identity.engine, target.identity.nativeId] : [])])

/** A configured source is a candidate, not proof of access or execution takeover. */
export class ExactIdentityIndex {
    private readonly targets: ExactTarget[]
    constructor(targets: readonly ExactTarget[]) {
        this.targets = targets.map(value => {
            const target = appSourceRouteSchema.parse(value.target), identity = { ...value.identity }
            if (!identity.machineId || !identity.engine || !identity.nativeId) throw new Error('An exact target requires machine, engine and native identity.')
            if (target.kind === 'hhpi') {
                if (target.identity.machineId !== identity.machineId || target.identity.engine !== identity.engine || target.identity.nativeId !== identity.nativeId
                    || identity.sourceId !== undefined && identity.sourceId !== target.identity.sourceId) throw new Error('The target route does not match its native identity.')
                identity.sourceId = target.identity.sourceId
            } else if (identity.engine !== 'dsh' || target.sessionId !== identity.nativeId) throw new Error('An official DSH target requires its original session identity.')
            return { target, identity }
        })
    }
    match(identity: NativeLocator | null): ExactIdentityMatch {
        if (!identity) return { status: 'unmapped' }
        const matches = new Map(this.targets.filter(value => value.identity.machineId === identity.machineId && value.identity.engine === identity.engine
            && value.identity.nativeId === identity.nativeId && (identity.sourceId === undefined || identity.sourceId === value.identity.sourceId)).map(value => [targetKey(value.target), value.target]))
        return matches.size === 0 ? { status: 'unmapped' } : matches.size === 1 ? { status: 'matched', target: [...matches.values()][0]! }
            : { status: 'ambiguous', candidates: [...matches.values()] }
    }
}

/** Read documented metadata keys only. Missing engine/machine/native fields stay unknown. */
export function hubSessionNativeIdentity(session: unknown): NativeLocator | null {
    if (!object(session)) return null
    let metadata: unknown = session.metadata
    if (typeof metadata === 'string') { try { metadata = JSON.parse(metadata) } catch { return null } }
    if (!object(metadata)) return null
    const engine = typeof metadata.flavor === 'string' ? metadata.flavor : metadata.codexNativeSession === true ? 'codex' : null
    const fields: Record<string, string> = { claude: 'claudeSessionId', codex: 'codexSessionId', dsh: 'dshSessionId', pi: 'piSessionId', qoder: 'qoderSessionId', gemini: 'geminiSessionId',
        opencode: 'opencodeSessionId', grok: 'grokSessionId', agy: 'agySessionId', cursor: 'cursorSessionId', kimi: 'kimiSessionId', copilot: 'copilotSessionId' }
    const nativeId = engine && fields[engine] ? metadata[fields[engine]!] : undefined
    const machines = [metadata.machineId, session.machineId, session.machine_id].filter((value): value is string => typeof value === 'string' && value.length > 0)
    return engine && new Set(machines).size === 1 && typeof nativeId === 'string' && nativeId
        ? { machineId: machines[0]!, engine, nativeId } : null
}

export class SnapshotReader {
    private constructor(readonly root: string, readonly inputs: readonly SnapshotInput[]) {}
    static async open(root: string, inputs: readonly SnapshotInput[]): Promise<SnapshotReader> {
        const actual = await realpath(root)
        if (!(await stat(actual)).isDirectory()) throw new Error('The selected snapshot root is not a directory.')
        if (new Set(inputs.map(input => input.id)).size !== inputs.length) throw new Error('Snapshot input IDs must be unique.')
        const reader = new SnapshotReader(actual, inputs.map(input => ({ ...input })))
        for (const input of inputs) await reader.path(input.id)
        return reader
    }
    input(id: string): SnapshotInput { const input = this.inputs.find(value => value.id === id); if (!input) throw new Error('This input was not selected for the snapshot.'); return input }
    async path(id: string): Promise<string> {
        const input = this.input(id), selected = resolve(this.root, input.path)
        if (isAbsolute(input.path) || !inside(this.root, selected)) throw new Error('Snapshot input escapes the selected root.')
        if ((await lstat(selected)).isSymbolicLink()) throw new Error('Snapshot inputs must be regular exported files, not symbolic links.')
        const actual = await realpath(selected)
        if (!inside(this.root, actual) || !(await stat(actual)).isFile()) throw new Error('Snapshot input is not a regular file within the selected root.')
        if (input.format === 'sqlite-backup') {
            try { if ((await stat(`${actual}-wal`)).size) throw new Error('Select a consistent SQLite backup, not a live WAL database.') }
            catch (cause) { if (!object(cause) || cause.code !== 'ENOENT') throw cause }
        }
        return actual
    }
    async json(id: string): Promise<unknown> {
        if (this.input(id).format !== 'json') throw new Error('The selected input is not a JSON export.')
        const handle = await open(await this.path(id), constants.O_RDONLY | constants.O_NOFOLLOW)
        try { return JSON.parse(await handle.readFile('utf8')) } finally { await handle.close() }
    }
    async *jsonLines(id: string): AsyncGenerator<{ line: number; value: unknown; raw: string; error: string | null }> {
        if (this.input(id).format !== 'jsonl') throw new Error('The selected input is not a JSONL export.')
        const handle = await open(await this.path(id), constants.O_RDONLY | constants.O_NOFOLLOW), stream = handle.createReadStream()
        const lines = createInterface({ input: stream, crlfDelay: Infinity }); let line = 0
        try { for await (const raw of lines) { line++; try { yield { line, raw, value: JSON.parse(raw), error: null } } catch { yield { line, raw, value: null, error: 'This source line is not valid JSON; original bytes remain in the recovery input.' } } } }
        finally { lines.close(); stream.destroy(); await handle.close() }
    }
    async sqlite<T>(id: string, read: (database: ReadonlySnapshotDatabase) => T | Promise<T>): Promise<T> {
        if (this.input(id).format !== 'sqlite-backup') throw new Error('The selected input is not a SQLite backup.')
        const database = new DatabaseSync(await this.path(id), { readOnly: true })
        try { database.exec('BEGIN'); return await read(new ReadonlySnapshotDatabase(database)) } finally { database.close() }
    }
}
export class ReadonlySnapshotDatabase {
    constructor(private readonly database: DatabaseSync) {}
    rows(sql: string, parameters: readonly SQLInputValue[] = []): IterableIterator<Record<string, SQLOutputValue>> {
        if (!/^\s*(?:SELECT|WITH)\b/iu.test(sql)) throw new Error('Snapshot queries must be reads.')
        return this.database.prepare(sql).iterate(...parameters)
    }
    schema(): { userVersion: number; tables: Array<{ name: string; columns: Record<string, SQLOutputValue>[] }> } {
        const tables = this.database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
        return { userVersion: Number(this.database.prepare('PRAGMA user_version').get()!.user_version), tables: tables.map(row => ({ name: String(row.name),
            columns: this.database.prepare(`PRAGMA table_info("${String(row.name).replaceAll('"', '""')}")`).all() })) }
    }
}

const escapeHtml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
async function atomicFile(path: string, content: string): Promise<void> {
    const pending = `${path}.${randomUUID()}.pending`
    await writeFile(pending, content, { flag: 'wx', mode: 0o600 }); await rename(pending, path)
}
interface InputRow { slot: number; id: string; metadata: string; file: string; bytes: number; state: string }
interface ObjectRow { slot: number; id: string; family: string; input_id: string; payload: string; materialized: number }
export class RecoveryPackage {
    private constructor(readonly directory: string, private readonly database: DatabaseSync, readonly request: OfflineRequest) {}
    static async open(directory: string, input?: unknown): Promise<RecoveryPackage> {
        const path = resolve(directory)
        if (input !== undefined) {
            const root = resolve(offlineRequestSchema.parse(input).snapshot.root)
            if (inside(root, path) || root === path) throw new Error('Recovery output cannot be inside the original snapshot.')
        }
        await mkdir(path, { recursive: true, mode: 0o700 })
        if ((await lstat(path)).isSymbolicLink()) throw new Error('Recovery output must not be a symbolic link.')
        const entries = await readdir(path), journal = resolve(path, 'recovery.sqlite')
        if (!entries.includes('recovery.sqlite') && entries.length) throw new Error('Recovery output must be a new directory or an existing recovery package.')
        if (entries.includes('recovery.sqlite')) {
            if ((await lstat(journal)).isSymbolicLink()) throw new Error('Recovery journal must not be a symbolic link.')
            const existing = new DatabaseSync(journal, { readOnly: true })
            try {
                const row = existing.prepare('SELECT version,request FROM package WHERE id=1').get()
                if (row?.version !== 1) throw new Error('This is not a supported recovery package.')
                const request = offlineRequestSchema.parse(JSON.parse(String(row.request)))
                if (input !== undefined && JSON.stringify(offlineRequestSchema.parse(input)) !== JSON.stringify(request)) throw new Error('Recovery package belongs to another snapshot/request. Use its original request or a new output directory.')
            } finally { existing.close() }
        }
        await chmod(path, 0o700)
        const database = new DatabaseSync(journal); await chmod(journal, 0o600)
        try {
            database.exec(`PRAGMA foreign_keys=ON;
                CREATE TABLE IF NOT EXISTS package (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, request TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS inputs (slot INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, metadata TEXT NOT NULL, file TEXT NOT NULL, bytes INTEGER NOT NULL, state TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS objects (slot INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, family TEXT NOT NULL, input_id TEXT NOT NULL REFERENCES inputs(id), payload TEXT NOT NULL, materialized INTEGER NOT NULL DEFAULT 0, UNIQUE(family,id));
                CREATE TABLE IF NOT EXISTS stages (id TEXT PRIMARY KEY, version TEXT NOT NULL, state TEXT NOT NULL, error TEXT);
                CREATE TABLE IF NOT EXISTS stage_configuration (id TEXT PRIMARY KEY REFERENCES stages(id), value TEXT NOT NULL);`)
            const existing = database.prepare('SELECT version,request FROM package WHERE id=1').get()
            const request = input === undefined ? existing && JSON.parse(String(existing.request)) : input
            const parsed = offlineRequestSchema.parse(request)
            if (existing && (existing.version !== 1 || String(existing.request) !== JSON.stringify(parsed))) throw new Error('Recovery package belongs to another snapshot/request. Use its original request or a new output directory.')
            if (!existing) database.prepare('INSERT INTO package(id,version,request) VALUES(1,1,?)').run(JSON.stringify(parsed))
            for (const stage of parsed.requiredStages) {
                const previous = database.prepare('SELECT version FROM stages WHERE id=?').get(stage.id)
                if (previous && previous.version !== stage.version) throw new Error('A required migration stage changed version. Use a new recovery package.')
                database.prepare("INSERT OR IGNORE INTO stages(id,version,state,error) VALUES(?,?,'pending',NULL)").run(stage.id, stage.version)
            }
            for (const name of ['inputs', 'objects']) {
                const child = resolve(path, name)
                await mkdir(child, { recursive: true, mode: 0o700 })
                if ((await lstat(child)).isSymbolicLink()) throw new Error('Recovery content directories must not be symbolic links.')
                await chmod(child, 0o700)
            }
            const recovery = new RecoveryPackage(path, database, parsed)
            await recovery.recoverInputCopies()
            return recovery
        } catch (cause) { database.close(); throw cause }
    }
    /** Rename commits a complete raw copy before the journal marks it complete. */
    private async recoverInputCopies(): Promise<void> {
        for (const row of this.database.prepare("SELECT * FROM inputs WHERE state='pending' AND file<>''").all() as unknown as InputRow[]) {
            try {
                const file = await lstat(resolve(this.directory, row.file))
                if (file.isFile() && file.size === row.bytes) this.database.prepare("UPDATE inputs SET state='complete' WHERE id=?").run(row.id)
            } catch (cause) { if (!object(cause) || cause.code !== 'ENOENT') throw cause }
        }
    }
    hasSnapshot(): boolean { return Number(this.database.prepare("SELECT count(*) AS count FROM inputs WHERE state='complete'").get()!.count) === this.request.snapshot.inputs.length }
    async capture(reader: SnapshotReader): Promise<void> {
        if (inside(reader.root, this.directory) || reader.root === this.directory) throw new Error('Recovery output cannot be inside the original snapshot.')
        for (const input of this.request.snapshot.inputs) {
            const metadata = JSON.stringify(input), existing = this.database.prepare('SELECT * FROM inputs WHERE id=?').get(input.id) as unknown as InputRow | undefined
            if (existing && existing.metadata !== metadata) throw new Error('An original snapshot input changed identity or version.')
            if (existing?.state === 'complete') continue
            const source = await reader.path(input.id), bytes = (await stat(source)).size
            if (!existing) this.database.prepare("INSERT INTO inputs(id,metadata,file,bytes,state) VALUES(?,?,'',?,'pending')").run(input.id, metadata, bytes)
            const row = this.database.prepare('SELECT * FROM inputs WHERE id=?').get(input.id) as unknown as InputRow
            const file = `inputs/${row.slot}.${input.format === 'sqlite-backup' ? 'sqlite' : input.format === 'binary' ? 'bin' : input.format}`
            const destination = resolve(this.directory, file), temporary = `${destination}.${randomUUID()}.pending`
            this.database.prepare('UPDATE inputs SET file=?,bytes=? WHERE id=?').run(file, bytes, input.id)
            const handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW)
            try { await pipeline(handle.createReadStream(), createWriteStream(temporary, { flags: 'wx', mode: 0o600 })) } finally { await handle.close() }
            if ((await stat(temporary)).size !== bytes || (await stat(source)).size !== bytes) throw new Error('The selected input changed size during capture. Select a frozen export or backup.')
            await rename(temporary, destination)
            this.database.prepare("UPDATE inputs SET file=?,bytes=?,state='complete' WHERE id=?").run(file, bytes, input.id)
        }
    }
    async snapshot(): Promise<SnapshotReader> {
        const rows = this.database.prepare("SELECT * FROM inputs WHERE state='complete' ORDER BY slot").all() as unknown as InputRow[]
        if (rows.length !== this.request.snapshot.inputs.length) throw new Error('The recovery snapshot is not complete yet.')
        return SnapshotReader.open(this.directory, rows.map(row => ({ ...JSON.parse(row.metadata) as SnapshotInput, path: row.file })))
    }
    async putObject(input: RecoveryObject): Promise<RecoveryObjectIndex> {
        const value = recoveryObjectSchema.parse(input), payload = JSON.stringify(value)
        const existing = this.database.prepare('SELECT * FROM objects WHERE family=? AND id=?').get(value.family, value.id) as unknown as ObjectRow | undefined
        if (existing && existing.payload !== payload) throw new Error('An original recovery object key was reused with different content. Keep the original object and record a separate revision.')
        if (!existing) this.database.prepare('INSERT INTO objects(id,family,input_id,payload) VALUES(?,?,?,?)').run(value.id, value.family, value.inputId, payload)
        const row = this.database.prepare('SELECT * FROM objects WHERE family=? AND id=?').get(value.family, value.id) as unknown as ObjectRow
        await this.materialize(row)
        return this.objectIndex(row)
    }
    private objectIndex(row: ObjectRow): RecoveryObjectIndex {
        const value = JSON.parse(row.payload) as RecoveryObject
        return { id: row.id, family: value.family, inputId: value.inputId, state: value.state, file: `objects/${row.slot}.json`,
            ...(value.target ? { target: value.target } : {}), ...(value.reason === undefined ? {} : { reason: value.reason }) }
    }
    private async materialize(row: ObjectRow): Promise<void> {
        await atomicFile(resolve(this.directory, `objects/${row.slot}.json`), `${JSON.stringify(JSON.parse(row.payload), null, 2)}\n`)
        this.database.prepare('UPDATE objects SET materialized=1 WHERE slot=?').run(row.slot)
    }
    /** Already stored payloads remain recoverable without the original input or Hub. */
    async resume(): Promise<RecoveryIndex> {
        for (const row of this.database.prepare('SELECT * FROM objects WHERE materialized=0 ORDER BY slot').all() as unknown as ObjectRow[]) await this.materialize(row)
        return this.writeIndex()
    }
    stage(id: string): { version: string; state: string } | null {
        return this.database.prepare('SELECT version,state FROM stages WHERE id=?').get(id) as { version: string; state: string } | undefined ?? null
    }
    stageConfiguration(id: string, configuration: unknown): void {
        const serialized = JSON.stringify(configuration)
        if (serialized === undefined) throw new Error('A stage configuration must be JSON data.')
        const existing = this.database.prepare('SELECT value FROM stage_configuration WHERE id=?').get(id)
        if (existing && !isDeepStrictEqual(JSON.parse(String(existing.value)), JSON.parse(serialized))) throw new Error('This stage selection or exact mapping changed. Use the original configuration or a new recovery package.')
        if (!existing) this.database.prepare('INSERT INTO stage_configuration(id,value) VALUES(?,?)').run(id, serialized)
    }
    stageState(id: string, version: string, state: 'running' | 'complete' | 'failed', error: string | null = null): void {
        const stage = this.stage(id)
        if (!stage || stage.version !== version) throw new Error('This migration stage was not selected at package creation.')
        this.database.prepare('UPDATE stages SET state=?,error=? WHERE id=?').run(state, error, id)
    }
    async writeIndex(): Promise<RecoveryIndex> {
        const inputRows = this.database.prepare('SELECT * FROM inputs ORDER BY slot').all() as unknown as InputRow[]
        const inputs: RecoveryInputIndex[] = inputRows.filter(row => row.state === 'complete').map(row => { const source = JSON.parse(row.metadata) as SnapshotInput;
            return { id: row.id, file: row.file, format: source.format, version: source.version, bytes: row.bytes, originalPath: source.path } })
        const objectRows = this.database.prepare('SELECT * FROM objects ORDER BY slot').all() as unknown as ObjectRow[]
        const objects = objectRows.map(row => this.objectIndex(row))
        const stages = this.database.prepare('SELECT id,version,state,error FROM stages ORDER BY id').all() as unknown as RecoveryIndex['stages']
        const unresolved = objects.filter(value => value.state === 'unresolved').length
        const status = inputs.length !== this.request.snapshot.inputs.length || objectRows.some(row => !row.materialized) || stages.some(stage => stage.state !== 'complete') ? 'incomplete'
            : !stages.length ? 'preserved' : unresolved ? 'needs-review' : 'complete'
        const index: RecoveryIndex = { version: 1, packageId: this.request.packageId, snapshotId: this.request.snapshot.id, scope: this.request.scope, status, inputs, objects, stages, unresolved }
        await atomicFile(resolve(this.directory, 'index.json'), `${JSON.stringify(index, null, 2)}\n`)
        const link = (file: string, label: string) => `<a href="${file}">${escapeHtml(label)}</a>`
        await atomicFile(resolve(this.directory, 'index.html'), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Offline recovery</title><style>body{max-width:1000px;margin:2em auto;padding:0 1em;font:16px/1.5 system-ui;overflow-wrap:anywhere}li{margin:8px 0}small{color:#666}</style><h1>Offline recovery</h1><p>${escapeHtml(index.packageId)} · ${status} · ${unresolved} unresolved</p><p>This private archive does not transfer execution or authorize a target source. Original inputs are retained even without an identity mapping.</p><h2>Original inputs</h2><ul>${inputs.map(value => `<li>${link(value.file, value.id)} <small>${value.bytes} bytes · ${escapeHtml(value.format)} ${escapeHtml(value.version)}</small></li>`).join('')}</ul><h2>Recovered objects</h2><ul>${objects.map(value => `<li>${link(value.file, `${value.family}: ${value.id}`)} · ${value.state}${value.reason === undefined ? '' : ` · ${escapeHtml(value.reason)}`}</li>`).join('')}</ul><p>${link('index.json', 'Machine-readable index')}</p></html>\n`)
        return index
    }
    close(): void { this.database.close() }
}
