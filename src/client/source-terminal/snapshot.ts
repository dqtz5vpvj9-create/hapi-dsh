/** A copy accessory reads source history without attaching another input owner. */
import { remoteValue, type HapiRemoteApi } from '../../client-api.ts'
import type { WorkbenchResponse } from '../../workbench-types.ts'
import { sourcePathAddress } from '../source-path-actions.tsx'

export type TerminalSnapshotApi = Pick<HapiRemoteApi, 'nativeTerminalText'>
export type TerminalTextSnapshot = { kind: 'selected' | 'visible'; lines: string[] }
  | { kind: 'source'; value: WorkbenchResponse<'nativeTerminalText'>; lines: string[] }

export async function readTerminalCopySnapshot(api: TerminalSnapshotApi | undefined, projection: unknown,
  sidechain: boolean, terminalId: string, local: { text: string; selected: boolean }, signal: AbortSignal): Promise<TerminalTextSnapshot> {
  signal.throwIfAborted()
  if (local.selected) return { kind: 'selected', lines: local.text.split('\n') }
  if (projection === undefined || projection === null) return { kind: 'visible', lines: local.text.split('\n') }
  const source = sourcePathAddress(projection)
  if (!source || sidechain || !api) throw new Error('The original source terminal cannot be read from this view')
  const value = remoteValue(await api.nativeTerminalText({ source, terminalId }, signal))
  signal.throwIfAborted()
  if (value.terminalId !== terminalId) throw new Error('The source returned a different terminal snapshot')
  return { kind: 'source', value, lines: value.lines }
}
