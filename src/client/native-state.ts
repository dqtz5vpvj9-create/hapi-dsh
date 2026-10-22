/** An action receipt is not an approval resolution or execution completion. */
import { errorMessage } from './controller.ts'
import type { NativeQuestion, NativeQuestionAnswer } from './native-input.ts'
export interface NativeActionSnapshot { busy: boolean; submitted: boolean; error: string | null; result: unknown }
export function nativeRequestStateKey(source: { hubId: string; hapiSessionId: string }): string {
    return JSON.stringify([source.hubId, source.hapiSessionId])
}
type QuestionStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export class NativeAction {
    private snapshot: NativeActionSnapshot = { busy: false, submitted: false, error: null, result: undefined }
    private readonly listeners = new Set<() => void>()
    getSnapshot = (): NativeActionSnapshot => this.snapshot
    subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
    private publish(patch: Partial<NativeActionSnapshot>): void {
        this.snapshot = { ...this.snapshot, ...patch }
        for (const listener of this.listeners) listener()
    }
    async run(operation: () => Promise<unknown>, waitForNativeResolution: boolean): Promise<boolean> {
        if (this.snapshot.busy || this.snapshot.submitted) return false
        this.publish({ busy: true, error: null, result: undefined })
        try {
            const result = await operation()
            this.publish({ busy: false, submitted: waitForNativeResolution, result })
            return true
        } catch (error) {
            this.publish({ busy: false, error: errorMessage(error) })
            return false
        }
    }
}

/** Request-id ownership survives pane switches and temporary component unmounts. */
export class NativeActionLedger {
    private readonly entries = new Map<string, NativeAction>()
    private readonly questions = new Map<string, NativeQuestionDraft>()
    constructor(private readonly storage?: QuestionStorage) {}
    private questionKey(sessionId: string, id: string): string { return `hapi-dsh:question-draft:${JSON.stringify([sessionId, id])}` }
    action(sessionId: string, kind: 'approval' | 'delivery', id: string): NativeAction {
        const key = JSON.stringify([sessionId, kind, id])
        let action = this.entries.get(key)
        if (!action) { action = new NativeAction(); this.entries.set(key, action) }
        return action
    }
    resolved(sessionId: string, requestIds: readonly string[]): void {
        for (const id of requestIds) {
            this.entries.delete(JSON.stringify([sessionId, 'approval', id]))
            this.questions.delete(JSON.stringify([sessionId, id]))
            try { this.storage?.removeItem(this.questionKey(sessionId, id)) } catch { /* Live resolution still closes the form. */ }
        }
    }
    question(sessionId: string, requestId: string, questions: NativeQuestion[]): NativeQuestionDraft {
        const key = JSON.stringify([sessionId, requestId])
        let draft = this.questions.get(key)
        if (!draft) {
            const storageKey = this.questionKey(sessionId, requestId)
            let saved: string | null = null
            try { saved = this.storage?.getItem(storageKey) ?? null } catch { /* Keep the live draft when storage is unavailable. */ }
            draft = new NativeQuestionDraft(questions, saved, value => {
                try { this.storage?.setItem(storageKey, JSON.stringify(value)) } catch { /* The mounted form retains its current answers. */ }
            })
            this.questions.set(key, draft)
        }
        return draft
    }
    clear(): void { this.entries.clear(); this.questions.clear() }
}

export class NativeQuestionDraft {
    private snapshot: { step: number; answers: Record<string, NativeQuestionAnswer>; error: string | null }
    private readonly listeners = new Set<() => void>()
    constructor(questions: NativeQuestion[], saved: string | null = null, private readonly persist?: (value: { step: number; answers: Record<string, NativeQuestionAnswer> }) => void) {
        this.snapshot = { step: 0, answers: Object.fromEntries(questions.map(question => [question.id, { selected: [], userNote: question.prefill ?? '' }])), error: null }
        try {
            const value: unknown = JSON.parse(saved ?? 'null')
            if (!value || typeof value !== 'object') return
            const answers = Reflect.get(value, 'answers'), step = Reflect.get(value, 'step')
            if (!answers || typeof answers !== 'object') return
            for (const question of questions) {
                const answer = Reflect.get(answers, question.id)
                if (answer && Array.isArray(answer.selected) && answer.selected.every((item: unknown) => typeof item === 'string')
                    && typeof answer.userNote === 'string') this.snapshot.answers[question.id] = { selected: answer.selected, userNote: answer.userNote }
            }
            if (Number.isSafeInteger(step)) this.snapshot.step = Math.max(0, Math.min(step, questions.length - 1))
        } catch { /* An invalid optional draft does not replace the source's current questions. */ }
    }
    getSnapshot = (): typeof this.snapshot => this.snapshot
    subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
    update(patch: Partial<typeof this.snapshot>): void {
        this.snapshot = { ...this.snapshot, ...patch }
        this.persist?.({ step: this.snapshot.step, answers: this.snapshot.answers })
        for (const listener of this.listeners) listener()
    }
    answer(id: string, value: NativeQuestionAnswer): void { this.update({ answers: { ...this.snapshot.answers, [id]: value }, error: null }) }
}
