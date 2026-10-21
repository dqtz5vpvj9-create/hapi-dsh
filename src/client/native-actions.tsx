import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { HapiApprovalAnswer } from '../codex/contracts.ts'
import type { ApprovalView, DeliveryView, HapiProjection } from '../codex/projection-types.ts'
import type { WorkspaceTranslate } from './locales.ts'
import { formatNativeAnswers, nativeUrlConfirmed, openNativeInputUrl, parseNativeQuestions, questionAnswered, questionOptions, selectQuestionOption, type NativeQuestionAnswer } from './native-input.ts'
import { NativeActionLedger } from './native-state.ts'
import { errorMessage } from './controller.ts'
import type { NativeControlLedger } from './native-control-state.ts'
import { NativeSettingsControls } from './native-controls.tsx'
import { NativePlanControls } from './native-plan.tsx'
import type { HapiObservedProjection } from '../hapi-agent/projection-types.ts'
import { ObservedSettingsControls, type ObservedControlLedger } from './observed-controls.tsx'

export interface NativeActionsApi {
    readonly ledger: NativeActionLedger
    readonly controls?: NativeControlLedger
    readonly observedControls?: ObservedControlLedger
    readonly queuedEditing?: { busy: boolean; label: string; edit(sessionId: string, delivery: DeliveryView): void }
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

function SourceNoticeText({ notice }: { notice: { text: string; details?: string | undefined } }) {
    return <><pre>{notice.text}</pre>{notice.details && <details><summary>Details / 详情</summary><pre>{notice.details}</pre></details>}</>
}

function NativeRequest({ sessionId, request, api, disabled, t }: {
    sessionId: string; request: ApprovalView; api: NativeActionsApi; disabled: boolean; t: WorkspaceTranslate
}) {
    const action = api.ledger.action(sessionId, 'approval', request.requestId)
    const state = useSyncExternalStore(action.subscribe, action.getSnapshot)
    const parsed = useMemo(() => parseNativeQuestions(request.arguments), [request.arguments])
    const draft = api.ledger.question(sessionId, request.requestId, parsed.questions)
    const draftState = useSyncExternalStore(draft.subscribe, draft.getSnapshot)
    const { answers } = draftState
    const step = Math.min(Math.max(draftState.step, 0), Math.max(parsed.questions.length - 1, 0))
    const blocked = disabled || state.busy || state.submitted || request.stage !== 'pending'
    const answer = (value: HapiApprovalAnswer, deny = false): void => {
        if (blocked) return
        void action.run(() => api.answer(sessionId, request.requestId, value, deny), true)
    }
    const submitted = state.submitted || request.stage === 'submitted'
    const submit = (): void => {
        if (blocked) return
        const invalid = parsed.questions.findIndex(question => !questionAnswered(question, answers[question.id]))
        if (invalid >= 0) { draft.update({ step: invalid, error: t('requiredAnswer') }); return }
        if (parsed.url) {
            if (!nativeUrlConfirmed(parsed, answers)) { draft.update({ error: t('confirmNativeUrl') }); return }
            if (!openNativeInputUrl(parsed.url)) { draft.update({ error: t('popupBlocked') }); return }
        }
        draft.update({ error: null })
        answer({ answers: formatNativeAnswers(parsed.questions, answers) })
    }
    return <section className="hapi-native-request" data-native-request={request.requestId} aria-busy={state.busy}>
        <header><strong>{request.tool}</strong><span className="hapi-state">{submitted ? t('acknowledged') : request.stage === 'indeterminate' ? t('awaitingConfirmation') : t('nativeRequests')}</span></header>
        {parsed.questions.length > 0 || request.tool === 'request_user_input' ? <form onSubmit={event => { event.preventDefault(); submit() }}>
            {parsed.questions.length > 1 && <p className="hapi-native-question-progress">{step + 1} / {parsed.questions.length}</p>}
            {parsed.questions.slice(step, step + 1).map(question => {
                const current = answers[question.id] ?? { selected: [], userNote: question.prefill ?? '' }
                const change = (next: NativeQuestionAnswer): void => draft.answer(question.id, next)
                return <fieldset key={question.id} disabled={blocked}>
                    <legend>{question.question || question.id}</legend>
                    {questionOptions(question).map(option => <label className="hapi-native-option" key={option.label}>
                        <input type={question.multiple ? 'checkbox' : 'radio'} name={`${request.requestId}:${question.id}`}
                            checked={current.selected.includes(option.label)} onChange={() => change({ ...current, selected: selectQuestionOption(question, current.selected, option) })}/>
                        <span>{option.isOther ? t('otherOption') : option.label}{option.description && <small>{option.description}</small>}</span>
                    </label>)}
                    <textarea aria-label={question.question || t('answer')} value={current.userNote} placeholder={question.placeholder ?? t('answer')}
                        rows={question.inputType === 'editor' ? 5 : 2} onChange={event => change({ ...current, userNote: event.currentTarget.value })}/>
                </fieldset>
            })}
            {parsed.url && <p className="hapi-native-url">{parsed.url}</p>}
            <div className="hapi-button-row">
                {step > 0 && <button type="button" disabled={blocked} onClick={() => draft.update({ step: step - 1, error: null })}>{t('previousQuestion')}</button>}
                {step < parsed.questions.length - 1 ? <button type="button" disabled={blocked} onClick={() => {
                    const question = parsed.questions[step]!
                    if (!questionAnswered(question, answers[question.id])) draft.update({ error: t('requiredAnswer') })
                    else draft.update({ step: step + 1, error: null })
                }}>{t('nextQuestion')}</button> : <button type="submit" disabled={blocked}>{t('submit')}</button>}
                <button type="button" disabled={blocked} onClick={() => answer({ decision: 'abort' }, true)}>{t('abort')}</button>
                {parsed.canSkip && <button type="button" disabled={blocked} onClick={() => answer({}, true)}>{t('skipQuestion')}</button>}
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
        {(state.error || request.error || draftState.error) && <p className="hapi-error" role="alert">{state.error ?? request.error ?? draftState.error}</p>}
    </section>
}

function NativeDelivery({ sessionId, delivery, api, disabled, steer = true, t }: {
    sessionId: string; delivery: DeliveryView; api: NativeActionsApi; disabled: boolean; steer?: boolean; t: WorkspaceTranslate
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
            {delivery.editable && api.queuedEditing && <button type="button" disabled={state.busy || api.queuedEditing.busy}
                onClick={() => api.queuedEditing?.edit(sessionId, delivery)}>{api.queuedEditing.label}</button>}
            {['queued', 'accepted'].includes(delivery.state) && <>
                {steer && <button type="button" disabled={blocked} onClick={() => send('steer')}>{t('steer')}</button>}
                <button type="button" disabled={blocked} onClick={() => send('cancel')}>{t('cancelQueued')}</button>
            </>}
            {delivery.state === 'indeterminate' && <button type="button" disabled={blocked} onClick={() => send('retry')}>{t('retryDelivery')}</button>}
            {delivery.state === 'dispatching' && <span>{t('awaitingConfirmation')}</span>}
            {typeof resultStatus === 'string' && <output>{resultStatus}</output>}
        </div>
        {(state.error || delivery.error) && <p className="hapi-error" role="alert">{state.error ?? delivery.error}</p>}
    </section>
}

/** Original HAPI engines share controls, never pretend to be Codex or a DSH loop. */
export function ObservedActions({ sessionId, projection, api, t }: { sessionId: string; projection: HapiObservedProjection | undefined; api: NativeActionsApi; t: WorkspaceTranslate }) {
    useEffect(() => { if (projection) api.ledger.resolved(sessionId, projection.resolvedRequests.map(row => row.requestId)) }, [projection, sessionId, api])
    if (!projection || projection.dshChild) return null
    const deliveries = projection.delivery.filter(row => !['invoked', 'cancelled'].includes(row.state))
    return <aside className="hapi-native" aria-label={t('sourceStatus')}>
        <div className="hapi-native-status"><span>{projection.flavor} · {projection.connection}</span><span>{projection.controlledByUser ? t('sourceControlled') : projection.thinking ? t('running') : t('idle')}</span></div>
        {Reflect.get(projection, 'sidechain') ? <span>{t('sourceReadOnly')}</span> : api.observedControls && <ObservedSettingsControls ledger={api.observedControls} sessionId={sessionId} t={t}/>}
        {projection.error && <p className="hapi-error" role="alert">{projection.error}</p>}
        {projection.usage && <details className="hapi-native-usage"><summary>{t('contextUsage')} · {projection.usage.contextTokens.toLocaleString()}{projection.usage.contextWindow ? ` / ${projection.usage.contextWindow.toLocaleString()}` : ''}</summary><dl>
            <div><dt>{t('inputTokens')}</dt><dd>{projection.usage.inputTokens.toLocaleString()}</dd></div><div><dt>{t('outputTokens')}</dt><dd>{projection.usage.outputTokens.toLocaleString()}</dd></div>
            {projection.usage.cachedInputTokens !== null && <div><dt>{t('cachedTokens')}</dt><dd>{projection.usage.cachedInputTokens.toLocaleString()}</dd></div>}
        </dl></details>}
        {projection.notices.length > 0 && <details className="hapi-native-notices" open={projection.notices.some(notice => notice.kind === 'error')}><summary>{t('nativeNotices')} · {projection.notices.length}</summary>{projection.notices.map(notice => <section key={notice.id} className={notice.kind === 'error' ? 'hapi-error' : ''}><header><span>{notice.kind}</span><time>{new Date(notice.createdAt).toLocaleTimeString()}</time></header><SourceNoticeText notice={notice}/></section>)}</details>}
        {projection.pendingRequests.map(request => <NativeRequest key={request.requestId} sessionId={sessionId} request={request} api={api} disabled={projection.readOnly} t={t}/>)}
        {deliveries.length > 0 && <details open={deliveries.some(row => row.state === 'indeterminate')}><summary>{t('nativeDelivery')} · {deliveries.length}</summary>
            {deliveries.map(delivery => <NativeDelivery key={delivery.localId} sessionId={sessionId} delivery={delivery} api={api} disabled={projection.readOnly} steer={projection.capabilities.steer} t={t}/>)}
        </details>}
    </aside>
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
        {projection.usage && <details className="hapi-native-usage"><summary>{t('contextUsage')} · {projection.usage.contextTokens.toLocaleString()}{projection.usage.contextWindow ? ` / ${projection.usage.contextWindow.toLocaleString()}` : ''}</summary>
            <dl><div><dt>{t('inputTokens')}</dt><dd>{projection.usage.inputTokens.toLocaleString()}</dd></div><div><dt>{t('outputTokens')}</dt><dd>{projection.usage.outputTokens.toLocaleString()}</dd></div>
                {projection.usage.cachedInputTokens !== null && <div><dt>{t('cachedTokens')}</dt><dd>{projection.usage.cachedInputTokens.toLocaleString()}</dd></div>}
            </dl>{projection.usage.total && <><strong>{t('totalUsage')}</strong><dl><div><dt>{t('inputTokens')}</dt><dd>{projection.usage.total.inputTokens.toLocaleString()}</dd></div><div><dt>{t('outputTokens')}</dt><dd>{projection.usage.total.outputTokens.toLocaleString()}</dd></div></dl></>}
        </details>}
        {projection.threadGoal && <details className="hapi-native-goal"><summary>{t('threadGoal')} · {projection.threadGoal.status}</summary><p>{projection.threadGoal.objective}</p>
            <dl><div><dt>{t('tokensUsed')}</dt><dd>{projection.threadGoal.tokensUsed.toLocaleString()}{projection.threadGoal.tokenBudget == null ? '' : ` / ${projection.threadGoal.tokenBudget.toLocaleString()}`}</dd></div><div><dt>{t('goalTime')}</dt><dd>{Math.round(projection.threadGoal.timeUsedSeconds)}s</dd></div></dl>
        </details>}
        {(projection.notices?.length ?? 0) > 0 && <details className="hapi-native-notices" open={projection.notices.some(notice => notice.kind === 'error')}><summary>{t('nativeNotices')} · {projection.notices.length}</summary>
            {projection.notices.map(notice => <section key={notice.id} data-native-notice={notice.id} className={notice.kind === 'error' ? 'hapi-error' : ''}><header><span>{notice.kind}</span><time dateTime={new Date(notice.createdAt).toISOString()}>{new Date(notice.createdAt).toLocaleTimeString()}</time></header><SourceNoticeText notice={notice}/></section>)}
        </details>}
        {projection.pendingRequests.map(request => <NativeRequest key={request.requestId} sessionId={sessionId} request={request} api={api} disabled={disabled} t={t}/>)}
        {delivery.length > 0 && <details open={delivery.some(row => row.state === 'indeterminate')}>
            <summary>{t('nativeDelivery')} · {delivery.length}</summary>
            {delivery.map(row => <NativeDelivery key={row.localId} sessionId={sessionId} delivery={row} api={api} disabled={disabled} t={t}/>) }
        </details>}
    </aside>
}
