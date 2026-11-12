/** Production MCP form; only the native response transport is a fixture. */
import { fireEvent, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import type { SourceApproval } from '../../src/remote/protocol.ts'
import { NativeElicitation } from '../../src/client/remote-elicitation.tsx'
const request: SourceApproval = { id: 'exact-mcp-request', method: 'mcpServer/elicitation/request', turnId: 'turn', itemId: null, params: {} }
test('native MCP numeric, boolean and multi-select answers retain their types and required option count', async () => {
  const submit = vi.fn(async (_value: Record<string, unknown>) => {}), user = userEvent.setup()
  render(<NativeElicitation request={{ ...request, params: { mode: 'form', serverName: 'source-mcp', message: 'Choose the requested settings', requestedSchema: { type: 'object', required: ['count', 'pick'], properties: {
    count: { type: 'integer', title: 'Count', minimum: 1 }, enabled: { type: 'boolean', title: 'Enabled' }, pick: { type: 'array', title: 'Choices', minItems: 2, items: { type: 'string', enum: ['a', 'b'] } },
  } } } }} disabled={false} zh={false} submit={submit}/> )
  await user.type(screen.getByRole('spinbutton', { name: 'Count' }), '3')
  await user.click(screen.getByRole('checkbox', { name: 'Enabled' }))
  await user.selectOptions(screen.getByRole('listbox', { name: 'Choices' }), ['a'])
  await user.click(screen.getByRole('button', { name: 'Confirm' }))
  expect(screen.getByRole('alert')).toHaveTextContent('number of options')
  expect(submit).not.toHaveBeenCalled()
  await user.selectOptions(screen.getByRole('listbox', { name: 'Choices' }), ['a', 'b'])
  await user.click(screen.getByRole('button', { name: 'Confirm' }))
  expect(submit).toHaveBeenCalledWith({ action: 'accept', content: { count: 3, enabled: true, pick: ['a', 'b'] } })
})
test.each(['openai/userVerification', 'form'])('unsupported device or nested schema %s cannot accept even through a direct form submit', mode => {
  const submit = vi.fn(async (_value: Record<string, unknown>) => {})
  const view = render(<NativeElicitation request={{ ...request, params: { mode, title: 'Trusted check', description: 'Device proof needed', challenge: 'synthetic-challenge', requestedSchema: { type: 'object', properties: { nested: { type: 'object', properties: {} } } } } }} disabled={false} zh={false} submit={submit}/> )
  expect(screen.getByRole('button', { name: 'Confirm' })).toBeDisabled()
  fireEvent.submit(view.container.querySelector('form')!)
  expect(submit).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Decline' }))
  expect(submit).toHaveBeenCalledWith({ action: 'decline' })
})
