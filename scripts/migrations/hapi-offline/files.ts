/** X2 offline files, browser Blobs and dirty editors. Never imports a legacy owner or dispatches source work. */
import { constants } from 'node:fs'
import { chmod, mkdir, open, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { ExactIdentityIndex, SnapshotReader, type ExactTarget, type NativeLocator, type RecoveryObjectIndex, type SnapshotInput } from './common.ts'
import type { OfflineStage } from './index.ts'
import { domainObject, domainReport, isRecord, jsonInput, originalKey } from './domain.ts'

const id = z.string().min(1), count = z.number().int().nonnegative()
const browserExportSchema = z.object({ version: z.literal(1), origin: id, createdAt: z.number().finite(),
  localStorage: z.array(z.object({ key: z.string(), value: z.string() }).passthrough()),
  databases: z.array(z.object({ name: id, version: count, stores: z.array(z.object({ name: id,
    records: z.array(z.object({ key: z.json(), value: z.json() }).passthrough()) }).passthrough()) }).passthrough()),
}).passthrough()
const blobSchema = z.object({ $hhpiBlob: z.literal(1), type: z.string(), name: z.string().optional(), lastModified: z.number().finite().optional(), data: z.string() }).passthrough()
const blobManifestSchema = z.object({ version: z.literal(1), kind: z.literal('browser-blobs'), exportInputId: id,
  blobs: z.array(z.object({ pointer: z.string(), inputId: id, bytes: count, type: z.string(), name: z.string().optional(), lastModified: z.number().finite().optional() })) })
export interface LegacyFileSource { hubId: string; sessionId: string; namespace?: string }
export interface FileMigrationInput {
  inputId: string
  kind: 'browser-export' | 'browser-blobs' | 'document-drafts' | 'artifact-journal' | 'source-resource-journal' | 'session-export' | 'file-receipts' | 'notes'
  /** Selection must record this original owner; a filename, title or cwd is not an identity. */
  source?: LegacyFileSource
}
export interface SelectedFileBinary { inputId: string; attachmentId?: string; kind?: 'file' | 'image'; name?: string; originalPath?: string; source?: LegacyFileSource }
export interface FilesStageOptions {
  inputs: readonly FileMigrationInput[]
  binaries?: readonly SelectedFileBinary[]
  sessions?: readonly { source: LegacyFileSource; identity: NativeLocator }[]
  targets?: readonly ExactTarget[]
  /** A file draft key can name a machine rather than a Session; its owner must be explicitly selected. */
  documentOwners?: readonly { key: string; source: LegacyFileSource }[]
}
const pointerKey = (key: string) => key.replaceAll('~', '~0').replaceAll('/', '~1')
function walk(value: unknown, pointer: string, visit: (value: Record<string, unknown>, pointer: string) => boolean | void): void {
  if (Array.isArray(value)) { for (const [index, entry] of value.entries()) walk(entry, `${pointer}/${index}`, visit); return }
  if (!isRecord(value)) return
  if (visit(value, pointer) === false) return
  for (const [key, entry] of Object.entries(value)) walk(entry, `${pointer}/${pointerKey(key)}`, visit)
}
function blobBytes(value: z.infer<typeof blobSchema>): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value.data)) throw new Error('A browser Blob has invalid base64. The original export was retained.')
  return Buffer.from(value.data, 'base64')
}
/** User-selected export -> a fresh private snapshot. The exporter envelope stays byte-for-byte intact. */
export async function extractBrowserRecovery(inputFile: string, outputDirectory: string): Promise<{ snapshot: { id: string; root: string; inputs: SnapshotInput[] }; blobs: number; bytes: number }> {
  const file = resolve(inputFile), output = resolve(outputDirectory)
  const source = await SnapshotReader.open(dirname(file), [{ id: 'browser-export', path: basename(file), format: 'json', version: 'browser-recovery-v1' }])
  const handle = await open(await source.path('browser-export'), constants.O_RDONLY | constants.O_NOFOLLOW)
  let raw: Buffer
  try { raw = await handle.readFile() } finally { await handle.close() }
  const envelope: unknown = JSON.parse(raw.toString('utf8')); browserExportSchema.parse(envelope)
  const blobs: Array<{ pointer: string; value: z.infer<typeof blobSchema>; bytes: Buffer }> = []
  walk(envelope, '', (value, pointer) => {
    if (value.$hhpiBlob !== 1) return
    const parsed = blobSchema.parse(value); blobs.push({ pointer, value: parsed, bytes: blobBytes(parsed) }); return false
  })
  await mkdir(output, { mode: 0o700 }); await chmod(output, 0o700)
  await mkdir(join(output, 'blobs'), { mode: 0o700 })
  const inputs: SnapshotInput[] = [{ id: 'browser-export', path: 'browser-export.json', format: 'json', version: 'browser-recovery-v1' }]
  await writeFile(join(output, 'browser-export.json'), raw, { flag: 'wx', mode: 0o600 })
  const manifest: z.infer<typeof blobManifestSchema> = { version: 1, kind: 'browser-blobs', exportInputId: 'browser-export', blobs: [] }
  for (const [index, blob] of blobs.entries()) {
    const inputId = `browser-blob-${index}`, path = `blobs/${index}.bin`
    await writeFile(join(output, path), blob.bytes, { flag: 'wx', mode: 0o600 })
    inputs.push({ id: inputId, path, format: 'binary', version: 'browser-blob-v1' })
    manifest.blobs.push({ pointer: blob.pointer, inputId, bytes: blob.bytes.length, type: blob.value.type,
      ...(blob.value.name === undefined ? {} : { name: blob.value.name }), ...(blob.value.lastModified === undefined ? {} : { lastModified: blob.value.lastModified }) })
  }
  await writeFile(join(output, 'browser-blobs.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  inputs.push({ id: 'browser-blobs', path: 'browser-blobs.json', format: 'json', version: 'browser-blobs-v1' })
  const snapshot = { id: 'selected-browser-recovery-v1', root: output, inputs }
  await writeFile(join(output, 'snapshot.json'), JSON.stringify(snapshot, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  return { snapshot, blobs: blobs.length, bytes: blobs.reduce((sum, blob) => sum + blob.bytes.length, 0) }
}
const sameSource = (a: LegacyFileSource, b: LegacyFileSource) => a.hubId === b.hubId && a.sessionId === b.sessionId && a.namespace === b.namespace
function keySource(key: unknown): LegacyFileSource | undefined {
  if (typeof key !== 'string') return undefined
  for (const prefix of ['hapi-dsh:composer-draft:v1:', 'hapi-dsh:note-migration:']) {
    if (!key.startsWith(prefix)) continue
    try {
      const parts: unknown = JSON.parse(key.slice(prefix.length))
      if (Array.isArray(parts) && (prefix.includes('composer') ? parts.length === 3 && parts[0] === 'hapi' : parts.length === 2)) {
        const [hubId, sessionId] = prefix.includes('composer') ? parts.slice(1) : parts
        if (typeof hubId === 'string' && typeof sessionId === 'string') return { hubId, sessionId }
      }
    } catch { return undefined }
  }
  return undefined
}
function recognizedDraft(value: unknown): boolean {
  if (!isRecord(value) || ![1, 2].includes(Number(value.version)) || typeof value.revision !== 'string') return false
  if (value.draft === null) return true
  return isRecord(value.draft) && typeof value.draft.text === 'string' && typeof value.draft.uncertain === 'boolean' && isRecord(value.draft.base)
    && isRecord(value.draft.base.document) && ['file', 'artifact', 'generated-media'].includes(String(value.draft.base.document.kind))
    && (value.draft.base.text === null || typeof value.draft.base.text === 'string')
}
function recognizedAttachments(value: unknown): boolean {
  if (!isRecord(value) || value.version !== 1 || typeof value.revision !== 'string') return false
  if (value.value === null) return true
  return isRecord(value.value) && value.value.version === 1 && ['draft', 'pending'].includes(String(value.value.mode))
    && typeof value.value.text === 'string' && Array.isArray(value.value.files)
}
/** Every referenced binary is read from the immutable captured snapshot, not from a recorded source path. */
export function createFilesStage(options: FilesStageOptions): OfflineStage {
  return { id: 'files', version: '1', configuration: options, async run({ snapshot, recovery }) {
    const outputs: RecoveryObjectIndex[] = [], blockers: string[] = [], identities = new ExactIdentityIndex(options.targets ?? [])
    const binaryChecks = new Map<string, Promise<number>>()
    const binary = (inputId: string): Promise<number> => {
      let result = binaryChecks.get(inputId)
      if (!result) {
        result = (async () => {
          if (snapshot.input(inputId).format !== 'binary') throw new Error('The selected attachment input is not binary.')
          const handle = await open(await snapshot.path(inputId), constants.O_RDONLY | constants.O_NOFOLLOW)
          let bytes = 0
          try { for await (const part of handle.createReadStream()) bytes += part.length } finally { await handle.close() }
          return bytes
        })()
        binaryChecks.set(inputId, result)
      }
      return result
    }
    const manifests = new Map<string, z.infer<typeof blobManifestSchema>>()
    for (const selection of options.inputs.filter(input => input.kind === 'browser-blobs')) {
      const raw = await jsonInput(snapshot, selection.inputId), parsed = blobManifestSchema.safeParse(raw.value)
      if (parsed.success) {
        if (manifests.has(parsed.data.exportInputId)) throw new Error('More than one Blob manifest names this original browser export.')
        manifests.set(parsed.data.exportInputId, parsed.data)
      } else outputs.push(await domainObject(recovery, 'files', { key: originalKey(selection.inputId, 'unknown-blob-manifest'), inputId: selection.inputId,
        disposition: 'offline-recovery', original: raw.value, unresolved: true, reason: 'Unsupported Blob extraction manifest; original input was retained.' }))
    }
    const target = (source?: LegacyFileSource) => {
      const matches = source ? (options.sessions ?? []).filter(value => sameSource(value.source, source)) : []
      if (matches.length !== 1) return undefined
      const matched = identities.match(matches[0]!.identity)
      return matched.status === 'matched' ? matched.target : undefined
    }
    async function preserve(selection: FileMigrationInput, key: string, value: unknown, recognized: boolean, source?: LegacyFileSource, pointer = '', allowSourcePaths = false) {
      const assets: Array<{ pointer: string; inputId: string; bytes: number }> = [], missing: string[] = []
      const refs: Array<{ pointer: string; candidates: string[]; expected?: number; content?: Buffer }> = []
      walk(value, pointer, (entry, location) => {
        if (entry.$hhpiBlob === 1) {
          const manifest = manifests.get(selection.inputId), match = manifest?.blobs.filter(blob => blob.pointer === location)
          try {
            const content = blobBytes(blobSchema.parse(entry))
            refs.push({ pointer: location, candidates: match?.map(blob => blob.inputId) ?? [], expected: content.length, content })
          } catch { missing.push(`${location}: original Blob codec is invalid`) }
          return false
        }
        if (typeof entry.attachmentId === 'string') refs.push({ pointer: location, candidates: (options.binaries ?? [])
          .filter(item => item.attachmentId === entry.attachmentId && (item.kind === undefined || item.kind === (typeof entry.mediaType === 'string' ? 'image' : 'file'))
            && (item.name === undefined || item.name === entry.name) && (!item.source || source && sameSource(item.source, source))).map(item => item.inputId),
          ...(typeof entry.bytes === 'number' ? { expected: entry.bytes } : {}) })
        else if (allowSourcePaths && typeof entry.path === 'string' && typeof entry.size === 'number' && (typeof entry.filename === 'string' || typeof entry.mimeType === 'string')) {
          refs.push({ pointer: location, candidates: (options.binaries ?? []).filter(item => source && item.source && sameSource(item.source, source) && item.originalPath === entry.path).map(item => item.inputId), expected: entry.size })
        }
      })
      for (const ref of refs) {
        const candidates = [...new Set(ref.candidates)]
        if (candidates.length !== 1) { missing.push(`${ref.pointer}: ${candidates.length ? 'ambiguous selected binaries' : 'actual bytes were not selected'}`); continue }
        try {
          const bytes = await binary(candidates[0]!)
          if (ref.expected !== undefined && bytes !== ref.expected) { missing.push(`${ref.pointer}: recorded size differs from selected bytes`); continue }
          if (ref.content) {
            // A selected manifest can be paired with the wrong same-size file before capture.
            // Compare the actual original Blob bytes, without another identity hash or guessed path.
            const handle = await open(await snapshot.path(candidates[0]!), constants.O_RDONLY | constants.O_NOFOLLOW)
            let offset = 0, same = true
            try {
              for await (const chunk of handle.createReadStream()) {
                if (!chunk.equals(ref.content.subarray(offset, offset + chunk.length))) same = false
                offset += chunk.length
              }
            } finally { await handle.close() }
            if (!same || offset !== ref.content.length) { missing.push(`${ref.pointer}: selected bytes differ from the original Blob`); continue }
          }
          assets.push({ pointer: ref.pointer, inputId: candidates[0]!, bytes })
        } catch { missing.push(`${ref.pointer}: selected binary is missing or unreadable`) }
      }
      const mapped = target(source), unresolved = !recognized || missing.length > 0 || !mapped
      const draft = recognizedDraft(value) && isRecord(value) ? value.draft : undefined
      outputs.push(await domainObject(recovery, 'files', { key: originalKey(selection.inputId, key), inputId: selection.inputId,
        disposition: unresolved ? 'offline-recovery' : 'migrate', original: value,
        converted: { version: 1, source: source ?? null, assets, missing,
          ...(draft === undefined ? {} : { draft, restoreMode: 'recovered-copy', overwriteTarget: false, requiresCurrentTargetRead: true }),
          imported: false, receiptPolicy: 'preserve-original-id-and-status-no-dispatch' },
        ...(mapped ? { target: mapped } : {}), unresolved,
        reason: !recognized ? 'Unknown schema remains accessible in the original snapshot; no target write is planned.'
          : missing.length ? 'Attachment recovery is incomplete; original metadata and all selected bytes were retained.'
          : !mapped ? 'No unique recorded machine/native identity and target was supplied; retain an offline recovery copy.'
          : 'Exact target is a migration candidate only. Current authorization and a fresh target baseline are required; recovered copies cannot overwrite a newer draft.' }))
    }
    for (const selection of options.inputs.filter(input => input.kind !== 'browser-blobs')) {
      const raw = await jsonInput(snapshot, selection.inputId)
      if (selection.kind === 'browser-export') {
        const parsed = browserExportSchema.safeParse(raw.value)
        if (!parsed.success) { await preserve(selection, 'unknown-browser-export', raw.value, false); continue }
        for (const [index, row] of parsed.data.localStorage.entries()) {
          let value: unknown = row.value
          try { value = JSON.parse(row.value) } catch { /* Original text is retained below. */ }
          const composer = row.key.startsWith('hapi-dsh:composer-draft:v1:') && isRecord(value) && value.version === 1 && isRecord(value.draft)
            && typeof value.draft.text === 'string' && Array.isArray(value.draft.references)
          const notes = row.key.startsWith('hapi-dsh:note-migration:') && isRecord(value) && value.version === 1 && typeof value.raw === 'string' && Array.isArray(value.rows)
          await preserve(selection, originalKey('localStorage', row.key), { key: row.key, value }, composer || notes, keySource(row.key), `/localStorage/${index}/value`, notes)
        }
        for (const [dbIndex, db] of parsed.data.databases.entries()) for (const [storeIndex, store] of db.stores.entries()) for (const [recordIndex, row] of store.records.entries()) {
          const recognized = db.version === 1 && (store.name === 'drafts' && (db.name === 'hapi-dsh-source-document-drafts' && recognizedDraft(row.value)
            || db.name === 'hhpi-workspace-document-drafts' && recognizedDraft(row.value) || db.name === 'hapi-dsh-composer-attachments' && recognizedAttachments(row.value))
            || db.name === 'hhpi-workspace-file-mutations' && store.name === 'receipts' && isRecord(row.value) && row.value.version === 2 && isRecord(row.value.receipt))
          const owner = typeof row.key === 'string' ? options.documentOwners?.find(value => value.key === row.key)?.source ?? keySource(row.key) : undefined
          await preserve(selection, originalKey('database', db.name, store.name, recordIndex, JSON.stringify(row.key)), row.value, recognized, owner,
            `/databases/${dbIndex}/stores/${storeIndex}/records/${recordIndex}/value`)
        }
      } else if (selection.kind === 'artifact-journal' || selection.kind === 'source-resource-journal') {
        if (!isRecord(raw.value) || raw.value.version !== 1 || !isRecord(raw.value.refs)) { await preserve(selection, 'unknown-journal', raw.value, false, selection.source); continue }
        for (const [key, block] of Object.entries(raw.value.refs)) await preserve(selection, key, block,
          isRecord(block) && ['file', 'image'].includes(String(block.type)) && isRecord(block.attachment) && typeof block.attachment.attachmentId === 'string', selection.source)
      } else {
        const values = Array.isArray(raw.value) ? raw.value : [raw.value]
        for (const [index, value] of values.entries()) {
          const known = selection.kind === 'document-drafts' ? recognizedDraft(value)
            : selection.kind === 'file-receipts' ? isRecord(value) && [1, 2].includes(Number(value.version)) && isRecord(value.receipt)
            : selection.kind === 'session-export' ? isRecord(value) && isRecord(value.session) && (Array.isArray(value.messages) || Array.isArray(value.scratchlist))
            : Array.isArray(value) || isRecord(value) && (Array.isArray(value.rows) || Array.isArray(value.scratchlist))
          await preserve(selection, originalKey(index), value, known, selection.source, '', true)
        }
      }
    }
    if (!options.inputs.length) blockers.push('No selected file inputs were provided.')
    await domainReport(recovery, 'files', options.inputs, outputs, blockers)
  } }
}
export async function main(args: readonly string[]): Promise<void> {
  const value = (name: string) => { const at = args.indexOf(name), value = at < 0 ? undefined : args[at + 1]; if (!value || value.startsWith('--')) throw new Error(`Specify ${name}.`); return value }
  if (args[0] !== 'extract-browser') throw new Error('Usage: files.ts extract-browser --input FILE --output FRESH_DIRECTORY')
  const result = await extractBrowserRecovery(value('--input'), value('--output'))
  process.stdout.write(JSON.stringify({ inputs: result.snapshot.inputs.length, blobs: result.blobs, bytes: result.bytes }) + '\n')
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main(process.argv.slice(2)).catch(() => {
  process.stderr.write('Offline file recovery did not complete. Original files remain unchanged; retain the private snapshot and retry into a fresh extraction directory.\n'); process.exitCode = 1
})
