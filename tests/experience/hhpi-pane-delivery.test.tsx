/** Production Pane, owner, outbox and delivery UI; only source RPC/storage are bounded fixtures. */
import { expect, test, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { SourceDeliveryStatus } from '../../src/client/remote-controls.tsx'
import { RemoteOutbox } from '../../src/client/remote-outbox.ts'
import { RemoteSourceHistory } from '../../src/client/remote-history.ts'
import { RemoteSourceSession as Owner } from '../../src/client/remote-sessions.ts'
import { RemotePaneSession as Pane } from '../../src/client/remote-reading-session.ts'
import type { SourcePage, SourceSession } from '../../src/remote/protocol.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type { HhpiRemoteApi } from '../../src/hhpi-api.ts'
import { memoryOperations } from '../fixtures/operation-transactions.ts'

// Load the pinned public event/lifecycle contract without installing the whole Client graph.
vi.mock('@deepseek-ai/dsh-api-session-controller/client', () => import('../fixtures/client-session-contract.ts'))
vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => (await import('../fixtures/native-task-primitives.tsx')).nativeTaskPrimitives)

test('a staged control can be continued from its Pane and still dispatches only the original request', async () => {
  const source: SourceSession = { id: 'hhpi:machine:source:codex:thread', machineId: 'machine', sourceId: 'source', engine: 'codex', nativeId: 'thread',
    title: 'Synthetic source', cwd: '/synthetic', updatedAt: 1, status: 'waiting', activeTurnId: 'turn',
    pendingRequests: [{ id: 'approval', method: 'item/commandExecution/requestApproval', turnId: 'turn', itemId: null, params: {} }],
    capabilities: { send: true, steer: true, cancel: true, approve: true, files: false } }
  const page: SourcePage = { session: source, epoch: 'epoch', version: 1, entries: [], before: null, after: null, hasBefore: false, hasAfter: false, context: [] }
  const calls: string[] = []
  const outbox = new RemoteOutbox(async request => {
    calls.push(request.requestId!)
    return { sessionId: request.sessionId, operationId: request.operationId, status: 'accepted', message: 'Accepted' }
  }, undefined, undefined, memoryOperations)
  outbox.setStorage({ storage: localStorage, scope: 'pane-approval' })
  outbox.enqueue({ sessionId: source.id, operationId: 'original', kind: 'approve', requestId: 'approval', decision: 'accept' })
  outbox.acceptCatalog([source])
  const history = new RemoteSourceHistory(source.id, { read: async () => page, async *changes() {} })
  const owner = new Owner(source.id as SessionId, source, history, {} as HhpiRemoteApi, outbox)
  const pane = new Pane(owner, Promise.resolve({} as SessionBinding), 'pane')
  try {
    await owner.ready
    render(<SourceDeliveryStatus session={pane} zh/>)
    expect(calls).toEqual([])
    await userEvent.click(screen.getByRole('button', { name: '继续原请求' }))
    await waitFor(() => expect(calls).toEqual(['approval']))
    expect(screen.queryByRole('button', { name: '继续原请求' })).not.toBeInTheDocument()
  } finally { pane.dispose(); owner.dispose(); history.dispose(); outbox.dispose() }
})
