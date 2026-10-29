/** Boundary fixtures only: slot registration, source RPCs, and the input owner.
 * Components, React lifecycle, stores and action ledgers are production code.
 * This input is NOT Lexical; native editing/layout belongs to release smoke. */
import { useSyncExternalStore, type ComponentType } from 'react'
import { vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { Context } from '@deepseek-ai/cordis'
import type { InputActions, InputState } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { NativeActionLedger } from '../../src/client/native-state.ts'
import type { NativeActionsApi } from '../../src/client/native-actions.tsx'
import { en, type WorkspaceTranslate } from '../../src/client/locales.ts'
import type { WorkspacePaneNavigation } from '../../src/client/pane-navigation.ts'

export const t: WorkspaceTranslate = key => en[key]
export function deferred<T>() {
  return Promise.withResolvers<T>()
}
export function nativeApi(): NativeActionsApi {
  return { ledger: new NativeActionLedger(), cancel: vi.fn(), steer: vi.fn(), retry: vi.fn(), answer: vi.fn(), resume: vi.fn(),
    queuedEditing: { busy: false, label: 'Edit queued message', edit: vi.fn() } }
}
export function pane(id: string) {
  const state = createSnapshotStore({ visible: true, focused: true })
  return { paneId: id, hostId: 'fixture-host', state,
    locate: vi.fn() } as unknown as WorkspacePaneNavigation & { state: typeof state; locate: ReturnType<typeof vi.fn> }
}
export function slots() {
  const components = new Map<string, ComponentType<PropsRuntime<'conversation.input.dock'>>>()
  const registry = {
    inject: (_name: string, register: () => () => void) => register(),
    register: (options: { id: string }, component: ComponentType<PropsRuntime<'conversation.input.dock'>>) => {
      components.set(options.id, component)
      return () => { components.delete(options.id) }
    },
  }
  return { registry, component(id: string) {
    const component = components.get(id)
    if (!component) throw new Error(`Slot was not registered: ${id}`)
    return component
  } }
}
export function input(initial = '') {
  const state = createSnapshotStore<InputState>({ draft: initial, draftRev: 0, occurrences: [], attachmentIds: [], phase: 'plain', queue: [] })
  const setDraft = (draft: string) => state.set({ ...state.getSnapshot(), draft, draftRev: state.getSnapshot().draftRev + 1 })
  const composer = { state, setDraft, notify: vi.fn(), focus: vi.fn(), insertReference: vi.fn(), beginCommand: vi.fn() }
  const actions = { submit: vi.fn(), persistDraft: vi.fn(), insertText: vi.fn() } as unknown as InputActions
  const useInput = <T,>(select: (state: InputState) => T): T => useSyncExternalStore(state.subscribe, () => select(state.getSnapshot()))
  const Editor = ({ label }: { label: string }) => <textarea aria-label={label} value={useInput(value => value.draft)} onChange={event => setDraft(event.currentTarget.value)}/>
  return { composer, actions, useInput, Editor }
}
export function context(value: Record<string, unknown>): Context {
  return { get: () => undefined, ...value } as unknown as Context
}
