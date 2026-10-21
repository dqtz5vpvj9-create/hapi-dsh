/** An action receipt is not an approval resolution or execution completion. */
import { errorMessage } from './controller.ts'
import type { NativeQuestion, NativeQuestionAnswer } from './native-input.ts'
export interface NativeActionSnapshot { busy: boolean; submitted: boolean; error: string | null; result: unknown }

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
        }
    }
    question(sessionId: string, requestId: string, questions: NativeQuestion[]): NativeQuestionDraft {
        const key = JSON.stringify([sessionId, requestId])
        let draft = this.questions.get(key)
        if (!draft) { draft = new NativeQuestionDraft(questions); this.questions.set(key, draft) }
        return draft
    }
    clear(): void { this.entries.clear(); this.questions.clear() }
}

export class NativeQuestionDraft {
    private snapshot: { step: number; answers: Record<string, NativeQuestionAnswer>; error: string | null }
    private readonly listeners = new Set<() => void>()
    constructor(questions: NativeQuestion[]) {
        this.snapshot = { step: 0, answers: Object.fromEntries(questions.map(question => [question.id, { selected: [], userNote: question.prefill ?? '' }])), error: null }
    }
    getSnapshot = (): typeof this.snapshot => this.snapshot
    subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
    update(patch: Partial<typeof this.snapshot>): void { this.snapshot = { ...this.snapshot, ...patch }; for (const listener of this.listeners) listener() }
    answer(id: string, value: NativeQuestionAnswer): void { this.update({ answers: { ...this.snapshot.answers, [id]: value }, error: null }) }
}
