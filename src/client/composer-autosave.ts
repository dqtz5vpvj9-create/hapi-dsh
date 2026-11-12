import { z } from 'zod'
import type { CommandClaim, DraftSnapshot, InputActions, InputState, SessionInput } from '@deepseek-ai/dsh-client-ui-conversation/client'

const draftSchema = z.object({
    text: z.string(),
    references: z.array(z.object({ source: z.string(), ref: z.string(), offset: z.number().int().nonnegative(),
        length: z.number().int().nonnegative(), label: z.string(), clipboardText: z.string(),
        appearance: z.enum(['session', 'file', 'folder']).optional(), invalid: z.boolean().optional() })),
    command: z.object({ token: z.string() }).optional(),
    retention: z.object({ kind: z.literal('dictation'), id: z.string().min(1), insertedDraft: z.string().optional() }).optional(),
})
const savedSchema = z.object({ version: z.literal(1), draft: draftSchema })
type DraftStorage = Pick<Storage, 'getItem' | 'setItem'>
type Composer = Pick<SessionInput, 'state' | 'setDraft' | 'insertReference' | 'beginCommand'>

export interface ComposerAuthenticatedIdentity {
    getSnapshot(): { readonly scope: string; readonly signal: AbortSignal } | undefined
    subscribe(listener: () => void): () => void
}
/** Unscoped legacy copies are retained; an authenticated owner never guesses their account. */
export function accountComposerDraftKey(scope: string, hostId: string, sessionId: string): string {
    return `hhpi:composer-draft:v2:${JSON.stringify([scope, hostId, sessionId])}`
}

/** Directory omission cannot discard an account's unsent or recovered draft. */
export function hasStoredComposerDraft(storage: Pick<Storage, 'getItem'>, key: string): boolean {
    try {
        const raw = storage.getItem(key)
        const draft = raw === null ? undefined : savedSchema.parse(JSON.parse(raw)).draft
        return !!draft && !!(draft.text || draft.references.length || draft.command || draft.retention)
            || readComposerRecoveries(storage, key).length > 0
    } catch { return true }
}

/** Read the existing attachment owner; never create a database or move bytes. */
export async function hasStoredComposerAttachments(key: string, factory: IDBFactory | undefined = globalThis.indexedDB): Promise<boolean> {
    if (!factory) return typeof window !== 'undefined'
    let database: IDBDatabase | undefined
    try {
        if (typeof factory.databases !== 'function') return true
        const name = 'hapi-dsh-composer-attachments'
        if (!(await factory.databases()).some(entry => entry.name === name)) return false
        database = await new Promise<IDBDatabase | undefined>(resolve => {
            const request = factory.open(name, 1)
            let abandoned = false
            const unknown = () => { abandoned = true; resolve(undefined) }
            request.onerror = request.onblocked = unknown
            request.onupgradeneeded = () => { request.transaction?.abort(); unknown() }
            request.onsuccess = () => { if (abandoned) request.result.close(); else resolve(request.result) }
        })
        if (!database || !database.objectStoreNames.contains('drafts')) return true
        return await new Promise<boolean>(resolve => {
            const request = database!.transaction('drafts', 'readonly').objectStore('drafts').get(key)
            request.onerror = () => resolve(true)
            request.onsuccess = () => {
                const entry = request.result
                if (entry == null || entry.version === 1 && typeof entry.revision === 'string' && entry.value === null) { resolve(false); return }
                const value = entry.value
                if (entry.version !== 1 || typeof entry.revision !== 'string' || value?.version !== 1 || typeof value.text !== 'string'
                    || !Array.isArray(value.files) || !['draft', 'pending'].includes(value.mode) || value.previous !== undefined && !Array.isArray(value.previous)) { resolve(true); return }
                resolve(!!(value.text || value.files.length || value.mode === 'pending' || value.previous?.length))
            }
        })
    } catch { return true }
    finally { database?.close() }
}

/** A display generation and a pane are views, not owners of an unsent draft. */
export function composerDraftKey(hostId: string, sessionId: string, source?: { hubId: string; hapiSessionId: string }): string {
    return `hapi-dsh:composer-draft:v1:${JSON.stringify(source ? ['hapi', source.hubId, source.hapiSessionId] : ['dsh', hostId, sessionId])}`
}

