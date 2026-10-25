import { z } from 'zod'
import type { CommandClaim, DraftSnapshot, InputActions, InputState, SessionInput } from '@deepseek-ai/dsh-client-ui-conversation/client'

const draftSchema = z.object({
    text: z.string(),
    references: z.array(z.object({ source: z.string(), ref: z.string(), offset: z.number().int().nonnegative(),
        length: z.number().int().nonnegative(), label: z.string(), clipboardText: z.string(),
        appearance: z.enum(['session', 'file', 'folder']).optional(), invalid: z.boolean().optional() })),
    command: z.object({ token: z.string() }).optional(),
})
const savedSchema = z.object({ version: z.literal(1), draft: draftSchema })
type DraftStorage = Pick<Storage, 'getItem' | 'setItem'>
type Composer = Pick<SessionInput, 'state' | 'setDraft' | 'insertReference' | 'beginCommand'>

/** A display generation and a pane are views, not owners of an unsent draft. */
export function composerDraftKey(hostId: string, sessionId: string, source?: { hubId: string; hapiSessionId: string }): string {
    return `hapi-dsh:composer-draft:v1:${JSON.stringify(source ? ['hapi', source.hubId, source.hapiSessionId] : ['dsh', hostId, sessionId])}`
}

export function composerDraftSnapshot(state: InputState): DraftSnapshot {
    return { text: state.draft, references: state.occurrences.map(({ occurrenceId: _id, ...reference }) => reference),
        ...(state.claim ? { command: { token: state.claim.token } } : {}) }
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
}

interface AutosaveBinding {
    stop(): void
    resume(): void
}

/** One subscription per actual official input, even when it has several panes. */
export class ComposerAutosaves {
    private readonly seats = new Map<Composer, AutosaveBinding & { key: string; users: number }>()
    private readonly owners = new Map<string, Composer>()

    retain(options: AutosaveOptions): () => void {
        const { composer, key } = options
        let seat = this.seats.get(composer)
        if (!seat) {
            this.owners.set(key, composer)
            seat = { key, users: 0, ...this.bind(options, () => this.owners.get(key) === composer) }
            this.seats.set(composer, seat)
        }
        seat.users++
        let released = false
        return () => {
            if (released) return
            released = true
            if (--seat.users) return
            seat.stop(); this.seats.delete(composer)
            if (this.owners.get(key) !== composer) return
            let replacement: Composer | undefined
            for (const [candidate, active] of this.seats) if (active.key === key) replacement = candidate
            if (replacement) {
                this.owners.set(key, replacement)
                this.seats.get(replacement)!.resume()
            } else this.owners.delete(key)
        }
    }

    private bind({ key, storage, composer, actions, resolveCommand, report }: AutosaveOptions, owns: () => boolean): AutosaveBinding {
        const lifetime = new AbortController()
        let previous: string | undefined, failed = false
        let resumedAt: number | undefined
        let command: { token: string; revision: number } | undefined
        const save = () => {
            if (!owns()) return
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
            const raw = storage.getItem(key)
            const saved = raw === null ? null : savedSchema.parse(JSON.parse(raw)).draft
            const state = composer.state.getSnapshot()
            if (saved?.text && state.draft && saved.text !== state.draft) {
                // A stale official draft can coexist with a newer local backup.
                // Keep both before choosing the already mounted editor.
                const copies = readComposerRecoveries(storage, key)
                if (!copies.some(copy => JSON.stringify(copy) === JSON.stringify(saved))) {
                    storage.setItem(composerRecoveryKey(key), JSON.stringify([...copies, saved]))
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
            return { stop: () => lifetime.abort(), resume() {} }
        }
        save()
        const stop = composer.state.subscribe(save)
        if (command && resolveCommand) {
            const pending = command
            void resolveCommand(pending.token.trimEnd(), lifetime.signal).then(claim => {
                if (lifetime.signal.aborted || !owns() || !claim) return
                const state = composer.state.getSnapshot()
                if (state.draftRev !== pending.revision || state.phase !== 'plain') return
                composer.beginCommand(claim, { start: 0, end: pending.token.trimEnd().length, draftRev: state.draftRev })
            }).catch(error => { if (!lifetime.signal.aborted) report(error) })
        }
        return {
            stop: () => { save(); stop(); lifetime.abort() },
            resume: () => { previous = undefined; resumedAt = composer.state.getSnapshot().draftRev },
        }
    }
}
