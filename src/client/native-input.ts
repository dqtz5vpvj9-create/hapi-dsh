/**
 * Adapted from HAPI web/src/components/ToolCard/requestUserInput.ts at
 * 0f8ef6970884c92fb2ddca3070be2ec56cb50333.
 * Copyright HAPI contributors. SPDX-License-Identifier: AGPL-3.0-only
 */
export const REQUEST_USER_INPUT_OTHER = 'None of the above'
export interface NativeQuestion {
    id: string
    question: string
    required: boolean
    multiple: boolean
    isOther: boolean
    options: Array<{ label: string; description: string | null; isOther?: boolean }>
    placeholder?: string
    prefill?: string
    inputType?: 'editor'
}
export interface NativeQuestionAnswer { selected: string[]; userNote: string }
export interface NativeQuestions { questions: NativeQuestion[]; url: string | null; canSkip: boolean }
function object(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function parseNativeQuestions(input: unknown): NativeQuestions {
    if (!object(input)) return { questions: [], url: null, canSkip: false }
    let url: string | null = null
    if (typeof input.url === 'string') {
        try {
            const parsed = new URL(input.url)
            if (parsed.protocol === 'https:' || parsed.protocol === 'http:') url = parsed.toString()
        } catch { /* Unknown/native protocol links are never opened by the approval UI. */ }
    }
    const questions: NativeQuestion[] = []
    const ids = new Set<string>()
    for (const raw of Array.isArray(input.questions) ? input.questions : []) {
        if (!object(raw) || typeof raw.id !== 'string' || !raw.id.trim() || ids.has(raw.id.trim())) continue
        ids.add(raw.id.trim())
        const options: NativeQuestion['options'] = []
        for (const option of Array.isArray(raw.options) ? raw.options : []) {
            if (!object(option) || typeof option.label !== 'string' || !option.label.trim()) continue
            options.push({ label: option.label.trim(), description: typeof option.description === 'string' ? option.description.trim() : null })
        }
        questions.push({
            id: raw.id.trim(), question: typeof raw.question === 'string' ? raw.question.trim() : '',
            required: raw.required !== false, multiple: raw.multiple === true, isOther: raw.isOther === true, options,
            ...(typeof raw.placeholder === 'string' ? { placeholder: raw.placeholder } : {}),
            ...(typeof raw.prefill === 'string' ? { prefill: raw.prefill } : {}),
            ...(raw.inputType === 'editor' ? { inputType: 'editor' } : {}),
        })
    }
    return { questions, url, canSkip: input.canSkip === true }
}

export function questionOptions(question: NativeQuestion): NativeQuestion['options'] {
    return question.isOther && question.options.length
        ? [...question.options, { label: REQUEST_USER_INPUT_OTHER, description: null, isOther: true }]
        : question.options
}

export function selectQuestionOption(question: NativeQuestion, selected: string[], option: NativeQuestion['options'][number]): string[] {
    if (option.isOther || !question.multiple) return [option.label]
    const current = question.isOther ? selected.filter(value => value !== REQUEST_USER_INPUT_OTHER) : selected
    return current.includes(option.label) ? current.filter(value => value !== option.label) : [...current, option.label]
}

export function questionAnswered(question: NativeQuestion, answer: NativeQuestionAnswer | undefined): boolean {
    if (!question.required) return true
    if (!answer) return false
    if (question.options.length) return answer.selected.length > 0
    return question.inputType === 'editor' || answer.userNote.trim().length > 0
}

/** Preserve native option labels and editor whitespace; this is Codex's nested wire format. */
export function formatNativeAnswers(questions: NativeQuestion[], values: Record<string, NativeQuestionAnswer>): Record<string, { answers: string[] }> {
    const answers: Record<string, { answers: string[] }> = {}
    for (const question of questions) {
        const value = values[question.id] ?? { selected: [], userNote: question.prefill ?? '' }
        const valuesOut = [...value.selected]
        const note = question.inputType === 'editor' ? value.userNote : value.userNote.trim()
        if (note || question.inputType === 'editor') valuesOut.push(`user_note: ${note}`)
        answers[question.id] = { answers: valuesOut }
    }
    return answers
}
