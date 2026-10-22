import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { HapiApprovalAnswer } from '../codex/contracts.ts'
import type { ApprovalView, DeliveryView, HapiProjection } from '../codex/projection-types.ts'
import { composerAdmission, type WorkspaceTranslate } from './locales.ts'
import { formatNativeAnswers, nativeUrlConfirmed, openNativeInputUrl, parseNativeQuestions, questionAnswered, questionOptions, selectQuestionOption, type NativeQuestionAnswer } from './native-input.ts'
import { NativeActionLedger } from './native-state.ts'
import { deliveryActions, deliveryStatusText, deliveryRecoveryDisabled, nativeExecutionStatus, observedExecutionStatus, executionStatusText } from './native-status.ts'
import { errorMessage } from './controller.ts'
import type { NativeControlLedger } from './native-control-state.ts'
import type { HapiObservedProjection } from '../hapi-agent/projection-types.ts'
import type { ObservedControlLedger } from './observed-controls.tsx'
import { openDiagnostics, recordConnection, recordSourceErrors, recordSourceFailure, translate, type DiagnosticIdentity } from './diagnostics/index.ts'

export interface NativeActionsApi {
    readonly ledger: NativeActionLedger
    readonly controls?: NativeControlLedger
    readonly observedControls?: ObservedControlLedger
    readonly queuedEditing?: { busy: boolean; label: string; edit(sessionId: string, delivery: DeliveryView): void }
    branchLabel?(): string
    /** Per-pane-graph identity for remote failure evidence (never page global). */
    identify?(identity: DiagnosticIdentity): void
    cancel(sessionId: string, localId: string): Promise<unknown>
    steer(sessionId: string, localId: string): Promise<unknown>
    retry(sessionId: string, localId: string): Promise<unknown>
    check?(sessionId: string, localId: string): Promise<unknown>
    recover?(sessionId: string, localId: string, action: 'retry' | 'discard'): Promise<unknown>
    answer(sessionId: string, requestId: string, answer: HapiApprovalAnswer, deny?: boolean): Promise<unknown>
    resume(sessionId: string): Promise<unknown>
}

function printable(value: unknown): string {
    try { return JSON.stringify(value, null, 2) ?? '' } catch { return String(value) }
}

function SourceNoticeText({ notice }: { notice: { text: string; details?: string | undefined } }) {
    return <><pre>{notice.text}</pre>{notice.details && <details><summary>Details / 详情</summary><pre>{notice.details}</pre></details>}</>
}

const quietLineStyle = { display: 'flex', alignItems: 'center', gap: '6px', margin: '2px 0', flexWrap: 'wrap' as const,
    color: 'var(--dsw-alias-label-tertiary, #888)', fontSize: '12px', lineHeight: '18px' }
const quietButtonStyle = { font: 'inherit', fontSize: '12px', lineHeight: '18px', padding: 0, cursor: 'pointer',
    border: 'none', background: 'transparent', color: 'var(--dsw-alias-state-business-primary, #3b82f6)', textDecoration: 'underline' }

interface SourceNoticeLike { id: string; kind: string; text: string; details?: string | undefined; createdAt: number }

/** Repeated source errors fold into one quiet disclosure; readable lifecycle
 * notices (compaction/summary/agent messages) keep their own closed disclosure.
 * Folding is presentational: no source event is deleted or rewritten. */
export function splitSourceNotices<T extends { kind: string }>(notices: readonly T[]): { errors: readonly T[]; others: readonly T[] } {
    return { errors: notices.filter(notice => notice.kind === 'error'), others: notices.filter(notice => notice.kind !== 'error') }
}

const NONE_NOTICES: readonly SourceNoticeLike[] = []

/** One quiet "源错误 · N" line; the original notices stay available behind it
 * and an allowlisted copy of their identity is routed to diagnostics. */
