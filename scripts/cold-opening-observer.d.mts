export type ColdOpeningNavigationRequirement = boolean | 'auto'
export interface ColdOpeningOptions {
  paneSelector?: string
  expectedTitle?: string
  expectedText?: string
  staleText?: string
  /** Exact visible session-view id. Optional, but a mismatch is a failure. */
  expectedViewId?: string
  /** Exact body text of the older navigation target. */
  expectedNavigationText?: string
  /** Exact action: official rail older target or mobile return-latest. */
  navigationAction?: 'unvisited-target' | 'return-latest'
  stableMs?: number
  captureTitles?: boolean
  /** Require an official older-history page path (default true). */
  requiresHistory?: boolean
  /**
   * Require the desktop TurnNavigator rail. `auto` requires it when the visible
   * pane container is wider than 900 px and treats the official mobile layout
   * as history/read navigation instead (default `auto`).
   */
  requiresNavigation?: ColdOpeningNavigationRequirement
  /** Full product acceptance; default true. */
  fullCapabilities?: boolean
  /** Required post-sync observation window (default 30_000 ms). */
  observeAfterReadyMs?: number
  /** Diagnostic failure deadline (default 60_000 ms). */
  failureDeadlineMs?: number
  /** Retained checkpoints after the first full presentation (default [6000, 20000]). */
  checkpointsMs?: number[]
  /** Require trusted input and an actually retained unsent draft. */
  requireEditorInput?: boolean
  /** Require a real source live update during the observation window. */
  requireLiveUpdate?: boolean
  /** Require a trusted gesture/click that commits an older page. */
  requireHistoryAction?: boolean
  /** Require a trusted navigation intent that commits a target. */
  requireNavigationAction?: boolean
  /** Bounded body sampling interval; the default is 100 ms. */
  bodySampleMs?: number
  /** Bounded tail row count; the default is 96. */
  maxTailRows?: number
}

