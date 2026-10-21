import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { pluginRecordOf } from '@deepseek-ai/dsh-session'
import { hapiObservedProjectionSchema, type HapiObservedProjection } from './projection-types.js'

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    'plugin:hapi-dsh-observed/state': NonNullable<HapiObservedProjection>
    'plugin:hapi-dsh-observed/item': {
      sourceRowId: string; sourceLocalId: string | null; sourceSeq: number | null;
      key: string; scopeId: string | null; parentToolCallId: string | null; surfaceSeq: number;
    }
  }
}

export const hapiObservedProjectionDefinition = {
  key: 'hapiObserved', stateVersion: 1, stateSchema: hapiObservedProjectionSchema, init: () => null,
  apply(state, event) {
    const value = pluginRecordOf(event)
    return value?.type === 'plugin:hapi-dsh-observed/state' ? hapiObservedProjectionSchema.parse(value.data) : state
  },
  wire: { viewSchema: hapiObservedProjectionSchema, view: state => state },
} satisfies ProjectionDefinition<'hapiObserved'>