export function composerDraftSnapshot(state: InputState): DraftSnapshot {
    return { text: state.draft, references: state.occurrences.map(({ occurrenceId: _id, ...reference }) => reference),
        ...(state.claim ? { command: { token: state.claim.token } } : {}) }
}

/** A same-native route correction preserves this account's exact draft. No receipts or bytes cross Hosts. */
export function copySourceRouteDraft(storage: DraftStorage, sourceKey: string, targetKey: string, draft: DraftSnapshot): boolean {
    try {
        if (readComposerRecoveries(storage, sourceKey).length || readComposerRecoveries(storage, targetKey).length) return false
        const sourceRaw = storage.getItem(sourceKey), targetRaw = storage.getItem(targetKey)
        const source = sourceRaw === null ? undefined : savedSchema.parse(JSON.parse(sourceRaw)).draft
        const target = targetRaw === null ? undefined : savedSchema.parse(JSON.parse(targetRaw)).draft
        const same = (value: z.infer<typeof draftSchema>) => JSON.stringify(value) === JSON.stringify(draft)
        const nonempty = (value: { text: string; references: readonly unknown[]; command?: unknown } | undefined) => !!value && !!(value.text || value.references.length || value.command)
        // An older live owner, another tab, or a target's existing draft wins over migration.
        if (source && !same(source) || nonempty(draft) && nonempty(target) && !same(target!)) return false
        if (storage.getItem(sourceKey) !== sourceRaw || storage.getItem(targetKey) !== targetRaw) return false
        const raw = JSON.stringify({ version: 1, draft })
        if (sourceRaw === null) storage.setItem(sourceKey, raw)
        if (nonempty(draft) && !nonempty(target)) storage.setItem(targetKey, raw)
        return true
    } catch { return false }
}

/** Restore through the published editor verbs, preserving reference identities. */
export function restoreDraft(composer: Composer, actions: Pick<InputActions, 'insertText'>, draft: z.infer<typeof draftSchema>): void {
    composer.setDraft(draft.text)
    // Rightmost spans first: earlier clipboard offsets are still plain text.
    for (const reference of [...draft.references].reverse()) {
        const { source, ref, label, clipboardText, appearance, offset, length } = reference
        if (!composer.insertReference({ source, ref, label, clipboardText, ...(appearance ? { appearance } : {}) },
            { start: offset, end: offset + length, draftRev: composer.state.getSnapshot().draftRev })) {
            throw new Error('The saved draft reference could not be restored. The saved copy was retained.')
        }
        if (draft.text.slice(offset + length, offset + length + 1) !== ' ' && !actions.insertText('', {
            start: offset + 1, end: offset + 2, draftRev: composer.state.getSnapshot().draftRev,
        })) throw new Error('The saved draft reference separator could not be restored. The saved copy was retained.')
    }
}

export function composerRecoveryKey(key: string): string { return `${key}:recovered` }
export type RecoveredComposerDraft = z.infer<typeof draftSchema>
export function readComposerRecoveries(storage: Pick<Storage, 'getItem'>, key: string): RecoveredComposerDraft[] {
    return z.array(draftSchema).parse(JSON.parse(storage.getItem(composerRecoveryKey(key)) ?? '[]'))
}

// The dictation composer is a lazy chunk. Use the shared document event target,
// not module-local listener state, to notify its already mounted recovery view.
const recoveryEvent = 'hapi-dsh:composer-recoveries'
export function notifyComposerRecoveries(key: string): void {
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(recoveryEvent, { detail: key }))
}
export function subscribeComposerRecoveries(key: string, listener: () => void): () => void {
    if (typeof window === 'undefined') return () => {}
    const changed = (event: Event) => { if ((event as CustomEvent<unknown>).detail === key) listener() }
    window.addEventListener(recoveryEvent, changed)
    return () => window.removeEventListener(recoveryEvent, changed)
}
export function writeComposerRecoveries(storage: DraftStorage, key: string, drafts: readonly (DraftSnapshot | RecoveredComposerDraft)[]): void {
    storage.setItem(composerRecoveryKey(key), JSON.stringify(drafts)); notifyComposerRecoveries(key)
}
/** Only suppress a duplicate recovery control while its words are visible in their dictation panel. */
export function dictationRecoveryIsVisible(key: string, id: string): boolean {
    if (typeof document === 'undefined') return false
    return [...document.querySelectorAll<HTMLElement>('dialog[open] [data-hapi-dictation-recoveries]')].some(panel => {
        try { const owner: unknown = JSON.parse(panel.dataset.hapiDictationRecoveries ?? 'null')
            return Array.isArray(owner) && owner[0] === key && Array.isArray(owner[1]) && owner[1].includes(id)
        } catch { return false }
    })
}

