import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, chmodSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

export const decode = value => JSON.parse(value)
export const uid = () => randomUUID()
export function openStore(file = process.env.HHPI_PROFILE_DB || 'artifacts/development/profile.sqlite') {
  const location = resolve(file)
  mkdirSync(dirname(location), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(location)
  chmodSync(location, 0o600)
  db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS policies(id TEXT PRIMARY KEY, parent TEXT, document TEXT NOT NULL,
      hypothesis TEXT NOT NULL, evidence_run TEXT, created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS active_policy(singleton INTEGER PRIMARY KEY CHECK(singleton=1), policy TEXT NOT NULL REFERENCES policies(id));
    CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, started INTEGER NOT NULL, finished INTEGER,
      status TEXT NOT NULL, root TEXT NOT NULL, revision TEXT, changed TEXT NOT NULL,
      dag TEXT NOT NULL, checks TEXT NOT NULL, policy TEXT NOT NULL REFERENCES policies(id));
    CREATE TABLE IF NOT EXISTS tasks(run TEXT NOT NULL REFERENCES runs(id), node TEXT NOT NULL,
      state TEXT NOT NULL, agent TEXT, ready INTEGER, started INTEGER, finished INTEGER,
      reason TEXT, PRIMARY KEY(run,node));
    CREATE TABLE IF NOT EXISTS gates(run TEXT NOT NULL REFERENCES runs(id), name TEXT NOT NULL,
      evidence TEXT NOT NULL, PRIMARY KEY(run,name));
    CREATE TABLE IF NOT EXISTS spans(id TEXT PRIMARY KEY, run TEXT NOT NULL REFERENCES runs(id),
      node TEXT, agent TEXT NOT NULL, parent TEXT, kind TEXT NOT NULL, label TEXT NOT NULL,
      started INTEGER NOT NULL, finished INTEGER, status TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS observations(id TEXT PRIMARY KEY, run TEXT NOT NULL REFERENCES runs(id),
      requirement TEXT NOT NULL, layer TEXT NOT NULL, status TEXT NOT NULL, evidence TEXT NOT NULL,
      discovered_by TEXT NOT NULL, created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS usage(run TEXT NOT NULL REFERENCES runs(id), session TEXT NOT NULL,
      input INTEGER, output INTEGER, cached INTEGER, warnings TEXT NOT NULL, PRIMARY KEY(run,session));
    CREATE TABLE IF NOT EXISTS usage_windows(run TEXT NOT NULL REFERENCES runs(id), session TEXT NOT NULL,
      started INTEGER NOT NULL, finished INTEGER NOT NULL, imported INTEGER NOT NULL, PRIMARY KEY(run,session));
    CREATE TABLE IF NOT EXISTS profile_sources(run TEXT NOT NULL REFERENCES runs(id), session TEXT NOT NULL,
      file TEXT NOT NULL, agent TEXT NOT NULL, parent TEXT, cursor INTEGER NOT NULL DEFAULT 0,
      observed INTEGER, PRIMARY KEY(run,session));
    CREATE TABLE IF NOT EXISTS activity_spans(run TEXT NOT NULL REFERENCES runs(id), id TEXT NOT NULL,
      session TEXT NOT NULL, turn TEXT, kind TEXT NOT NULL, label TEXT NOT NULL,
      started INTEGER NOT NULL, finished INTEGER, status TEXT NOT NULL, evidence TEXT NOT NULL,
      PRIMARY KEY(run,id));
    CREATE TABLE IF NOT EXISTS response_usage(run TEXT NOT NULL REFERENCES runs(id), session TEXT NOT NULL,
      response TEXT NOT NULL, at INTEGER NOT NULL, input INTEGER NOT NULL, cached INTEGER NOT NULL,
      output INTEGER NOT NULL, PRIMARY KEY(run,session,response));
    CREATE TABLE IF NOT EXISTS activity_annotations(run TEXT NOT NULL REFERENCES runs(id), id TEXT NOT NULL,
      role TEXT NOT NULL, evidence TEXT NOT NULL, PRIMARY KEY(run,id));
    CREATE TABLE IF NOT EXISTS recording_states(run TEXT NOT NULL REFERENCES runs(id), at INTEGER NOT NULL,
      state TEXT NOT NULL, evidence TEXT NOT NULL, PRIMARY KEY(run,at));
    CREATE TABLE IF NOT EXISTS evaluations(id TEXT PRIMARY KEY, candidate TEXT NOT NULL REFERENCES policies(id),
      baseline TEXT NOT NULL REFERENCES policies(id), suite TEXT NOT NULL, status TEXT NOT NULL,
      started INTEGER NOT NULL, finished INTEGER, results TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS promotions(id INTEGER PRIMARY KEY AUTOINCREMENT, previous TEXT NOT NULL,
      next TEXT NOT NULL, evaluation TEXT, reason TEXT NOT NULL, created INTEGER NOT NULL);
    PRAGMA user_version=1;`)
  return { db, location, close: () => db.close() }
}

export function transaction(store, work) {
  store.db.exec('BEGIN IMMEDIATE')
  try { const result = work(); store.db.exec('COMMIT'); return result }
  catch (error) { store.db.exec('ROLLBACK'); throw error }
}

export function runRecord(store, id) {
  const row = store.db.prepare('SELECT * FROM runs WHERE id=?').get(id)
  if (!row) throw new Error(`Unknown run: ${id}`)
  return { ...row, dag: decode(row.dag), checks: decode(row.checks), changed: decode(row.changed) }
}

export function policyRecord(store, id) {
  const row = id ? store.db.prepare('SELECT * FROM policies WHERE id=?').get(id)
    : store.db.prepare('SELECT policies.* FROM policies JOIN active_policy ON policies.id=active_policy.policy').get()
  if (!row) throw new Error('Unknown policy; initialize a profile run first')
  return { ...row, document: decode(row.document) }
}
