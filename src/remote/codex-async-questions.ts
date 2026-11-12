/** Source-native async questions survive turns; only explicit per-question replies settle them. */
import { nativeAsyncQuestions, nativeQuestionReplies, NATIVE_ASYNC_QUESTION, questionItemId } from '../shared/native-async-questions.ts';
import type { SourceApproval } from './protocol.ts';
import type { NativeQuestionsPage } from './codex-metadata-core.mjs';

export interface NativeQuestionState {
    coordinates: string;
    through: number;
    active: SourceApproval[];
    /** Keep exact native identities so a later revision of an answered item cannot reopen it. */
    answered: string[];
}
export function acceptNativeQuestions(previous: NativeQuestionState | undefined, page: NativeQuestionsPage): NativeQuestionState {
    const old = page.reset ? undefined : previous;
    const active = new Map((old?.active ?? []).map(row => [row.id, row])), answered = new Set(old?.answered ?? []);
    for (const entry of [...page.items].sort((a, b) => a.ordinal - b.ordinal)) {
        const item = entry.item;
        if (item.type === 'agentMessage' && item.id === entry.itemId) {
            // A newer typed snapshot can withdraw or replace the question list.
            for (const [id, row] of active) if (row.itemId === entry.itemId) active.delete(id);
            const questions = item.delivery === 'async' ? nativeAsyncQuestions(item.questions) : undefined;
            questions?.forEach((question, index) => {
                const id = questionItemId(entry.itemId, index);
                if (!answered.has(id)) active.set(id, { id, method: NATIVE_ASYNC_QUESTION, turnId: entry.turnId,
                    itemId: entry.itemId, params: { index, question, revision: entry.revision } });
            });
        } else if (item.type === 'userMessage' && Array.isArray(item.content)) {
            for (const content of item.content) for (const reply of nativeQuestionReplies(content?.type === 'text' ? content.text : undefined)) {
                const question = active.get(reply.questionItemId);
                if (question?.params.question && (question.params.question as { title: string }).title === reply.question) {
                    active.delete(reply.questionItemId); answered.add(reply.questionItemId);
                }
            }
        }
    }
    return { coordinates: page.coordinates, through: page.through, active: [...active.values()], answered: [...answered] };
}