/** A usable original mic entry owns its pending copies even with its panel closed. */
export function dictationRecoveryHasEntry(key: string, id: string): boolean {
    if (typeof document === 'undefined') return false
    return [...document.querySelectorAll<HTMLElement>('[data-hapi-dictation-entry]')]
        .some(entry => entry.dataset.hapiDictationEntry === key) || dictationRecoveryIsVisible(key, id)
}

export function appendRecoveredDraft(composer: Composer, actions: Pick<InputActions, 'insertText'>, draft: RecoveredComposerDraft): void {
    const current = composerDraftSnapshot(composer.state.getSnapshot())
    const prefix = current.text ? `${current.text}\n\n` : ''
    restoreDraft(composer, actions, { text: prefix + draft.text, references: [...current.references,
        ...draft.references.map(reference => ({ ...reference, offset: prefix.length + reference.offset }))] })
}

interface AutosaveOptions {
    key: string
    storage: DraftStorage
    composer: Composer
    actions: Pick<InputActions, 'insertText'>
    resolveCommand?(token: string, signal: AbortSignal): Promise<CommandClaim | undefined>
    report(error: unknown): void
    signal?: AbortSignal
}

interface AutosaveBinding {
    stop(): void
    resume(): void
    checkpoint(): void
}

/** One subscription per actual official input, even when it has several panes. */
export class ComposerAutosaves {
    private readonly seats = new Map<Composer, AutosaveBinding & { key: string; users: number }>()
    private readonly owners = new Map<string, Composer>()
    private membership = 0
    private readonly identities = new WeakMap<Composer, string>()

    /** Used by update prepare/verify; revisions belong to the actual official inputs. */
    revision(): string { return JSON.stringify([this.membership, [...this.seats].map(([composer, seat]) => {
        const state = composer.state.getSnapshot(); return [seat.key, state.draftRev, state.phase, state.attachmentIds]
    })]) }
    checkpoint(): void {
        const revision = this.revision(), failures: unknown[] = []
        for (const seat of this.seats.values()) { try { seat.checkpoint() } catch (error) { failures.push(error) } }
        if (failures.length) throw new AggregateError(failures, failures.map(error => error instanceof Error ? error.message : String(error)).join('\n'))
        if (revision !== this.revision()) throw new Error('A conversation changed while its draft was being saved. Try the update again.')
    }

    retain(options: AutosaveOptions): () => void {
        const { composer, key } = options
        const originalKey = this.identities.get(composer)
        if (originalKey !== undefined && originalKey !== key) throw new Error('This input belongs to an earlier authenticated draft. Reopen the conversation to use the current account; its original draft is retained.')
        this.identities.set(composer, key)
        let seat = this.seats.get(composer)
        if (seat && seat.key !== key) throw new Error('The same composer cannot save drafts for two different source identities.')
        if (!seat) {
            this.owners.set(key, composer)
            seat = { key, users: 0, ...this.bind(options, () => this.owners.get(key) === composer) }
            this.seats.set(composer, seat)
            this.membership++
        }
        seat.users++
        let released = false
        return () => {
            if (released) return
            released = true
            if (--seat.users) return
            seat.stop(); this.seats.delete(composer); this.membership++
            if (this.owners.get(key) !== composer) return
            let replacement: Composer | undefined
            for (const [candidate, active] of this.seats) if (active.key === key) replacement = candidate
            if (replacement) {
                this.owners.set(key, replacement)
                this.seats.get(replacement)!.resume()
            } else this.owners.delete(key)
        }
    }

