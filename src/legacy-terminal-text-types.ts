/** Read-only text from the existing legacy adapter screen; never a source PTY query. */
import { z } from 'zod'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { legacyTerminalInputs, legacyTerminalStateSchema, type LegacyTerminalReadRequest } from './legacy-terminal-types.ts'

export const MAX_LEGACY_TERMINAL_TEXT_BYTES = 8 * 1024 * 1024
export const MAX_LEGACY_TERMINAL_TEXT_ROWS = 11_000

export const legacyTerminalTextSnapshotSchema = z.strictObject({
    id: legacyTerminalStateSchema.shape.id,
    sessionId: legacyTerminalStateSchema.shape.sessionId,
    terminalId: legacyTerminalStateSchema.shape.terminalId,
    source: legacyTerminalStateSchema.shape.source,
    provenance: z.literal('adapter-observed'),
    replay: z.literal('bounded-source-tail'),
    replayIssue: legacyTerminalStateSchema.shape.replay.shape.issue,
    sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    capturedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    lines: z.array(z.string().max(MAX_LEGACY_TERMINAL_TEXT_BYTES)).max(MAX_LEGACY_TERMINAL_TEXT_ROWS),
    localLimitReached: z.boolean(),
})
export type LegacyTerminalTextSnapshot = z.infer<typeof legacyTerminalTextSnapshotSchema>
export const legacyTerminalTextInputs = { sourceLegacyTerminalText: legacyTerminalInputs.sourceLegacyTerminalRead }
export const legacyTerminalTextOutputs = { sourceLegacyTerminalText: legacyTerminalTextSnapshotSchema }
export interface LegacyTerminalTextApi {
    sourceLegacyTerminalText(request: LegacyTerminalReadRequest, signal?: AbortSignal): Promise<RemoteResult<LegacyTerminalTextSnapshot>>
}
