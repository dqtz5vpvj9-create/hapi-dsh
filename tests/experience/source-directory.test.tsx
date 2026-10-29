import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { SourceDirectoryPicker } from '../../src/client/source-directory.tsx'
import type { CatalogMachine, HapiRemoteApi, SourceDirectory } from '../../src/client-api.ts'
import { deferred, t } from './fixtures.tsx'

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }))
const machine = (id: string) => ({ id, online: true, workspaceRoots: ['/work'] }) as CatalogMachine
const directory = (names: string[]): SourceDirectory => ({ entries: names.map(name => ({ name, type: 'directory', isSymbolicLink: false })) })
const tick = () => act(() => vi.advanceTimersByTimeAsync(200))
function fixture() {
  const read = vi.fn<HapiRemoteApi['sourceMachineDirectory']>(), choose = vi.fn()
  const api = { sourceMachineDirectory: read } as unknown as HapiRemoteApi
  const props = { api, machine: machine('alpha'), value: '/work', recent: [], disabled: false, onChoose: choose, t }
  return { read, choose, props }
}

test('typing a path coalesces reads and a late older response cannot replace the chosen folder', async () => {
  const f = fixture(), old = deferred<Awaited<ReturnType<HapiRemoteApi['sourceMachineDirectory']>>>()
  f.read.mockReturnValueOnce(old.promise).mockResolvedValueOnce({ ok: true, value: directory(['new-project']) })
  render(<SourceDirectoryPicker {...f.props}/> )
  fireEvent.click(screen.getByRole('button', { name: 'Browse directories' }))
  await tick()
  const path = screen.getByRole('textbox', { name: 'Browse path' })
  for (const value of ['', '/', '/n', '/ne', '/new']) fireEvent.change(path, { target: { value } })
  expect(f.read).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('button', { name: 'Use this folder' })).toBeDisabled()
  await tick()
  expect(f.read).toHaveBeenCalledTimes(2)
  await act(async () => old.resolve({ ok: true, value: directory(['obsolete-project']) }))
  expect(screen.queryByRole('button', { name: /obsolete-project/ })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: /new-project/ })).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'Use this folder' }))
  expect(f.choose).toHaveBeenCalledExactlyOnceWith('/new')
})

test('switching machines closes the picker and ignores the previous machine response', async () => {
  const f = fixture(), old = deferred<Awaited<ReturnType<HapiRemoteApi['sourceMachineDirectory']>>>()
  f.read.mockReturnValueOnce(old.promise).mockResolvedValueOnce({ ok: true, value: directory(['beta-project']) })
  const view = render(<SourceDirectoryPicker {...f.props}/> )
  fireEvent.click(screen.getByRole('button', { name: 'Browse directories' })); await tick()
  view.rerender(<SourceDirectoryPicker {...f.props} machine={machine('beta')}/> )
  expect(screen.queryByRole('textbox', { name: 'Browse path' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Browse directories' })); await tick()
  await act(async () => old.resolve({ ok: true, value: directory(['alpha-private-folder']) }))
  expect(screen.queryByText(/alpha-private-folder/)).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: /beta-project/ })).toBeVisible()
  expect(f.read.mock.calls[1]?.[0].machineId).toBe('beta')
})

test('read failure is visible, blocks selection, and an explicit refresh recovers', async () => {
  const f = fixture()
  f.read.mockRejectedValueOnce(new Error('Runner disconnected')).mockResolvedValueOnce({ ok: true, value: directory(['recovered']) })
  render(<SourceDirectoryPicker {...f.props}/> )
  fireEvent.click(screen.getByRole('button', { name: 'Browse directories' })); await tick()
  expect(screen.getByRole('alert')).toHaveTextContent('Runner disconnected')
  fireEvent.click(screen.getByRole('button', { name: 'Use this folder' }))
  expect(f.choose).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' })); await tick()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Use this folder' })).toBeEnabled()
})

test('unmount cancels the pending debounce instead of calling a retired machine', async () => {
  const f = fixture(), view = render(<SourceDirectoryPicker {...f.props}/> )
  fireEvent.click(screen.getByRole('button', { name: 'Browse directories' }))
  view.unmount(); await tick()
  expect(f.read).not.toHaveBeenCalled()
})
