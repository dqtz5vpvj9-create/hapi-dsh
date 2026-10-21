import { z } from 'zod'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

/** The source protocol deliberately accepts partial summaries, not arbitrary JSON fields. */
export const notifySummarySchema = z.object({
  version: z.number().optional(), agent: z.string().optional(), project: z.string().optional(),
  status: z.string().optional(), action: z.string().optional(), summary: z.string().optional(),
})
export type NotifySummary = z.infer<typeof notifySummarySchema>
export interface NotifySummaryDisplay { visibleText: string; summary: NotifySummary; footer: string }

const prefix = 'AGENT_NOTIFY_SUMMARY '
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * Match pinned HAPI's final-nonblank-line footer convention. Prose examples,
 * malformed JSON, and a token followed by later prose remain ordinary text.
 * This transforms a display copy only; the source transcript is never edited.
 */
export function splitNotifySummary(text: string): NotifySummaryDisplay | null {
  const lines = text.split('\n')
  let last = lines.length - 1
  while (last >= 0 && !lines[last]!.trim()) last--
  if (last < 0) return null
  const line = lines[last]!.trimEnd()
  for (let start = line.indexOf(prefix); start !== -1; start = line.indexOf(prefix, start + prefix.length)) {
    const before = line.slice(0, start)
    if (before.trim() && /\s/u.test(line[start - 1]!)) continue
    const suffix = line.slice(start + prefix.length).trim()
    if (!suffix.startsWith('{') || !suffix.endsWith('}')) continue
    let value: unknown
    try { value = JSON.parse(suffix) } catch { continue }
    if (!object(value)) continue
    const summary: NotifySummary = {}
    // Overflowing JSON numbers cannot enter the official lossless JSON log.
    // Keep the complete source footer in originalText while ignoring that field.
    if (typeof value.version === 'number' && Number.isFinite(value.version)) summary.version = value.version
    for (const key of ['agent', 'project', 'status', 'action', 'summary'] as const) {
      if (typeof value[key] === 'string') summary[key] = value[key]
    }
    const visible = lines.slice(0, last)
    if (before.trimEnd()) visible.push(before.trimEnd())
    return { visibleText: visible.join('\n').trimEnd(), summary, footer: line.slice(start) }
  }
  return null
}

export function stripNotifySummaryFooter(text: string): string { return splitNotifySummary(text)?.visibleText ?? text }

export const sourceNotifySummarySchema = z.object({
  messageId: z.string().min(1), sourceRowId: z.string().min(1), surfaceSeq: z.number().int().nonnegative(),
  turn: z.number().int().positive(), step: z.number().int().positive(),
  originalText: z.string(), summaries: z.array(z.object({ blockIndex: z.number().int().nonnegative(),
    summary: notifySummarySchema, footer: z.string() })).min(1),
})
export type SourceNotifySummary = z.infer<typeof sourceNotifySummarySchema>

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap { 'plugin:hapi-dsh/notify-summary': SourceNotifySummary }
}

/** Keep every non-text block and its exact position, including reasoning and attachments. */
export function projectNotifySummaries(content: readonly ContentBlock[]): {
  content: readonly ContentBlock[]; summaries: SourceNotifySummary['summaries']; originalText: string;
} {
  const summaries: SourceNotifySummary['summaries'] = []
  const projected = content.map((block, blockIndex): ContentBlock => {
    if (block.type !== 'text') return block
    const parsed = splitNotifySummary(block.text)
    if (!parsed) return block
    summaries.push({ blockIndex, summary: parsed.summary, footer: parsed.footer })
    return { ...block, text: parsed.visibleText }
  })
  return { content: summaries.length ? projected : content, summaries,
    // Match the original HAPI copy contract across text parts. Reasoning and
    // binary attachments never become machine-summary clipboard text.
    originalText: content.flatMap(block => block.type === 'text' && block.text.trim() ? [block.text.trim()] : []).join('\n\n') }
}

/** Client readers validate owner records without importing the Host Session implementation. */
export function sourceNotifySummaryOf(event: { type: string; data: unknown }): SourceNotifySummary | null {
  if (event.type !== 'plugin:hapi-dsh/notify-summary') return null
  const parsed = sourceNotifySummarySchema.safeParse(event.data)
  return parsed.success ? parsed.data : null
}