    private bind({ key, storage, composer, actions, resolveCommand, report, signal }: AutosaveOptions, owns: () => boolean): AutosaveBinding {
        const lifetime = new AbortController()
        let previous: string | undefined, failed = false
        let resumedAt: number | undefined
        let command: { token: string; revision: number } | undefined
        const save = () => {
            if (!owns() || signal?.aborted) return
            const state = composer.state.getSnapshot()
            // Reclaim persistence for future edits without flushing an older
            // editor over the final backup left by the departed owner.
            if (state.draftRev === resumedAt) return
            if (state.phase === 'adjudicating' || state.phase === 'submitting') return
            const draft = composerDraftSnapshot(state)
            if (command && state.draftRev === command.revision && !draft.command) {
                Object.assign(draft, { command: { token: command.token } })
            } else command = undefined
            const raw = JSON.stringify({ version: 1, draft })
            if (raw === previous) return
            try { storage.setItem(key, raw); previous = raw; failed = false }
            catch (error) { if (!failed) report(error); failed = true }
        }
        try {
            signal?.throwIfAborted()
            const raw = storage.getItem(key)
            const saved = raw === null ? null : savedSchema.parse(JSON.parse(raw)).draft
            const state = composer.state.getSnapshot()
            if (saved?.text && state.draft && saved.text !== state.draft) {
                // A stale official draft can coexist with a newer local backup.
                // Keep both before choosing the already mounted editor.
                const copies = readComposerRecoveries(storage, key)
                if (!copies.some(copy => JSON.stringify(copy) === JSON.stringify(saved))) {
                    writeComposerRecoveries(storage, key, [...copies, saved])
                }
            }
            // Existing official/user input wins. Never restore during a send.
            if (saved?.text && !state.draft && !state.attachmentIds.length && state.phase === 'plain') {
                restoreDraft(composer, actions, saved)
                if (saved.command) command = { token: saved.command.token, revision: composer.state.getSnapshot().draftRev }
            }
        } catch (error) {
            report(error)
            // Do not overwrite an unreadable or partly restored saved document.
            return { stop: () => lifetime.abort(), resume() {}, checkpoint() { throw error } }
        }
        save()
        const stop = composer.state.subscribe(save)
        if (command && resolveCommand) {
            const pending = command
            void resolveCommand(pending.token.trimEnd(), lifetime.signal).then(claim => {
                if (lifetime.signal.aborted || signal?.aborted || !owns() || !claim) return
                const state = composer.state.getSnapshot()
                if (state.draftRev !== pending.revision || state.phase !== 'plain') return
                composer.beginCommand(claim, { start: 0, end: pending.token.trimEnd().length, draftRev: state.draftRev })
            }).catch(error => { if (!lifetime.signal.aborted) report(error) })
        }
        return {
            stop: () => { save(); stop(); lifetime.abort() },
            resume: () => { previous = undefined; resumedAt = composer.state.getSnapshot().draftRev },
            checkpoint: () => {
                signal?.throwIfAborted()
                const state = composer.state.getSnapshot()
                if (state.phase === 'adjudicating' || state.phase === 'submitting') throw new Error('Wait for the current conversation submission to settle before updating.')
                const snapshot = composerDraftSnapshot(state)
                const draft = command && state.draftRev === command.revision && !snapshot.command ? { ...snapshot, command: { token: command.token } } : snapshot
                const raw = JSON.stringify({ version: 1, draft }), stored = storage.getItem(key)
                // An older live composer or another tab's newer backup remains intact.
                // Preserve this editor as a recovery copy rather than replacing either draft.
                if (!owns() || state.draftRev === resumedAt || (previous === undefined ? stored !== null : stored !== previous)) {
                    if (stored === raw) return
                    const copies = readComposerRecoveries(storage, key)
                    if (!copies.some(copy => JSON.stringify(copy) === JSON.stringify(draft))) writeComposerRecoveries(storage, key, [...copies, draft])
                } else {
                    storage.setItem(key, raw); previous = raw; failed = false
                }
            },
        }
    }
}
