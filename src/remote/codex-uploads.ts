import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { nativeUploadedContent, nativeImageGroup, type NativeUploadedPart } from './codex-presentation.ts'
import type { NativeItem } from './codex-native.ts'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { writeFileAtomic, withFileLock } from '@deepseek-ai/dsh-atomic-write'
/** Session-scoped receipts for files stored by the original Codex filesystem. */
import { mkdir, readFile } from 'node:fs/promises'
import { join, posix, win32 } from 'node:path'
import type { FileUploadValue, ImageUploadValue } from '@deepseek-ai/dsh-client-file-upload/types'
import type { CodexAccessBridge } from './codex-access-bridge.ts'
import type { SourceSession, SourceUploadRequest, SourceResource } from './protocol.ts'
import { SourceError } from './errors.ts'
import { NATIVE_IMAGE_PAGE_BYTES, NATIVE_IMAGE_PAGE_LIMIT, prepareNativeImage, validateNativeImagePlan } from './codex-image-pages.ts'
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export interface StoredCodexUpload { sessionId: string; path: string; name: string; bytes: number; image?: boolean; mimeType?: string; value?: FileUploadValue | ImageUploadValue }
/** Classify supported raster containers without changing or recompressing uploaded bytes. */
function isRaster(data: Buffer): boolean {
  return data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff
    || data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP'
    || ['GIF87a', 'GIF89a'].includes(data.toString('ascii', 0, 6))
}
export class CodexUploads {
  constructor(private readonly directory: string, private readonly native: CodexAccessBridge, private readonly localImageFiles = false) {}
  async upload(session: SourceSession, request: SourceUploadRequest, signal?: AbortSignal): Promise<FileUploadValue> {
    if (!uuid.test(request.operationId) || request.data.length > 8 * 1024 * 1024 || Buffer.from(request.data, 'base64').toString('base64') !== request.data) throw new SourceError('INVALID_REQUEST', 'Invalid upload identity or file data.')
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    return withFileLock(join(this.directory, request.operationId), async () => {
      let existing: StoredCodexUpload | undefined
      try { existing = JSON.parse(await readFile(join(this.directory, `${request.operationId}.json`), 'utf8')) as StoredCodexUpload }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      if (existing && existing.sessionId !== session.id) throw new SourceError('INVALID_REQUEST', 'The upload identity belongs to another source session.')
      return this.store(session, request, signal)
    }, { waitMs: 65_000 })
  }
  private async store(session: SourceSession, request: SourceUploadRequest, signal?: AbortSignal): Promise<FileUploadValue> {
    const path = /^[A-Za-z]:[\\/]|^\\\\/.test(session.cwd) ? win32 : posix
    if (!path.isAbsolute(session.cwd)) throw new SourceError('UNSUPPORTED', 'The source has no absolute working directory for uploads.')
    const name = (request.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 120) || 'attachment')
    const directory = path.join(session.cwd, '.hhpi', 'uploads', request.operationId)
    const target = path.join(directory, `attachment-${name}`)
    for (const [suffix, method, params] of [
      ['directory', 'fs/createDirectory', { path: directory, recursive: true }],
      ['file', 'fs/writeFile', { path: target, dataBase64: request.data }],
    ] as const) {
      signal?.throwIfAborted()
      const result = await this.native.call({ sourceId: session.sourceId, operationId: `upload:${request.operationId}:${suffix}`, method, params }, false, signal)
      if (result.status !== 'accepted') throw new SourceError(result.status === 'indeterminate' ? 'OUTCOME_UNKNOWN' : 'TARGET_UNAVAILABLE', result.message)
    }
    const stored: StoredCodexUpload = { sessionId: session.id, path: target, name, bytes: Buffer.from(request.data, 'base64').length, image: isRaster(Buffer.from(request.data, 'base64')) }
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    await writeFileAtomic(join(this.directory, `${request.operationId}.json`), JSON.stringify(stored), { mode: 0o600 })
    return { receiptId: request.operationId as FileUploadValue['receiptId'], file: { attachmentId: request.operationId as FileUploadValue['file']['attachmentId'], name, bytes: stored.bytes } }
  }
  async inputs(sessionId: string, receipts: readonly string[], signal?: AbortSignal): Promise<Array<{ type: 'text'; text: string; text_elements: never[] } | { type: 'localImage'; path: string }>> {
    signal?.throwIfAborted()
    return Promise.all(receipts.map(async receipt => {
      signal?.throwIfAborted()
      if (!uuid.test(receipt)) throw new SourceError('INVALID_REQUEST', 'Invalid file upload receipt.')
      let stored: StoredCodexUpload
      try { stored = JSON.parse(await readFile(join(this.directory, `${receipt}.json`), 'utf8')) as StoredCodexUpload }
      catch { throw new SourceError('INVALID_REQUEST', 'The file upload receipt is unavailable. Upload the file again.') }
      signal?.throwIfAborted()
      if (stored.sessionId !== sessionId || typeof stored.path !== 'string' || typeof stored.name !== 'string') throw new SourceError('INVALID_REQUEST', 'The file upload belongs to another source session.')
      if (stored.image) return { type: 'localImage' as const, path: stored.path }
      return { type: 'text' as const, text: `Attached file ${JSON.stringify(stored.name)}: ${JSON.stringify(stored.path)}`, text_elements: [] }
    }))
  }
  /** Bind already validated receipts to one original native user-message operation, never to prose paths. */
  async associate(sessionId: string, operationId: string, receipts: readonly string[], signal?: AbortSignal): Promise<NativeUploadedPart['input'][]> {
    if (!operationId || operationId.length > 8192) throw new SourceError('INVALID_REQUEST', 'Invalid native user-message identity.');
    const inputs = await this.inputs(sessionId, receipts, signal);
    const parts: NativeUploadedPart[] = [];
    for (let i = 0; i < receipts.length; i++) {
      const stored = await storedCodexUpload(this.directory, sessionId, receipts[i]!, signal);
      if (!stored) throw new SourceError('INVALID_REQUEST', 'The uploaded attachment is no longer available.');
      parts.push({ input: inputs[i]!, ...(stored.value ? { value: stored.value } : {}) });
    }
    await mkdir(this.directory, { recursive: true, mode: 0o700 }); signal?.throwIfAborted();
    const lock = join(this.directory, createHash('sha256').update(JSON.stringify([sessionId, operationId])).digest('hex'));
    return withFileLock(lock, async () => {
      const prior = this.parts(sessionId, operationId);
      if (prior) {
        const admission = prior.map(({ input, value }) => ({ input, ...(value ? { value } : {}) }));
        if (JSON.stringify(admission) !== JSON.stringify(parts)) throw new SourceError('INVALID_REQUEST', 'The original native operation names different uploaded attachments.');
        // In particular, pre-upgrade operations keep their old input and never
        // acquire a new plan, encoding, detail or native receipt fingerprint.
        return prior.map(part => part.input);
      }
      if (this.localImageFiles) {
        for (let i = 0; i < parts.length; i++) {
          const part = parts[i]!;
          if (part.input.type === 'localImage') part.imagePlan = await prepareNativeImage(this.directory, [sessionId, operationId, receipts[i]!], part.input.path, signal);
        }
        this.budget(parts);
      }
      signal?.throwIfAborted();
      const database = openAssociations(this.directory);
      try { database.prepare('INSERT INTO native_upload_operation(session_id,operation_id,parts) VALUES(?,?,?)').run(sessionId, operationId, JSON.stringify(parts)); }
      finally { database.close(); }
      return parts.map(part => part.input);
    }, { waitMs: 65_000, ...(signal ? { signal } : {}) });
  }
  private budget(parts: readonly NativeUploadedPart[]): void {
    const pages = parts.flatMap(part => part.imagePlan?.pages ?? []);
    if (pages.length > NATIVE_IMAGE_PAGE_LIMIT || pages.reduce((n, page) => n + page.bytes, 0) > NATIVE_IMAGE_PAGE_BYTES)
      throw new SourceError('CAPACITY_EXCEEDED', 'The model image pages exceed the source input budget. Nothing was sent.', 'not-dispatched');
  }
  private parts(sessionId: string, operationId: string): NativeUploadedPart[] | undefined {
    if (!existsSync(associationDatabase(this.directory))) return undefined;
    const database = openAssociations(this.directory);
    try {
      const row = database.prepare('SELECT parts FROM native_upload_operation WHERE session_id=? AND operation_id=?').get(sessionId, operationId) as { parts: string } | undefined;
      return row ? JSON.parse(row.parts) as NativeUploadedPart[] : undefined;
    } finally { database.close(); }
  }
  hasImagePlans(sessionId: string): boolean {
    if (!existsSync(associationDatabase(this.directory))) return false;
    const database = openAssociations(this.directory);
    try { return !!database.prepare(`SELECT 1 FROM native_upload_operation WHERE session_id=? AND parts LIKE '%"imagePlan":%' LIMIT 1`).get(sessionId); }
    finally { database.close(); }
  }
  /** Admission params stay untouched. Only source-issued original paths or the
   * exact retained native page group can select a pinned dispatch plan. */
  async dispatch(sessionId: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (typeof params.clientUserMessageId !== 'string' || !Array.isArray(params.input)) return params;
    const parts = this.parts(sessionId, params.clientUserMessageId);
    if (!parts?.some(part => part.imagePlan)) return params;
    this.budget(parts);
    const input: unknown[] = [], used = new Set<NativeUploadedPart>();
    for (let i = 0; i < params.input.length; i++) {
      const value = params.input[i];
      const part = parts.find(part => part.imagePlan && !used.has(part) && (JSON.stringify(value) === JSON.stringify(part.input)
        || nativeImageGroup(params.input as unknown[], i, part)));
      if (!part?.imagePlan) { input.push(value); continue; }
      used.add(part);
      await validateNativeImagePlan(part.imagePlan, signal);
      if (JSON.stringify(value) !== JSON.stringify(part.input)) i += part.imagePlan.pages.length - 1;
      input.push(...part.imagePlan.pages.map(page => ({ type: 'localImage', path: page.path, detail: 'original' })));
    }
    return { ...params, input };
  }
  /** Compact only a complete byte-verified native page group. These immutable
   * source references also gate exact queued edit/steer ownership checks. */
  queueRow(sessionId: string, row: unknown): unknown {
    if (!row || typeof row !== 'object' || !('clientUserMessageId' in row) || typeof row.clientUserMessageId !== 'string'
      || !('input' in row) || !Array.isArray(row.input)) return row;
    const parts = this.parts(sessionId, row.clientUserMessageId);
    if (!parts) return row;
    const raw = row.input as unknown[], input: unknown[] = [], used = new Set<NativeUploadedPart>();
    for (let i = 0; i < raw.length; i++) {
      const part = parts.find(part => !used.has(part) && nativeImageGroup(raw, i, part));
      if (!part?.imagePlan) { input.push(raw[i]); continue; }
      used.add(part); i += part.imagePlan.pages.length - 1;
      input.push(...part.imagePlan.pages.map(page => ({ type: 'localImage', path: page.path, detail: 'original' })));
    }
    const content = nativeUploadedContent({ id: 'queue', type: 'userMessage', content: raw }, parts);
    return { ...row, input, ...(content ? { presentationContent: content } : {}) };
  }
  content(sessionId: string, item: NativeItem, base?: ContentBlock[]): ContentBlock[] | undefined {
    if (typeof item.clientId !== 'string') return undefined;
    const parts = this.parts(sessionId, item.clientId);
    return parts ? nativeUploadedContent(item, parts, base) : undefined;
  }
  /** Original images use the same session-scoped receipt authority as the
   * existing artifact reader. No caller-supplied filesystem path is accepted. */
  async imageResource(sessionId: string, resource: string, signal?: AbortSignal): Promise<SourceResource | undefined> {
    if (!this.localImageFiles || !/^attachment:sha256:[a-f0-9]{64}$/.test(resource)) return undefined;
    const stored = await storedCodexAttachment(this.directory, sessionId, resource.slice(11), signal);
    if (!stored?.value || !('image' in stored.value)) return undefined;
    signal?.throwIfAborted();
    const image = stored.value.image, data = await readFile(stored.path, { signal });
    if (image.attachmentId !== resource.slice(11) || data.length !== image.bytes
      || `sha256:${createHash('sha256').update(data).digest('hex')}` !== image.attachmentId)
      throw new SourceError('INVALID_REQUEST', 'The retained source image no longer matches its receipt.');
    signal?.throwIfAborted();
    return { encoding: 'base64', content: data.toString('base64'), mimeType: image.mediaType, attachment: image };
  }

}

