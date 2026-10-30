import { composerDraftKey, composerRecoveryKey } from './composer-autosave.ts'
import type { DraftOrigin } from './model.ts'

type StorageAccess = Pick<Storage, 'getItem' | 'setItem'>
const text = (draft: unknown): string => typeof draft === 'string' ? draft
    : draft && typeof draft === 'object' && 'text' in draft && typeof draft.text === 'string' ? draft.text : ''
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined

/** Copy semantic content before the new official composer mounts. Old keys remain intact. */
export function migrateCutoverDraft(storage: StorageAccess, origin: DraftOrigin, sessionId: string, paneId: string, hostId: string): void {
    const suffix = JSON.stringify([sessionId, paneId])
    const marker = `hhpi:draft-cutover:${suffix}`
    if (storage.getItem(marker)) return
    const read = (key: string): unknown => { const raw = storage.getItem(key); return raw === null ? undefined : JSON.parse(raw) }
    const oldSource = origin.sourceHubId && origin.sourceSessionId
        ? { hubId: origin.sourceHubId, hapiSessionId: origin.sourceSessionId } : undefined
    const backup = object(read(composerDraftKey(hostId, origin.sessionId, oldSource)))?.draft
    const oldPane = object(read(`dsh.conversation.${JSON.stringify([origin.sessionId, paneId])}`))
    const oldSession = object(read(`dsh.conversation.${origin.sessionId}`))
    const draft = [backup, oldPane?.draft, oldSession?.draft].find(value => text(value).length > 0)
    if (draft !== undefined) {
        const semantic = typeof draft === 'string' ? { text: draft, references: [] } : draft
        const officialKey = `dsh.conversation.${suffix}`
        const official = object(read(officialKey))
        const key = composerDraftKey(hostId, suffix)
        const saved = object(read(key))
        // A browser may already have edited the new source. Keep that draft and
        // expose the old one through the existing visible recovery control.
        if (text(official?.draft) && text(official?.draft) !== text(semantic)
            || text(saved?.draft) && text(saved?.draft) !== text(semantic)) {
            const recoveryKey = composerRecoveryKey(key)
            const copies = read(recoveryKey) ?? []
            if (!Array.isArray(copies)) throw new Error('Stored draft recovery is invalid')
            if (!copies.some((copy: unknown) => JSON.stringify(copy) === JSON.stringify(semantic))) {
                storage.setItem(recoveryKey, JSON.stringify([...copies, semantic]))
            }
        } else {
            storage.setItem(officialKey, JSON.stringify({ ...official, draft: semantic, view: official?.view ?? oldPane?.view ?? oldSession?.view ?? null }))
            storage.setItem(key, JSON.stringify({ version: 1, draft: semantic }))
        }
    }
    storage.setItem(marker, '1')
}