function SourceErrorLine({ sessionId, identity, errors = NONE_NOTICES, failure = null, t }: {
    sessionId: string; identity?: DiagnosticIdentity | undefined; errors?: readonly SourceNoticeLike[]
    failure?: string | null; t: WorkspaceTranslate
}) {
    const errorKey = errors.map(notice => notice.id).join(',')
    useEffect(() => {
        if (errors.length) recordSourceErrors(sessionId, errors, identity)
    }, [sessionId, identity?.hubId, identity?.hapiSessionId, errorKey])
    useEffect(() => {
        if (failure) recordSourceFailure(sessionId, 'projection', failure, identity)
    }, [sessionId, identity?.hubId, identity?.hapiSessionId, failure])
    const count = errors.length + (failure ? 1 : 0)
    if (!count) return null
    return <details className="hapi-source-error-line" data-hapi-source-error-line="" open={false}>
        <summary style={quietLineStyle} data-hapi-source-error-summary="">{translate(t, 'Source errors', '源错误')} · {count}</summary>
        {failure && <p role="status">{failure}</p>}
        {errors.map(notice => <section key={notice.id} data-native-notice={notice.id}>
            <header><span>{notice.kind}</span><time dateTime={new Date(notice.createdAt).toISOString()}>{new Date(notice.createdAt).toLocaleTimeString()}</time></header>
            <SourceNoticeText notice={notice}/>
        </section>)}
        <button type="button" data-hapi-diagnostics-open="" style={quietButtonStyle} onClick={openDiagnostics}>{translate(t, 'Open diagnostics', '打开诊断')}</button>
    </details>
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
    return <section className="hapi-native-request" data-native-request={request.requestId} data-hapi-request-id={request.requestId} aria-busy={state.busy}>
        <header><strong>{request.tool}</strong><span className="hapi-state">{submitted ? translate(t, 'Submitted · awaiting source resolution', '已提交 · 等待源端确认') : request.stage === 'indeterminate' ? t('awaitingConfirmation') : t('nativeRequests')}</span></header>
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
                {parsed.canSkip && <button type="button" disabled={blocked} onClick={() => answer({ answers: {} })}>{t('skipQuestion')}</button>}
            </div>
        </form> : <>
            <details><summary>{t('more')}</summary><pre>{printable(request.arguments)}</pre></details>
            <div className="hapi-button-row">
                <button type="button" disabled={blocked} onClick={() => answer({ decision: 'approved' })}>{translate(t, 'Approve once', '批准一次')}</button>
                <button type="button" disabled={blocked} onClick={() => answer({ decision: 'approved_for_session' })}>{t('approveSession')}</button>
                <button type="button" disabled={blocked} onClick={() => answer({ decision: 'denied' }, true)}>{t('deny')}</button>
                <button type="button" disabled={blocked} onClick={() => answer({ decision: 'abort' }, true)}>{t('abort')}</button>
            </div>
        </>}
        {(state.error || request.error || draftState.error) && <p className="hapi-error" role="alert">{state.error ?? request.error ?? draftState.error}</p>}
    </section>
}

function NativeDelivery({ sessionId, delivery, api, disabled, recoveryDisabled, steer = true, t }: {
    sessionId: string; delivery: DeliveryView; api: NativeActionsApi; disabled: boolean; recoveryDisabled: boolean; steer?: boolean; t: WorkspaceTranslate
}) {
    const action = api.ledger.action(sessionId, 'delivery', delivery.localId)
    const state = useSyncExternalStore(action.subscribe, action.getSnapshot)
    const blocked = disabled || state.busy
    const available = deliveryActions(delivery, steer)
    const recover = (kind: 'retry' | 'discard'): void => {
        if (!api.recover || state.busy || kind === 'retry' && recoveryDisabled) return
        void action.run(() => api.recover!(sessionId, delivery.localId, kind), false)
    }
    const send = (kind: 'cancel' | 'steer' | 'retry'): void => {
        if (blocked) return
        void action.run(() => api[kind](sessionId, delivery.localId), false)
    }
    const resultStatus: unknown = state.result && typeof state.result === 'object' ? Reflect.get(state.result, 'status') : undefined
    return <section className="hapi-native-delivery" data-delivery-state={delivery.state} data-hapi-delivery-id={delivery.localId} aria-busy={state.busy}>
        <div className="hapi-delivery-heading"><span className="hapi-ellipsis">{delivery.text}</span><span className="hapi-state">{deliveryStatusText(delivery.state, t)}</span></div>
        <div className="hapi-button-row">
            {available.edit && api.queuedEditing && <button type="button" disabled={state.busy || api.queuedEditing.busy}
                onClick={() => api.queuedEditing?.edit(sessionId, delivery)}>{api.queuedEditing.label}</button>}
            {available.cancel && <>
                {available.steer && <button type="button" disabled={blocked} onClick={() => send('steer')}>{t('steer')}</button>}
                <button type="button" disabled={blocked} onClick={() => send('cancel')}>{t('cancelQueued')}</button>
            </>}
            {available.retryUnknown && api.check && <button type="button" disabled={state.busy} onClick={() => { void action.run(() => api.check!(sessionId, delivery.localId), false) }}>{translate(t, 'Check source result', '检查源端结果')}</button>}
            {available.recover && api.recover && <><button type="button" disabled={state.busy || recoveryDisabled} onClick={() => recover('retry')}>{translate(t, 'Retry', '重试')}</button>
                <button type="button" disabled={state.busy} onClick={() => recover('discard')}>{translate(t, 'Discard', '丢弃')}</button></>}
            {delivery.state === 'dispatching' && <span>{t('awaitingConfirmation')}</span>}
            {typeof resultStatus === 'string' && <output>{resultStatus}</output>}
        </div>
        {(state.error || delivery.error) && <p className="hapi-error" role="alert">{state.error ?? delivery.error}</p>}
    </section>
}

