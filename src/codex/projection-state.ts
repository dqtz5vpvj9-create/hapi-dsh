import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { pluginRecordOf } from '@deepseek-ai/dsh-session'
import { hapiProjectionSchema, type HapiProjection } from './projection-types.js'
export type { HapiProjection, ApprovalView, DeliveryView, DeliveryState } from './projection-types.js'

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    'plugin:hapi-dsh/state': NonNullable<HapiProjection>
    'plugin:hapi-dsh/status': Omit<NonNullable<HapiProjection>, 'notices'>
    'plugin:hapi-dsh/notices': NonNullable<HapiProjection>['notices']
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

const statusSchema = hapiProjectionSchema.unwrap().omit({ notices: true })
const noticesSchema = hapiProjectionSchema.unwrap().shape.notices

export const hapiProjectionDefinition = {
  key: 'hapi',
  stateVersion: 2,
  stateSchema: hapiProjectionSchema,
  init: () => null,
  apply(state, event) {
    const record = pluginRecordOf(event)
    if (record?.type === 'plugin:hapi-dsh/status') return {
      ...statusSchema.parse(record.data), notices: state?.notices ?? [],
    }
    if (record?.type === 'plugin:hapi-dsh/notices' && state) return {
      ...state, notices: noticesSchema.parse(record.data),
    }
    return record?.type === 'plugin:hapi-dsh/state'
      ? hapiProjectionSchema.parse(record.data)
      : state
  },
  wire: {
    viewSchema: hapiProjectionSchema,
    view: state => state,
  },
} satisfies ProjectionDefinition<'hapi'>
