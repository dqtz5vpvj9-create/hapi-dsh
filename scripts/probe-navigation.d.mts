import type { Locator, Page } from 'playwright'
export interface NavigationActionEvidence {
  attempted: boolean
  kind: string | null
  committed: boolean
  targetVisible: boolean | null
  failure: string | null
}
export function textInConversationViewport(pane: Locator, text: string): Promise<boolean>
export function exerciseOpeningUnvisitedTarget(page: Page, pane: Locator, expectedText: string, targetTurn: number): Promise<NavigationActionEvidence>
