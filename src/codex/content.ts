import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { writeDurableJson } from './durable-file.ts'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { z } from 'zod'
import type { HapiArtifactRef } from './contracts.js'
import { canonicalJson, record, type NativeRow } from './native.js'

export type NativeArtifactBlock = Extract<ContentBlock, { type: 'image' | 'file' }>
export type NativeArtifactImporter = (sessionId: string, ref: HapiArtifactRef) => Promise<NativeArtifactBlock>

const artifactSchema = z.object({
  id: z.string().min(1), fileName: z.string(), mimeType: z.string(), size: z.number().nonnegative().optional(),
  label: z.string().optional(), externalUrl: z.string().url().regex(/^https?:\/\//i).optional(),
}).transform((value): HapiArtifactRef => ({
  id: value.id, fileName: value.fileName, mimeType: value.mimeType,
  ...(value.size === undefined ? {} : { size: value.size }),
  ...(value.label === undefined ? {} : { label: value.label }),
  ...(value.externalUrl === undefined ? {} : { externalUrl: value.externalUrl }),
}))
const partSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('artifact'), artifact: artifactSchema }),
  z.object({ type: z.literal('resource-link'), name: z.string(), uri: z.string() }),
  z.object({ type: z.literal('unsupported'), label: z.string() }),
])
const storedBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('file'), attachment: z.object({
    attachmentId: z.string().min(1).transform(AttachmentId), name: z.string(), bytes: z.number().int().nonnegative(),
  }) }),
  z.object({ type: z.literal('image'), attachment: z.object({
    attachmentId: z.string().min(1).transform(AttachmentId), mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
    bytes: z.number().int().nonnegative(), width: z.number().int().positive(), height: z.number().int().positive(),
    name: z.string().optional(), originalDimensions: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).optional(),
  }) }),
]).transform((value): NativeArtifactBlock => value.type === 'file' ? value : {
  type: 'image', attachment: {
    attachmentId: value.attachment.attachmentId, mediaType: value.attachment.mediaType,
    bytes: value.attachment.bytes, width: value.attachment.width, height: value.attachment.height,
    ...(value.attachment.name === undefined ? {} : { name: value.attachment.name }),
    ...(value.attachment.originalDimensions === undefined ? {} : { originalDimensions: value.attachment.originalDimensions }),
  },
})
const cacheSchema = z.object({ version: z.literal(1), refs: z.record(z.string(), storedBlockSchema) })

function linkedText(label: string, uri: string): ContentBlock {
  const escaped = label.replace(/[\\[\]]/g, '\\$&')
  if (/^https?:\/\//i.test(uri)) {
    try {
      const href = new URL(uri).href.replace(/\(/g, '%28').replace(/\)/g, '%29')
      return { type: 'text', text: `[${escaped}](${href})` }
    } catch { /* Retain an invalid resource address as plain text. */ }
  }
  return { type: 'text', text: `${label}: ${uri}` }
}

/**
 * Import authorized native resources into the ordinary DSH attachment store.
 * Only the owning Hub resolves opaque artifact IDs; this code never reads a
 * runner path or fetches an arbitrary URL. Durable references survive offline
 * history reads, while a failed import remains visibly unavailable and may be
 * retried by the next native snapshot.
 */
export class NativeContent {
  private readonly filename: string
  private readonly refs = new Map<string, NativeArtifactBlock>()
  private readonly messages = new Map<string, readonly ContentBlock[]>()

  constructor(directory: string, logicalSessionId: string, private readonly sourceId: string, private readonly importer?: NativeArtifactImporter) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    this.filename = join(directory, `${logicalSessionId}.artifacts.json`)
    try {
      const cached = cacheSchema.parse(JSON.parse(readFileSync(this.filename, 'utf8')))
      for (const [key, block] of Object.entries(cached.refs)) this.refs.set(key, block)
    } catch (error) { if (record(error)?.code !== 'ENOENT') throw error }
  }

  get(row: NativeRow): readonly ContentBlock[] | undefined { return this.messages.get(row.key) }

  async prepare(rows: readonly NativeRow[]): Promise<void> {
    for (const row of rows) {
      const raw = row.kind === 'user' ? row.parts : row.kind === 'tool-result' ? record(row.output)?.content : undefined
      if (!Array.isArray(raw) || raw.length === 0) continue
      const parsed = z.array(partSchema).safeParse(raw)
      // Ordinary tool JSON is still rendered by the official text fallback;
      // only the documented HAPI rich-content vocabulary is interpreted here.
      if (!parsed.success) continue
      const blocks: ContentBlock[] = []
      for (const part of parsed.data) {
        if (part.type === 'text') { blocks.push({ type: 'text', text: part.text }); continue }
        if (part.type === 'unsupported') { blocks.push({ type: 'text', text: `[Native content unavailable: ${part.label}]` }); continue }
        if (part.type === 'resource-link') { blocks.push(linkedText(part.name, part.uri)); continue }
        const ref = part.artifact
        if (ref.externalUrl) { blocks.push(linkedText(ref.label ?? ref.fileName, ref.externalUrl)); continue }
        const key = createHash('sha256').update(canonicalJson([row.key, row.fingerprint, ref])).digest('hex')
        let imported = this.refs.get(key)
        if (!imported) {
          try {
            if (!this.importer) throw new Error('No native resource reader is configured')
            imported = storedBlockSchema.parse(await this.importer(this.sourceId, ref))
            this.refs.set(key, imported)
            try { this.persist() } catch (error) { this.refs.delete(key); throw error }
          } catch (error) {
            blocks.push({ type: 'text', text: `[Native resource unavailable: ${ref.fileName}; ${error instanceof Error ? error.message : 'resource could not be imported'}]` })
            continue
          }
        }
        blocks.push(imported)
      }
      this.messages.set(row.key, blocks)
      // A newly available resource changes the display, not source-native
      // identity. Existing display generations must be reacquired normally.
      row.fingerprint = createHash('sha256').update(canonicalJson([row.fingerprint, blocks])).digest('hex')
    }
  }

  private persist(): void {
    writeDurableJson(this.filename, { version: 1, refs: Object.fromEntries(this.refs) })
  }
}
