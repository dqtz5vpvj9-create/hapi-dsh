/** Browser-safe facts for the original HAPI SessionTerminal compatibility provider. */
import { z } from 'zod'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { WebTerminalId, WebTerminalInfo } from '@deepseek-ai/dsh-api-terminal-controller/types'
import { terminalOutputCursorSchema, workbenchSourceSchema } from './workbench-types.ts'

const identity = z.string().min(1).max(512).refine(value => !/[\u0000-\u001f\u007f]/u.test(value), 'Invalid terminal identity')
export const LEGACY_TERMINAL_ID_PREFIX = 'hapi-legacy-'
/** Recognize the reserved namespace even when an ID is malformed or no longer registered. */
export function isLegacyTerminalId(value: string): boolean { return value.startsWith(LEGACY_TERMINAL_ID_PREFIX) }
export const legacyTerminalIdSchema = z.string().regex(/^hapi-legacy-[a-f0-9]{40}$/u).transform(value => value as WebTerminalId)
const dimension = z.number().int().min(1).max(1000)
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

/** Empty path/argv/cwd are explicit unreported sentinels, never launch candidates. */
export const legacyTerminalInfoSchema = z.strictObject({
  id: legacyTerminalIdSchema, title: z.string().min(1).max(120),
  shell: z.strictObject({ path: z.literal(''), args: z.array(z.string()).length(0), name: z.literal('Shell not reported by legacy source') }),
  cwd: z.literal(''), cols: dimension, rows: dimension,
  state: z.enum(['running', 'exited', 'failed']), exitCode: z.number().int().nullable(), error: z.string().max(8192).optional(),
}).transform(({ error, ...info }): WebTerminalInfo => ({ ...info, ...(error === undefined ? {} : { error }) }))
export const legacyTerminalEnvironmentSchema = z.strictObject({
  /** Current logged session directory, not the existing PTY's unknown initial cwd. */
  cwd: z.string().max(8192), maxInputBytes: z.number().int().positive(), maxBufferedBytes: z.number().int().positive(),
  maxCols: dimension, maxRows: dimension, scrollback: z.number().int().nonnegative(),
})
export const legacyTerminalStateSchema = z.strictObject({
  id: legacyTerminalIdSchema,
  sessionId: identity,
  terminalId: identity,
  source: z.strictObject({ sourceHubId: identity, sourceSessionId: identity, machineId: identity }),
  phase: z.enum(['opening', 'replaying', 'ready', 'disconnected', 'failed', 'exited']),
  environment: legacyTerminalEnvironmentSchema.nullable(),
  info: legacyTerminalInfoSchema.nullable(),
  facts: z.strictObject({
    title: z.literal('adapter-display-alias'),
    shell: z.strictObject({ kind: z.literal('unreported') }),
    initialCwd: z.strictObject({ kind: z.literal('unreported') }),
    dimensions: z.strictObject({ cols: dimension, rows: dimension, basis: z.enum(['source-open-ready', 'adapter-resize-admission']) }).nullable(),
    lastSourceReadyAt: timestamp.nullable(),
    exitSignal: z.string().max(256).nullable(),
  }),
  replay: z.strictObject({
    cursor: terminalOutputCursorSchema.nullable(),
    issue: z.enum(['truncated', 'history-truncated', 'epoch-changed', 'cursor-ahead', 'invalid-stream', 'legacy-stream']).nullable(),
    sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }),
  compatibility: z.strictObject({
    open: z.literal('attach-or-create'), inputAcknowledgement: z.literal('adapter-transport'),
    replay: z.literal('bounded-source-tail'), retention: z.literal('source-idle-policy'), close: z.literal('detach-only'),
  }),
  delivery: z.strictObject({ adapterAccepted: z.number().int().nonnegative(), lastAcceptedAt: timestamp.nullable(), uncertain: z.boolean() }),
  error: z.string().max(8192).nullable(),
})
export type LegacyTerminalState = z.infer<typeof legacyTerminalStateSchema>

export const legacyTerminalInputs = {
  sourceLegacyTerminalOpen: z.strictObject({ sessionId: identity, source: workbenchSourceSchema, terminalId: identity, cols: dimension, rows: dimension }),
  sourceLegacyTerminalRead: z.strictObject({ sessionId: identity, id: identity }),
  sourceLegacyTerminals: z.strictObject({ sessionId: identity }),
}
export const legacyTerminalOutputs = {
  sourceLegacyTerminalOpen: legacyTerminalStateSchema,
  sourceLegacyTerminalRead: legacyTerminalStateSchema.nullable(),
  sourceLegacyTerminals: z.array(legacyTerminalStateSchema),
}
export type LegacyTerminalOpenRequest = z.infer<typeof legacyTerminalInputs.sourceLegacyTerminalOpen>
export type LegacyTerminalReadRequest = z.infer<typeof legacyTerminalInputs.sourceLegacyTerminalRead>
export type LegacyTerminalListRequest = z.infer<typeof legacyTerminalInputs.sourceLegacyTerminals>
export interface LegacyTerminalApi {
  sourceLegacyTerminalOpen(request: LegacyTerminalOpenRequest, signal?: AbortSignal): Promise<RemoteResult<LegacyTerminalState>>
  sourceLegacyTerminalRead(request: LegacyTerminalReadRequest): Promise<RemoteResult<LegacyTerminalState | null>>
  sourceLegacyTerminals(request: LegacyTerminalListRequest): Promise<RemoteResult<LegacyTerminalState[]>>
}