/** Register a source-local immutable attachment without issuing another native filesystem operation. */
export async function registerStoredCodexUpload(directory: string, operationId: string, stored: StoredCodexUpload, signal?: AbortSignal): Promise<void> {
  if (!uuid.test(operationId)) throw new SourceError('INVALID_REQUEST', 'Invalid upload identity.');
  signal?.throwIfAborted(); await mkdir(directory, { recursive: true, mode: 0o700 });
  await withFileLock(join(directory, operationId), async () => {
    signal?.throwIfAborted();
    const path = join(directory, `${operationId}.json`);
    let previous: StoredCodexUpload | undefined;
    try { previous = JSON.parse(await readFile(path, 'utf8')) as StoredCodexUpload; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (previous) {
      if (JSON.stringify(previous) !== JSON.stringify(stored)) throw new SourceError('INVALID_REQUEST', 'The original upload belongs to another attachment.');
      return;
    }
    await writeFileAtomic(path, JSON.stringify(stored), { mode: 0o600 });
  }, { ...(signal ? { signal } : {}) });
  await indexStoredCodexUpload(directory, operationId, stored, signal);
}

/** A status lookup consumes an original source receipt; it never publishes bytes. */
export async function storedCodexUpload(directory: string, sessionId: string, operationId: string, signal?: AbortSignal): Promise<StoredCodexUpload | null> {
  if (!uuid.test(operationId)) return null;
  signal?.throwIfAborted(); let stored: StoredCodexUpload;
  try { stored = JSON.parse(await readFile(join(directory, `${operationId}.json`), 'utf8')) as StoredCodexUpload; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  signal?.throwIfAborted();
  if (stored.sessionId !== sessionId) throw new SourceError('INVALID_REQUEST', 'This upload belongs to another source session.');
  return stored;
}

/** Private primary-key index: a browser attachment address never supplies a source path. */
const associationDatabase = (directory: string) => join(directory, 'attachment-associations.sqlite');
function openAssociations(directory: string): DatabaseSync {
  const database = new DatabaseSync(associationDatabase(directory));
  database.exec(`CREATE TABLE IF NOT EXISTS uploaded_attachment (
    session_id TEXT NOT NULL, attachment_id TEXT NOT NULL, name TEXT NOT NULL, receipt_id TEXT NOT NULL,
    PRIMARY KEY (session_id, attachment_id, name));
    CREATE TABLE IF NOT EXISTS native_upload_operation (
    session_id TEXT NOT NULL, operation_id TEXT NOT NULL, parts TEXT NOT NULL,
    PRIMARY KEY (session_id, operation_id));`);
  return database;
}
export async function indexStoredCodexUpload(directory: string, receiptId: string, stored: StoredCodexUpload, signal?: AbortSignal): Promise<void> {
  if (!stored.value) return;
  signal?.throwIfAborted(); await mkdir(directory, { recursive: true, mode: 0o700 });
  const attachment = 'file' in stored.value ? stored.value.file : stored.value.image, database = openAssociations(directory);
  try { database.prepare('INSERT INTO uploaded_attachment(session_id,attachment_id,name,receipt_id) VALUES(?,?,?,?) ON CONFLICT(session_id,attachment_id,name) DO NOTHING')
    .run(stored.sessionId, attachment.attachmentId, attachment.name ?? stored.name, receiptId); }
  finally { database.close(); }
  signal?.throwIfAborted();
}
export async function storedCodexAttachment(directory: string, sessionId: string, attachmentId: string, signal?: AbortSignal, name?: string): Promise<StoredCodexUpload | null> {
  signal?.throwIfAborted(); if (!existsSync(associationDatabase(directory))) return null;
  const database = openAssociations(directory);
  let row: { receipt_id: string } | undefined;
  try { row = (name === undefined ? database.prepare('SELECT receipt_id FROM uploaded_attachment WHERE session_id=? AND attachment_id=? LIMIT 1').get(sessionId, attachmentId) : database.prepare('SELECT receipt_id FROM uploaded_attachment WHERE session_id=? AND attachment_id=? AND name=?').get(sessionId, attachmentId, name)) as typeof row; }
  finally { database.close(); }
  return row ? storedCodexUpload(directory, sessionId, row.receipt_id, signal) : null;
}
