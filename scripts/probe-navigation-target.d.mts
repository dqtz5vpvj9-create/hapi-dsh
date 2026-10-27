export interface SourceNavigationTarget { turn: number; messageId: string }
export function selectSourceNavigationTarget(outline: unknown): SourceNavigationTarget
export function sourceNavigationText(records: unknown[], target: SourceNavigationTarget): string
export interface SourceLatestTarget {
  messageId: string
  at: number
  seq: number
  eventType: 'user/message' | 'assistant/message'
  text: string
}
export function sourceLatestTarget(records: unknown[], head: unknown): SourceLatestTarget
export function sourceLatestText(records: unknown[], head: unknown): string
export type SourceOpeningMarker = { kind: 'text'; text: string } | { kind: 'tool-result'; callId: string }
export interface SourceOpeningTarget {
  messageId: string
  at: number
  seq: number
  eventType: string
  sourceHead: { messageId: string; at: number; seq: number }
  targetAtHead: boolean
  marker: SourceOpeningMarker
}
export function sourceOpeningTarget(records: unknown[], head: unknown): SourceOpeningTarget
