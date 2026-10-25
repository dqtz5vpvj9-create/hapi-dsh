export interface ColdOpeningOptions {
  paneSelector?: string
  expectedTitle?: string
  expectedText?: string
  staleText?: string
  stableMs?: number
  captureTitles?: boolean
}
export interface ColdOpeningState {
  at: number
  reason?: string
  paneVisible: boolean
  titleKind: 'missing' | 'placeholder' | 'expected' | 'other'
  titleRevision: number
  documentTitleRevision: number
  bodyVisible: boolean
  bodyRevision: number
  visibleBodyCharacters: number
  latestAttached: boolean | null
  latestVisible: boolean | null
  staleVisible: boolean | null
  editorVisible: boolean
  editorUsable: boolean
  opening: boolean
  ready: boolean
}
export interface ColdOpeningResult {
  first: Record<'workspace' | 'title' | 'body' | 'editor' | 'latest' | 'ready' | 'stable', number | null>
  states: ColdOpeningState[]
  titles: Array<{ at: number; reason: string; kind: ColdOpeningState['titleKind']; revision: number; value?: string }>
  tasks: Array<{ at: number; ms: number }>
  current: (ColdOpeningState & { stableForMs: number }) | null
  startedAt: number
  stoppedAt: number | null
  verifiedFreshness: boolean
  verifiedTitle: boolean
  stableMs: number
}
declare global {
  interface Window {
    __hapiColdOpening: ColdOpeningResult & {
      checkpoint(name: string): ColdOpeningState
      stop(): void
    }
  }
}
export function installColdOpeningObserver(options?: ColdOpeningOptions): void
export function coldOpeningIssues(result: ColdOpeningResult): string[]
