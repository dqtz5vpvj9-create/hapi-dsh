/** Real menu and application generation; only authenticated RPC and clipboard are fixtures. */
import { act, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { SourceResumeMenu } from '../../src/client/source-resume-menu.tsx'
import { sourceResumeIdentity } from '../../src/client/source-resume-command.ts'
import { WorkspaceApplicationIdentity } from '../../src/client/application-identity.ts'
import { sourceSessionId, type SourceSession } from '../../src/remote/protocol.ts'
import type { SourceResumeContext } from '../../src/workspace/source-navigation-api.ts'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'

const identity = { machineId: 'original-machine', sourceId: 'original-source', engine: 'codex' as const, nativeId: '11111111-1111-4111-8111-111111111111' }
const source: SourceSession = { ...identity, id: sourceSessionId(identity), title: '', cwd: '/source/project', updatedAt: 1, status: 'idle', activeTurnId: null,
    capabilities: { send: true, steer: false, cancel: true, approve: false, files: false }, pendingRequests: [] }
const context: SourceResumeContext = { ...identity, sessionId: source.id, cwd: source.cwd, codexHome: '/source/original-store', platformOs: 'linux', platformFamily: 'unix' }
function account() { const application = new WorkspaceApplicationIdentity(); application.set({ accountId: 'account-a', origin: 'https://app.invalid' }, 'device'); return application }

test('an actual source row copies its Host-verified store and never submits a session operation', async () => {
    const application = account(), copy = vi.fn(async () => {}), resumeContext = vi.fn(async (_request: { sessionId: string }, _signal?: AbortSignal) => ({ ok: true as const, value: context }))
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } })
    const host = { id: 'paired-host', resumeContext }, target = { hostId: host.id, sessionId: source.id }
    render(<SourceResumeMenu identity={sourceResumeIdentity({ cwd: source.cwd, projectionValues: { hhpiSource: source } })} target={target} host={host} application={application}/>)
    const button = screen.getByRole('menuitem', { name: 'Copy resume command' })
    await waitFor(() => expect(button).toBeEnabled())
    await userEvent.click(button)
    expect(copy).toHaveBeenCalledWith(`cd '/source/project' && env CODEX_HOME='/source/original-store' codex resume '${identity.nativeId}'`)
    expect(resumeContext.mock.calls).toHaveLength(1)
    expect(resumeContext.mock.calls[0]?.[0]).toEqual({ sessionId: source.id })
    application.dispose()
})

test('Host, session and account replacement reject late stores and missing or foreign context stays disabled', async () => {
    const application = account(), gates: Array<ReturnType<typeof Promise.withResolvers<RemoteResult<SourceResumeContext>>>> = [], signals: AbortSignal[] = []
    const resumeContext = vi.fn((_request: { sessionId: string }, signal?: AbortSignal) => { signals.push(signal!); const gate = Promise.withResolvers<RemoteResult<SourceResumeContext>>(); gates.push(gate); return gate.promise })
    const row = sourceResumeIdentity({ cwd: source.cwd, projectionValues: { hhpiSource: source } }), host = { id: 'host-a', resumeContext }
    const view = render(<SourceResumeMenu identity={row} target={{ hostId: host.id, sessionId: source.id }} host={host} application={application}/>)
    const button = screen.getByRole('menuitem')
    const replacement = { id: 'host-b', resumeContext }
    view.rerender(<SourceResumeMenu identity={row} target={{ hostId: replacement.id, sessionId: source.id }} host={replacement} application={application}/>)
    expect(signals[0]?.aborted).toBe(true)
    await act(async () => { gates[0]!.resolve({ ok: true, value: context }); await Promise.resolve() })
    expect(button).toBeDisabled()
    act(() => application.set({ accountId: 'account-b', origin: 'https://app.invalid' }, 'device'))
    expect(signals[1]?.aborted).toBe(true)
    await act(async () => { gates[1]!.resolve({ ok: true, value: context }); await Promise.resolve() })
    expect(button).toBeDisabled()
    const other = { ...identity, nativeId: '22222222-2222-4222-8222-222222222222' }, otherId = sourceSessionId(other)
    view.rerender(<SourceResumeMenu identity={{ ...row!, nativeId: other.nativeId }} target={{ hostId: replacement.id, sessionId: otherId }} host={replacement} application={application}/>)
    expect(signals[2]?.aborted).toBe(true)
    await act(async () => { gates[2]!.resolve({ ok: true, value: context }); gates[3]!.resolve({ ok: true, value: context }); await Promise.resolve() })
    expect(button).toBeDisabled()
    view.unmount(); expect(signals[3]?.aborted).toBe(true); application.dispose()
})
