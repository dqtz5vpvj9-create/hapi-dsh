import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { z } from 'zod'
import type { HapiArtifactRef, HapiAttachment } from '../codex/contracts.js'
import { sourceArtifactBlockSchema, type NativeArtifactBlock, type NativeArtifactImporter } from '../codex/content.js'
import { canonicalJson, record } from '../codex/native.js'
import { writeDurableJson } from '../codex/durable-file.js'
import type { ObservedItem, SourcePart } from './parser.js'
import type { SourceGeneratedMedia } from './generated-media-types.js'
export type { SourceGeneratedMedia } from './generated-media-types.js'

export interface SourceInlineResource { fileName: string; mimeType: string; base64: string }
export interface ObservedContentOptions {
  importArtifact?: NativeArtifactImporter
  importAttachment?: (sourceId: string, attachment: HapiAttachment) => Promise<NativeArtifactBlock>
  importInline?: (sourceId: string, resource: SourceInlineResource) => Promise<NativeArtifactBlock>
  importGeneratedMedia?: (sourceId: string, resource: SourceGeneratedMedia) => Promise<NativeArtifactBlock>
}
const artifactSchema = z.object({ id: z.string().min(1), fileName: z.string(), mimeType: z.string(),
  size: z.number().nonnegative().optional(), label: z.string().optional(), externalUrl: z.string().url().regex(/^https?:\/\//i).optional() })
const cacheSchema = z.object({ version: z.literal(1), refs: z.record(z.string(), sourceArtifactBlockSchema) })

function link(name: string, uri: string): ContentBlock {
  if (/^https?:\/\//i.test(uri)) {
    try { return { type: 'text', text: `[${name.replace(/[\\[\]]/g, '\\$&')}](${new URL(uri).href.replace(/\(/g, '%28').replace(/\)/g, '%29')})` } }
    catch { /* Source address remains visible without being followed. */ }
  }
  return { type: 'text', text: `${name}: ${uri}` }
}

/** Converts authorized source resources to official durable attachment blocks. */
export class ObservedContent {
  private readonly filename: string
  private readonly refs = new Map<string, NativeArtifactBlock>()
  private readonly messages = new Map<string, readonly ContentBlock[]>()
  constructor(directory: string, logicalId: string, private readonly sourceId: string, private readonly options: ObservedContentOptions) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    this.filename = join(directory, `${logicalId}.source-resources.json`)
    try {
      const cached = cacheSchema.parse(JSON.parse(readFileSync(this.filename, 'utf8')))
      for (const [key, value] of Object.entries(cached.refs)) this.refs.set(key, value)
    } catch (error) { if (record(error)?.code !== 'ENOENT') throw error }
  }
  get(item: ObservedItem): readonly ContentBlock[] | undefined { return this.messages.get(item.key) }
  async prepare(items: readonly ObservedItem[]): Promise<void> {
    for (const item of items) {
      if (!('parts' in item) || !item.parts.length) continue
      const blocks: ContentBlock[] = []
      for (const part of item.parts) blocks.push(await this.resolve(part))
      this.messages.set(item.key, blocks)
      item.fingerprint = createHash('sha256').update(canonicalJson([item.fingerprint, blocks])).digest('hex')
    }
  }
  private async resolve(part: SourcePart): Promise<ContentBlock> {
    if (part.type === 'text' || part.type === 'reasoning') return part
    if (part.type === 'resource-link') return link(part.name, part.uri)
    if (part.type === 'unsupported') return { type: 'text', text: `[Source content unavailable: ${part.label}]` }
    const key = createHash('sha256').update(canonicalJson(part)).digest('hex')
    const existing = this.refs.get(key)
    if (existing) return existing
    let name = 'source resource'
    try {
      let imported: NativeArtifactBlock
      if (part.type === 'artifact') {
        const parsed = artifactSchema.parse(part.artifact)
        name = parsed.fileName
        if (parsed.externalUrl) return link(parsed.label ?? name, parsed.externalUrl)
        if (!this.options.importArtifact) throw new Error('The source artifact importer is not configured')
        const ref: HapiArtifactRef = { id: parsed.id, fileName: parsed.fileName, mimeType: parsed.mimeType,
          ...(parsed.size === undefined ? {} : { size: parsed.size }), ...(parsed.label === undefined ? {} : { label: parsed.label }) }
        imported = await this.options.importArtifact(this.sourceId, ref)
      } else if (part.type === 'upload') {
        name = part.attachment.filename
        if (!this.options.importAttachment) throw new Error('The source upload importer is not configured')
        imported = await this.options.importAttachment(this.sourceId, part.attachment)
      } else if (part.type === 'generated-media') {
        name = part.media.fileName
        if (!this.options.importGeneratedMedia) throw new Error('The source generated media reader is not configured')
        imported = await this.options.importGeneratedMedia(this.sourceId, part.media)
      } else {
        name = part.fileName
        if (!this.options.importInline) throw new Error('The source inline resource importer is not configured')
        imported = await this.options.importInline(this.sourceId, part)
      }
      const value = sourceArtifactBlockSchema.parse(imported)
      this.refs.set(key, value)
      try { writeDurableJson(this.filename, { version: 1, refs: Object.fromEntries(this.refs) }) }
      catch (error) { this.refs.delete(key); throw error }
      return value
    } catch (error) {
      return { type: 'text', text: `[Source resource unavailable: ${name}; ${error instanceof Error ? error.message : 'resource could not be imported'}]` }
    }
  }
}
