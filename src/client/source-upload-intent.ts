/** Stable attachment identities travel with the existing durable composer draft. */
export interface SourceUploadIntent { operationId: string; prepared?: Blob; removed?: true }
export type SavedSourceUploadIntents = Array<[string, SourceUploadIntent]>
const intents = new WeakMap<object, Map<string, SourceUploadIntent>>()
const cancellations = new WeakMap<object, Map<string, () => Promise<unknown>>>()
export function sourceUploadIntent(data: object, sessionId: string): SourceUploadIntent {
  let entries = intents.get(data)
  if (!entries) { entries = new Map(); intents.set(data, entries) }
  let intent = entries.get(sessionId)
  if (!intent) { intent = { operationId: crypto.randomUUID() }; entries.set(sessionId, intent) }
  return intent
}
export function captureSourceUploadIntents(data: object, sessionId: string): SavedSourceUploadIntents {
  sourceUploadIntent(data, sessionId)
  return [...intents.get(data)!].map(([key, value]) => [key, { ...value }])
}
export function restoreSourceUploadIntents(data: object, saved: SavedSourceUploadIntents | undefined): void {
  if (saved) intents.set(data, new Map(saved.map(([key, value]) => [key, { ...value }])))
}
export function validSourceUploadIntents(saved: unknown): saved is SavedSourceUploadIntents | undefined {
  return saved === undefined || Array.isArray(saved) && saved.every(entry => Array.isArray(entry) && entry.length === 2
    && typeof entry[0] === 'string' && entry[1] && typeof entry[1].operationId === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(entry[1].operationId)
    && (entry[1].prepared === undefined || entry[1].prepared instanceof Blob))
}
export function registerSourceUploadCancellation(data: object, sessionId: string, intent: SourceUploadIntent, cancel: () => Promise<unknown>): void {
  // An explicit removal may precede the durable begin reply. Its old intent
  // still owns that reply even if this File has since been selected again.
  if (intent.removed) { void cancel().catch(() => {}); return }
  let entries = cancellations.get(data)
  if (!entries) { entries = new Map(); cancellations.set(data, entries) }
  entries.set(sessionId, cancel)
}
/** Explicit removal differs from a view lifetime ending during refresh/navigation. */
export function cancelSourceUpload(data: object, sessionId: string): void {
  const intent = intents.get(data)?.get(sessionId)
  if (intent) intent.removed = true
  const cancel = cancellations.get(data)?.get(sessionId)
  cancellations.get(data)?.delete(sessionId)
  intents.get(data)?.delete(sessionId)
  if (cancel) void cancel().catch(() => {})
}
