import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { pluginRecordOf } from '@deepseek-ai/dsh-session'
import { hapiProjectionSchema, type HapiProjection } from './projection-types.js'
export type { HapiProjection, ApprovalView, DeliveryView, DeliveryState } from './projection-types.js'

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    'plugin:hapi-dsh/state': NonNullable<HapiProjection>
    'plugin:hapi-dsh/native-item': {
      key: string
      fingerprint: string
      surfaceSeq: number | null
      displayTurn: number
      displayStep: number
      nativeTurnId: string | null
      nativeItemId: string | null
    }
  }
}

export const hapiProjectionDefinition = {
  key: 'hapi',
  stateVersion: 1,
  stateSchema: hapiProjectionSchema,
  init: () => null,
  apply(state, event) {
    const record = pluginRecordOf(event)
    return record?.type === 'plugin:hapi-dsh/state'
      ? hapiProjectionSchema.parse(record.data)
      : state
  },
  wire: {
    viewSchema: hapiProjectionSchema,
    view: state => state,
  },
} satisfies ProjectionDefinition<'hapi'>
