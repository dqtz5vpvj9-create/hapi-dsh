import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { pluginRecordOf } from '@deepseek-ai/dsh-session'
import { hapiProjectionSchema, hapiProjectionViewSchema, type HapiProjection, type HapiProjectionState } from './projection-types.js'
export type { HapiProjection, ApprovalView, DeliveryView, DeliveryState } from './projection-types.js'

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    'plugin:hapi-dsh/state': NonNullable<HapiProjectionState>
    'plugin:hapi-dsh/status': Omit<NonNullable<HapiProjectionState>, 'notices'>
    'plugin:hapi-dsh/session-state': Omit<NonNullable<HapiProjectionState>, 'notices' | 'execution'>
    'plugin:hapi-dsh/execution': NonNullable<HapiProjectionState>['execution']
    'plugin:hapi-dsh/notices': NonNullable<HapiProjectionState>['notices']
    'plugin:hapi-dsh/native-item': {
      key: string
      fingerprint: string
      surfaceSeq: number | null
      sourceMessageId?: string
      sourceAt?: number
      sourceSeq?: number
      displayTurn: number
      displayStep: number
      nativeTurnId: string | null
      nativeItemId: string | null
      /** Stable source step identity shared by detached pages and live records. */
      nativeStepId?: string
    }
  }
}

const statusSchema = hapiProjectionSchema.unwrap().omit({ notices: true })
const sessionStateSchema = statusSchema.omit({ execution: true })
const noticesSchema = hapiProjectionSchema.unwrap().shape.notices
const executionSchema = hapiProjectionSchema.unwrap().shape.execution
const views = new WeakMap<NonNullable<HapiProjectionState>, NonNullable<HapiProjection>>()
function executionView(value: NonNullable<HapiProjectionState>['execution']): NonNullable<HapiProjection>['execution'] {
  if (!value) return null
  const { sequence: _sequence, ...execution } = value
  return execution
}

/** Memoized pure derivation, keyed by immutable Host state rather than a
 * process-wide session-id inventory. No source fields or log events change. */
export function hapiProjectionView(state: HapiProjectionState): HapiProjection {
  if (!state) return null
  const cached = views.get(state)
  if (cached) return cached
  const value = { ...state, execution: executionView(state.execution) }
  views.set(state, value)
  return value
}

export const hapiProjectionDefinition = {
  key: 'hapi',
  stateVersion: 3,
  stateSchema: hapiProjectionSchema,
  init: () => null,
  apply(state, event) {
    const record = pluginRecordOf(event)
    if (record?.type === 'plugin:hapi-dsh/status') return {
      ...statusSchema.parse(record.data), notices: state?.notices ?? [],
    }
    if (record?.type === 'plugin:hapi-dsh/session-state' && state) return {
      ...sessionStateSchema.parse(record.data), notices: state.notices, execution: state.execution,
    }
    if (record?.type === 'plugin:hapi-dsh/execution' && state) {
      const execution = executionSchema.parse(record.data), next = { ...state, execution }
      if (JSON.stringify(executionView(state.execution)) === JSON.stringify(executionView(execution))) {
        // The source watermark advances, but the entire client-visible value
        // is unchanged. Reuse its reference for the official Object.is gate.
        views.set(next, hapiProjectionView(state)!)
      }
      return next
    }
    if (record?.type === 'plugin:hapi-dsh/notices' && state) return {
      ...state, notices: noticesSchema.parse(record.data),
    }
    return record?.type === 'plugin:hapi-dsh/state'
      ? hapiProjectionSchema.parse(record.data)
      : state
  },
  wire: {
    viewSchema: hapiProjectionViewSchema,
    view: hapiProjectionView,
  },
} satisfies ProjectionDefinition<'hapi'>
