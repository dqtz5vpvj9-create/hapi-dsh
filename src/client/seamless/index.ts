/**
 * Seamless earlier-history loading: public seams of the plugin-internal core.
 *
 * The browser controller is installed once per page from the primary client
 * graph; the pure modules (intent, budget, concurrency, anchor, policy) carry
 * every timing/decision rule and are unit tested under Node without a DOM.
 * Strategy: automate the official "Load earlier" control so upstream
 * `beginPaging()`/`preserve()` anchoring stays in charge (see `controller.ts`).
 */
export * as anchor from './anchor.ts'
export * as budget from './budget.ts'
export * as concurrency from './concurrency.ts'
export * as intent from './intent.ts'
export * as policy from './policy.ts'
export { planAnchorCorrection, readAnchor, findAnchor, firstAnchor } from './anchor.ts'
export type { AnchorReading, AnchorCorrection, AnchorCorrectionInput } from './anchor.ts'
export { EarlierLoadBudget, EARLIER_LOAD_BUDGET_DEFAULTS } from './budget.ts'
export type { EarlierLoadBudgetLimits, EarlierLoadBudgetSnapshot, EarlierLoadBudgetVerdict } from './budget.ts'
export { AggregateLoadGate, SessionPageLedger, AGGREGATE_LOAD_DEFAULTS } from './concurrency.ts'
export type { AggregateLoadLimits, AggregateLoadVerdict } from './concurrency.ts'
export { wheelIntent, touchIntent, scrollIntent, keyIntent, intentSample } from './intent.ts'
export type { ReaderIntent, ReaderInputSource, ReaderIntentSample } from './intent.ts'
export { EarlierLoadPolicy, isNearTop, nearTopPixels, NEAR_TOP_MAX_PIXELS } from './policy.ts'
export type { EarlierViewState, EarlierLoadDecision, EarlierLoadPolicyOptions } from './policy.ts'
export {
    installSeamlessHistory, findLoadEarlierControl,
    DEFAULT_MAX_AUTOMATIC_PAGES_PER_SESSION, SEAMLESS_ATTRIBUTE, SEAMLESS_EVENT_NAME,
} from './controller.ts'
export type { SeamlessHistoryEvent, SeamlessHistoryOptions } from './controller.ts'
export { bindInitialHistory, probeInitialWindow, InitialHistoryPlan, INITIAL_HISTORY_ATTRIBUTE, MAX_INITIAL_HISTORY_PAGES } from './initial.ts'
export type { InitialHistoryState, InitialWindowProbe } from './initial.ts'
