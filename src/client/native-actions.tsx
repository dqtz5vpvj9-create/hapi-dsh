import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { HapiApprovalAnswer } from '../codex/contracts.ts'
import type { ApprovalView, DeliveryView, HapiProjection } from '../codex/projection-types.ts'
import type { WorkspaceTranslate } from './locales.ts'
import { formatNativeAnswers, parseNativeQuestions, questionAnswered, questionOptions, selectQuestionOption, type NativeQuestionAnswer } from './native-input.ts'
import { NativeActionLedger } from './native-state.ts'
import { errorMessage } from './controller.ts'
import type { NativeControlLedger } from './native-control-state.ts'
import { NativeSettingsControls } from './native-controls.tsx'
import { NativePlanControls } from './native-plan.tsx'

export interface NativeActionsApi {
    readonly ledger: NativeActionLedger
    readonly controls?: NativeControlLedger
    branchLabel?(): string
    cancel(sessionId: string, localId: string): Promise<unknown>
    steer(sessionId: string, localId: string): Promise<unknown>
    retry(sessionId: string, localId: string): Promise<unknown>
    answer(sessionId: string, requestId: string, answer: HapiApprovalAnswer, deny?: boolean): Promise<unknown>
    resume(sessionId: string): Promise<unknown>
}

function printable(value: unknown): string {
    try { return JSON.stringify(value, null, 2) ?? '' } catch { return String(value) }
}

function NativeRequest({ sessionId, request, api, disabled, t }: {
    sessionId: string; request: ApprovalView; api: NativeActionsApi; disabled: boolean; t: WorkspaceTranslate
}) {
    const action = api.ledger.action(sessionId, 'approval', request.requestId)
    const state = useSyncExternalStore(action.subscribe, action.getSnapshot)
    const parsed = useMemo(() => parseNativeQuestions(request.arguments), [request.arguments])
    const [answers, setAnswers] = useState<Record<string, NativeQuestionAnswer>>(() => Object.fromEntries(
        parsed.questions.map(question => [question.id, { selected: [], userNote: question.prefill ?? '' }]),
    ))
    const blocked = disabled || state.busy || state.submitted || request.stage !== 'pending'
    const answer = (value: HapiApprovalAnswer, deny = false): void => {
        if (blocked) return
        void action.run(() => api.answer(sessionId, request.requestId, value, deny), true)
    }
    const submitted = state.submitted || request.stage === 'submitted'
    return <section className="hapi-native-request" data-native-request={request.requestId} aria-busy={state.busy}>
        <header><strong>{request.tool}</strong><span className="hapi-state">{submitted ? t('acknowledged') : request.stage === 'indeterminate' ? t('awaitingConfirmation') : t('nativeRequests')}</span></header>
        {parsed.questions.length ? <form onSubmit={event => { event.preventDefault(); answer({ answers: formatNativeAnswers(parsed.questions, answers) }) }}>
            {parsed.questions.map(question => {
                const current = answers[question.id] ?? { selected: [], userNote: question.prefill ?? '' }
                const change = (next: NativeQuestionAnswer): void => setAnswers(values => ({ ...values, [question.id]: next }))
                return <fieldset key={question.id} disabled={blocked}>
                    <legend>{question.question || question.id}</legend>
                    {questionOptions(question).map(option => <label className="hapi-native-option" key={option.label}>
                        <input type={question.multiple ? 'checkbox' : 'radio'} name={`${request.requestId}:${question.id}`}
                            checked={current.selected.includes(option.label)} onChange={() => change({ ...current, selected: selectQuestionOption(question, current.selected, option) })}/>
                        <span>{option.label}{option.description && <small>{option.description}</small>}</span>
                    </label>)}
                    <textarea aria-label={question.question || t('answer')} value={current.userNote} placeholder={question.placeholder ?? t('answer')}
                        rows={question.inputType === 'editor' ? 5 : 2} onChange={event => change({ ...current, userNote: event.currentTarget.value })}/>
                </fieldset>
            })}
            {parsed.url && <a href={parsed.url} target="_blank" rel="noopener noreferrer">{parsed.url}</a>}
            <div className="hapi-button-row">
                <button type="submit" disabled={blocked || !parsed.questions.every(question => questionAnswered(question, answers[question.id]))}>{t('submit')}</button>
                <button type="button" disabled={blocked} onClick={() => answer({ decision: 'abort' }, true)}>{t('abort')}</button>
                {parsed.canSkip && <button type="button" disabled={blocked} onClick={() => answer({ answers: {} })}>{t('cancel')}</button>}
            </div>
        </form> : <>
            <details><summary>{t('more')}</summary><pre>{printable(request.arguments)}</pre></details>
            <div className="hapi-button-row">
                <button type="button" disabled={blocked} onClick={() => answer({ decision: 'approved' })}>{t('approve')}</button>
                <button type="button" disabled={blocked} onClick={() => answer({ decision: 'approved_for_session' })}>{t('approveSession')}</button>
                <button type="button" disabled={blocked} onClick={() => answer({ decision: 'denied' }, true)}>{t('deny')}</button>
                <button type="button" disabled={blocked} onClick={() => answer({ decision: 'abort' }, true)}>{t('abort')}</button>
            </div>
        </>}
        {(state.error || request.error) && <p className="hapi-error" role="alert">{state.error ?? request.error}</p>}
    </section>
}

