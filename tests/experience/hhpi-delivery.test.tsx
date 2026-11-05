/** Real delivery dock and durable outbox; the source operation boundary is controlled. */
import { afterEach, expect, test } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import { SourceDeliveryStatus } from '../../src/client/remote-controls.tsx'
import { memoryOperations } from '../fixtures/operation-transactions.ts'
import { RemoteOutbox } from '../../src/client/remote-outbox.ts'
import type { SourceReceipt, SourceSession } from '../../src/remote/protocol.ts'

afterEach(cleanup)
const metadata: SourceSession = { id: 'hhpi:machine:source:codex:thread', machineId: 'machine', sourceId: 'source', engine: 'codex', nativeId: 'thread', title: 'Synthetic source',
  cwd: '/synthetic', updatedAt: 1, status: 'idle', activeTurnId: null, pendingRequests: [], capabilities: { send: true, steer: false, cancel: false, approve: false, files: false } }

test('delivery feedback stays through an accepted ACK and leaves only when the source user message appears', async () => {
  const receipt = Promise.withResolvers<SourceReceipt>(), operation = { sessionId: metadata.id, operationId: 'receipt-wait', kind: 'send' as const, text: 'Synthetic saved text' }
  const outbox = new RemoteOutbox(() => receipt.promise, undefined, undefined, memoryOperations)
  outbox.setStorage({ storage: localStorage, scope: 'dock-ack' })
  try {
    render(<SourceDeliveryStatus session={{ deliveries: outbox.view(metadata.id), discardSubmission: id => outbox.discard(id) }} zh/>)
    outbox.enqueue(operation); outbox.start(operation.operationId)
    expect(await screen.findByText('已保存在本机，等待连接后发送')).toBeVisible()
    outbox.acceptCatalog([metadata])
    expect(await screen.findByText('正在发送已保存的消息')).toBeVisible()
    receipt.resolve({ ...operation, status: 'accepted', message: 'Synthetic native acceptance' })
    expect(await screen.findByText('源端已接收，等待正文同步')).toBeVisible()
    outbox.observe(metadata.id, [{ type: 'event', event: { type: 'user/message', seq: SessionSeq(1), time: 1, surfaceOp: 'append',
      data: { id: MessageId('synthetic-message'), role: 'user', content: [{ type: 'text', text: operation.text }], source: { kind: 'user', rpcId: operation.operationId as SessionRequestId } } } }])
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument())
  } finally { outbox.dispose() }
})

test('a refused saved message explains its outcome and can be explicitly dismissed without another send', async () => {
  let calls = 0
  const operation = { sessionId: metadata.id, operationId: 'denied-dock', kind: 'send' as const, text: 'Synthetic denied text' }
  const outbox = new RemoteOutbox(async request => { calls++; return { sessionId: request.sessionId, operationId: request.operationId, status: 'rejected', message: 'Synthetic permission refused' } }, undefined, undefined, memoryOperations)
  outbox.setStorage({ storage: localStorage, scope: 'dock-denied' })
  try {
    render(<SourceDeliveryStatus session={{ deliveries: outbox.view(metadata.id), discardSubmission: id => outbox.discard(id) }} zh/>)
    outbox.enqueue(operation); outbox.start(operation.operationId); outbox.acceptCatalog([metadata])
    expect(await screen.findByRole('alert')).toHaveTextContent('Synthetic permission refused')
    await userEvent.click(screen.getByRole('button', { name: '移除' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument(); expect(calls).toBe(1)
  } finally { outbox.dispose() }
})

test('owner handoff keeps the original text viewable and does not claim native execution completed', async () => {
  const operation = { sessionId: metadata.id, operationId: 'owner-receipt', kind: 'send' as const, text: '原执行端保存的完整消息' }
  const outbox = new RemoteOutbox(async request => ({ sessionId: request.sessionId, operationId: request.operationId, status: 'accepted',
    message: 'Saved by original owner', ownerAdmission: { localId: request.operationId, state: 'consumed' } }), undefined, undefined, memoryOperations)
  outbox.setStorage({ storage: localStorage, scope: 'dock-owner' })
  try {
    render(<SourceDeliveryStatus session={{ deliveries: outbox.view(metadata.id), discardSubmission: id => outbox.discard(id) }} zh/>)
    outbox.enqueue(operation); outbox.start(operation.operationId); outbox.acceptCatalog([metadata])
    const summary = await screen.findByText('原执行端已保存 · 查看原文')
    await userEvent.click(summary)
    expect(screen.getByText(operation.text)).toBeVisible()
    expect(screen.getByRole('status')).toHaveTextContent('执行结果见会话正文')
    expect(screen.queryByText('源端已接收，等待正文同步')).not.toBeInTheDocument()
  } finally { outbox.dispose() }
})