export interface ColdOpeningObservationCheckpoint {
  name: string
  at: number
  state: ColdOpeningState
}
export interface ColdOpeningObservation {
  startedAt: number
  firstFullAt: number | null
  completeAt: number | null
  complete: boolean
  deadlineAt: number
  deadlineMissed: boolean
  stoppedEarly: boolean
  lastSyncActivityAt: number | null
  lastBodyUpdateAt: number | null
  checkpoints: ColdOpeningObservationCheckpoint[]
}
export interface ColdOpeningInputEvidence {
  focusAt: number | null
  focusTrusted: boolean
  trustedKeys: number
  printableKeys: number
  firstPrintableAt: number | null
  trustedInputs: number
  textHash: number
  textLength: number
  textRevision: number
  everRetained: boolean
  retainedAt: number | null
  lostAt: number | null
  lastTextAt: number | null
  lastTrustedKeyAt: number | null
  replacedAt: number | null
}
export interface ColdOpeningReaderEvidence {
  intents: number
  lastAt: number | null
  lastKind: string | null
  wheel: number
  touch: number
  key: number
  pointer: number
}
export interface ColdOpeningHistoryEvidence {
  intents: number
  intentAt: number | null
  lastIntentAt: number | null
  nearTopIntents: number
  requestRevision: number
  requestAt: number | null
  observedRevision: number
  commitRevision: number
  commitAt: number | null
  domPrependRevision: number
  failureRevision: number
  failureAt: number | null
  networkRequests: number
  networkOlder: number
  lastNetworkAt: number | null
  hasMore: boolean
  controlDisabled: boolean | null
  anchorKeyHash: number | null
  anchorOffset: number | null
  anchorRetained: boolean | null
  anchorDriftPx: number | null
  anchorAt: number | null
}
export interface ColdOpeningNavigationEvidence {
  intents: number
  intentAt: number | null
  commitRevision: number
  commitAt: number | null
  clickedKind: 'load-jump' | 'jump' | 'to-bottom' | 'other' | null
  clickedIndex: number | null
  targetVisible: boolean | null
  beforeBodyRevision: number
  beforeScrollTop: number | null
  mode: 'rail' | 'mobile' | 'none' | null
  required: boolean
  marks: number
  usable: boolean
  action: 'unvisited-target' | 'return-latest'
  targetIntents: number
  returnLatestIntents: number
}
export interface ColdOpeningPartialExposure {
  editorUsable: boolean
  titleKind: string
  historyScrollable: boolean
  historyHasMore: boolean
  navigationUsable: boolean
  opening: boolean
  viewMatches: boolean
}
export interface ColdOpeningState {
  at: number
  reason?: string
  paneVisible: boolean
  titleKind: 'missing' | 'placeholder' | 'expected' | 'other'
  titleRevision: number
  documentTitleRevision: number
  viewRevision?: number
  viewMatches?: boolean
  bodyVisible: boolean
  bodyRevision: number
  bodyHash?: number
  visibleBodyCharacters: number
  bodyRowCount?: number
  bodyFirstKeyHash?: number
  bodyLastKeyHash?: number
  latestAttached: boolean | null
  latestVisible: boolean | null
  staleVisible: boolean | null
  editorVisible: boolean
  editorUsable: boolean
  editorFocused?: boolean
  editorRevision?: number
  editorTextLength?: number
  editorTextHash?: number
  editorTextRevision?: number
  visibleEditors?: number
  portRevision?: number
  historyScrollable?: boolean
  historyHasMore?: boolean
  historyControlDisabled?: boolean | null
  historyNavigable?: boolean
  historyIntentRevision?: number
  historyRequestRevision?: number
  historyCommitRevision?: number
  historyFailureRevision?: number
  historyIntentUncommitted?: boolean
  navigationRequired?: boolean
  navigationMode?: 'rail' | 'mobile' | 'none' | null
  navigationMarks?: number
  navigationUsable?: boolean
  navigationIntentRevision?: number
  navigationCommitRevision?: number
  navigationIntentUncommitted?: boolean
  readerIntentRevision?: number
  inputRevision?: number
  editorIdentityChanged?: boolean
  portIdentityChanged?: boolean
  viewIdentityChanged?: boolean
  bodyReplacement?: boolean
  firstBodyWrong?: boolean
  latestOffscreenUnprompted?: boolean
  staleReadyUnprompted?: boolean
  openingReappeared?: boolean
  editorIgnoredInput?: boolean
  draftLost?: boolean
  draftReplaced?: boolean
  liveUpdateRevision?: number
  capabilitiesMissing?: boolean
  partialExposure?: ColdOpeningPartialExposure
  opening: boolean
  ready: boolean
}
export interface ColdOpeningResult {
  first: Record<'workspace' | 'title' | 'body' | 'editor' | 'latest' | 'input' | 'live' | 'history' | 'navigation' | 'ready' | 'full' | 'stable' | 'partial', number | null>
  states: ColdOpeningState[]
  titles: Array<{ at: number; reason: string; kind: ColdOpeningState['titleKind']; revision: number; value?: string }>
  tasks: Array<{ at: number; ms: number }>
  current: (ColdOpeningState & { stableForMs: number }) | null
  startedAt: number
  stoppedAt: number | null
  verifiedFreshness: boolean
  verifiedTitle: boolean
  verifiedView: boolean
  verifiedTarget: boolean
  expectedViewSupplied: boolean
  expectedNavigationTextSupplied: boolean
  navigationAction: 'unvisited-target' | 'return-latest'
  stableMs: number
  requiresHistory: boolean
  requiresNavigation: ColdOpeningNavigationRequirement
  fullCapabilities: boolean
  requireEditorInput: boolean
  requireLiveUpdate: boolean
  requireHistoryAction: boolean
  requireNavigationAction: boolean
  observation: ColdOpeningObservation
  history: ColdOpeningHistoryEvidence
  navigation: ColdOpeningNavigationEvidence
  reader: ColdOpeningReaderEvidence
  input: ColdOpeningInputEvidence
  liveUpdateAt: number | null
}
declare global {
  interface Window {
    __hapiColdOpening: ColdOpeningResult & {
      checkpoint(name: string): ColdOpeningState | null
      stop(): void
    }
  }
}
export function installColdOpeningObserver(options?: ColdOpeningOptions): void
export function coldOpeningIssues(result: ColdOpeningResult): string[]
