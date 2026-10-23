import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { pluginRecordOf } from '@deepseek-ai/dsh-session'
import { hapiObservedProjectionSchema, type HapiObservedProjection } from './projection-types.js'

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    'plugin:hapi-dsh-observed/state': NonNullable<HapiObservedProjection>
    'plugin:hapi-dsh-observed/status': Omit<NonNullable<HapiObservedProjection>, 'notices'>
    'plugin:hapi-dsh-observed/notices': NonNullable<HapiObservedProjection>['notices']
    'plugin:hapi-dsh-observed/item': {
      sourceRowId: string; sourceLocalId: string | null; sourceSeq: number | null;
      key: string; scopeId: string | null; parentToolCallId: string | null; surfaceSeq: number;
    }
  }
}

const statusSchema = hapiObservedProjectionSchema.unwrap().omit({ notices: true })
const noticesSchema = hapiObservedProjectionSchema.unwrap().shape.notices

export const hapiObservedProjectionDefinition = {
  key: 'hapiObserved', stateVersion: 2, stateSchema: hapiObservedProjectionSchema, init: () => null,
  apply(state, event) {
    const value = pluginRecordOf(event)
    if (value?.type === 'plugin:hapi-dsh-observed/status') return {
      ...statusSchema.parse(value.data), notices: state?.notices ?? [],
    }
    if (value?.type === 'plugin:hapi-dsh-observed/notices' && state) return {
      ...state, notices: noticesSchema.parse(value.data),
    }
    return value?.type === 'plugin:hapi-dsh-observed/state' ? hapiObservedProjectionSchema.parse(value.data) : state
  },
  wire: { viewSchema: hapiObservedProjectionSchema, view: state => state },
} satisfies ProjectionDefinition<'hapiObserved'>