function NativeDelivery({ sessionId, delivery, api, disabled, t }: {
    sessionId: string; delivery: DeliveryView; api: NativeActionsApi; disabled: boolean; t: WorkspaceTranslate
}) {
    const action = api.ledger.action(sessionId, 'delivery', delivery.localId)
    const state = useSyncExternalStore(action.subscribe, action.getSnapshot)
    const blocked = disabled || state.busy
    const send = (kind: 'cancel' | 'steer' | 'retry'): void => {
        if (blocked) return
        void action.run(() => api[kind](sessionId, delivery.localId), false)
    }
    const resultStatus: unknown = state.result && typeof state.result === 'object' ? Reflect.get(state.result, 'status') : undefined
    return <section className="hapi-native-delivery" data-delivery-state={delivery.state} aria-busy={state.busy}>
        <div className="hapi-delivery-heading"><span className="hapi-ellipsis">{delivery.text}</span><span className="hapi-state">{delivery.state}</span></div>
        <div className="hapi-button-row">
            {['queued', 'accepted'].includes(delivery.state) && <>
                <button type="button" disabled={blocked} onClick={() => send('steer')}>{t('steer')}</button>
                <button type="button" disabled={blocked} onClick={() => send('cancel')}>{t('cancelQueued')}</button>
            </>}
            {delivery.state === 'indeterminate' && <button type="button" disabled={blocked} onClick={() => send('retry')}>{t('retryDelivery')}</button>}
            {delivery.state === 'dispatching' && <span>{t('awaitingConfirmation')}</span>}
            {typeof resultStatus === 'string' && <output>{resultStatus}</output>}
        </div>
        {(state.error || delivery.error) && <p className="hapi-error" role="alert">{state.error ?? delivery.error}</p>}
    </section>
}

/** Native-only control surface adjacent to, never replacing, DSH's composer. */
export function NativeActions({ sessionId, projection, api, t }: {
    sessionId: string; projection: HapiProjection | undefined; api: NativeActionsApi; t: WorkspaceTranslate
}) {
    const [resuming, setResuming] = useState(false)
    const [resumeError, setResumeError] = useState<string | null>(null)
    useEffect(() => {
        if (projection) api.ledger.resolved(sessionId, projection.resolvedRequests.map(request => request.requestId))
    }, [api, sessionId, projection])
    if (!projection) return null
    const delivery = projection.delivery.filter(row => !['invoked', 'cancelled'].includes(row.state))
    const disabled = projection.readOnly || projection.nativeConnection !== 'attached'
    return <aside className="hapi-native" aria-label={t('nativeStatus')}>
        <div className="hapi-native-status"><span>Codex · {projection.nativeConnection}</span><span>{projection.execution?.status ?? ''}</span></div>
        {api.controls && <NativeSettingsControls ledger={api.controls} sessionId={sessionId} disabled={disabled} t={t}/>}
        {api.controls && <NativePlanControls ledger={api.controls} sessionId={sessionId} planId={projection.planId} disabled={disabled} t={t}/>}
        {projection.nativeConnection !== 'attached' && <button type="button" disabled={resuming} onClick={() => {
            if (resuming) return
            setResuming(true); setResumeError(null)
            void api.resume(sessionId).catch(error => setResumeError(errorMessage(error))).finally(() => setResuming(false))
        }}>{resuming ? t('awaitingConfirmation') : t('resume')}</button>}
        {resumeError && <p className="hapi-error" role="alert">{resumeError}</p>}
        {projection.error && <p className="hapi-error" role="alert">{projection.error}</p>}
        {projection.pendingRequests.map(request => <NativeRequest key={request.requestId} sessionId={sessionId} request={request} api={api} disabled={disabled} t={t}/>)}
        {delivery.length > 0 && <details open={delivery.some(row => row.state === 'indeterminate')}>
            <summary>{t('nativeDelivery')} · {delivery.length}</summary>
            {delivery.map(row => <NativeDelivery key={row.localId} sessionId={sessionId} delivery={row} api={api} disabled={disabled} t={t}/>) }
        </details>}
    </aside>
}