/** Original HAPI engines share controls, never pretend to be Codex or a DSH loop. */
export function ObservedActions({ sessionId, projection, api, t }: { sessionId: string; projection: HapiObservedProjection | undefined; api: NativeActionsApi; t: WorkspaceTranslate }) {
    useEffect(() => { if (projection) api.ledger.resolved(sessionId, projection.resolvedRequests.map(row => row.requestId)) }, [projection, sessionId, api])
    // Per-pane-graph identity for remote failure evidence; never a page-global slot.
    const hubId = projection?.hubId, hapiSessionId = projection?.hapiSessionId, machineId = projection?.machineId ?? null, engine = projection?.flavor
    useEffect(() => {
        if (!projection) return
        api.identify?.({ hubId: projection.hubId, sessionId, hapiSessionId: projection.hapiSessionId, engine: projection.flavor,
            ...(projection.machineId === null ? {} : { machineId: projection.machineId }) })
    }, [sessionId, api, hubId, hapiSessionId, machineId, engine])
    const identity: DiagnosticIdentity | undefined = projection ? { hubId: projection.hubId, sessionId, hapiSessionId: projection.hapiSessionId,
        engine: projection.flavor, ...(projection.machineId === null ? {} : { machineId: projection.machineId }) } : undefined
    const connection = projection?.connection ?? 'disconnected'
    const previousConnection = useRef<typeof connection | null>(null)
    useEffect(() => {
        if (projection && previousConnection.current !== null && previousConnection.current !== connection) recordConnection(sessionId, connection, identity)
        previousConnection.current = connection
    }, [sessionId, connection, hubId, hapiSessionId])
    if (!projection || projection.dshChild) return null
    const deliveries = projection.delivery.filter(row => !['invoked', 'cancelled', 'discarded'].includes(row.state))
    // Routine metadata rows (source settings / context / native messages / turn
    // stats) are intentionally absent: only actionable or exceptional states render.
    const hasDelivery = deliveries.length > 0
    const execution = observedExecutionStatus(projection)
    const hasActionable = projection.pendingRequests.length > 0 || hasDelivery || Boolean(projection.error) || projection.readOnly
    if (!hasActionable) return null
    return <aside className="hapi-native" aria-label={t('sourceStatus')}>
        {(() => {
            const admission = composerAdmission({ readOnly: projection.readOnly, readOnlyReason: projection.readOnlyReason })
            return admission && <p className="hapi-composer-admission" role="status" data-hapi-composer-admission={admission.resume ? 'resume' : 'read-only'}>{t(admission.key)}</p>
        })()}
        <SourceErrorLine sessionId={sessionId} identity={identity} failure={projection.error} t={t}/>
        {projection.pendingRequests.map(request => <NativeRequest key={request.requestId} sessionId={sessionId} request={request} api={api} disabled={projection.readOnly} t={t}/>)}
        {deliveries.length > 0 && <details open={deliveries.some(row => row.state === 'indeterminate' || row.state === 'rejected')}><summary>{t('nativeDelivery')} · {deliveries.length}</summary>
            <p data-hapi-execution-status={execution}>{translate(t, 'Source execution', '源端执行')} · {executionStatusText(execution, t)}</p>
            {deliveries.map(delivery => <NativeDelivery key={delivery.localId} sessionId={sessionId} delivery={delivery} api={api} disabled={projection.readOnly} recoveryDisabled={deliveryRecoveryDisabled(projection)} steer={projection.capabilities.steer} t={t}/>)}
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
    const hubId = projection?.hubId, hapiSessionId = projection?.hapiSessionId, machineId = projection?.machineId ?? null
    const nativeConnection = projection?.nativeConnection
    useEffect(() => {
        if (!projection) return
        api.identify?.({ hubId: projection.hubId, sessionId, hapiSessionId: projection.hapiSessionId, engine: 'codex-native',
            ...(projection.machineId === null ? {} : { machineId: projection.machineId }) })
    }, [sessionId, api, hubId, hapiSessionId, machineId])
    const identity: DiagnosticIdentity | undefined = projection ? { hubId: projection.hubId, sessionId, hapiSessionId: projection.hapiSessionId,
        engine: 'codex-native', ...(projection.machineId === null ? {} : { machineId: projection.machineId }) } : undefined
    const connection = nativeConnection === 'attached' ? 'connected' as const : nativeConnection === 'history' ? 'reconnecting' as const : 'disconnected' as const
    const previousConnection = useRef<typeof connection | null>(null)
    useEffect(() => {
        if (projection && previousConnection.current !== null && previousConnection.current !== connection) recordConnection(sessionId, connection, identity)
        previousConnection.current = connection
    }, [sessionId, connection, hubId, hapiSessionId])
    if (!projection) return null
    const delivery = projection.delivery.filter(row => !['invoked', 'cancelled', 'discarded'].includes(row.state))
    const disabled = projection.readOnly || projection.nativeConnection !== 'attached'
    // Routine metadata rows are intentionally absent; only actionable or
    // exceptional states (approvals, deliveries, errors, resume/read-only) render.
    const hasDelivery = delivery.length > 0
    const execution = nativeExecutionStatus(projection)
    const hasActionable = projection.pendingRequests.length > 0 || hasDelivery || Boolean(projection.error)
        || projection.readOnly || projection.nativeConnection !== 'attached'
    if (!hasActionable) return null
    return <aside className="hapi-native" aria-label={t('nativeStatus')}>
        {/* A disconnected Codex source is not read-only: sending queues a durable
            turn and Resume reconnects the native session. */}
        {(() => {
            const admission = composerAdmission({ nativeConnection: projection.nativeConnection, readOnly: projection.readOnly, readOnlyReason: projection.readOnlyReason })
            return admission && <p className="hapi-composer-admission" role="status" data-hapi-composer-admission={admission.resume ? 'resume' : 'read-only'}>{t(admission.key)}</p>
        })()}
        {projection.nativeConnection !== 'attached' && <button type="button" className="hapi-composer-resume" disabled={resuming} onClick={() => {
            if (resuming) return
            setResuming(true); setResumeError(null)
            void api.resume(sessionId).catch(error => setResumeError(errorMessage(error))).finally(() => setResuming(false))
        }}>{resuming ? t('awaitingConfirmation') : t('resume')}</button>}
        <SourceErrorLine sessionId={sessionId} identity={identity} failure={resumeError} t={t}/>
        <SourceErrorLine sessionId={sessionId} identity={identity} failure={projection.error} t={t}/>
        {projection.pendingRequests.map(request => <NativeRequest key={request.requestId} sessionId={sessionId} request={request} api={api} disabled={disabled} t={t}/>)}
        {delivery.length > 0 && <details open={delivery.some(row => row.state === 'indeterminate' || row.state === 'rejected')}>
            <summary>{t('nativeDelivery')} · {delivery.length}</summary>
            <p data-hapi-execution-status={execution}>{translate(t, 'Source execution', '源端执行')} · {executionStatusText(execution, t)}</p>
            {delivery.map(row => <NativeDelivery key={row.localId} sessionId={sessionId} delivery={row} api={api} disabled={disabled} recoveryDisabled={deliveryRecoveryDisabled(projection)} t={t}/>) }
        </details>}
    </aside>
}
