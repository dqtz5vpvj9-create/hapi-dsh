/** Real sidebar/controller; only catalog transport and browser modal geometry are boundaries. */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, onTestFinished, test, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import type { ReactNode } from 'react'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { WorkspaceController, type WorkspaceOptions } from '../../src/client/controller.ts'
import { CatalogRefresh } from '../../src/client/catalog-refresh.ts'
import { catalogFailureText } from '../../src/client/error-policy.ts'
import { SessionSidebar } from '../../src/client/ui.tsx'
import { en, type WorkspaceTranslate } from '../../src/client/locales.ts'
import type { SessionSidebarProps } from '../../src/client/slots.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
    Tooltip: ({ children }: { children: ReactNode }) => children,
    CodeBlock: ({ code }: { code: string }) => <pre>{code}</pre>,
}))

function fixture(cached: boolean) {
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
    const id = 'cached' as SessionId
    const state: SessionListState = { ids: cached ? [id] : [], byId: cached ? { [id]: {
        id, displayTitle: 'Loaded conversation', running: false, blank: false, updatedAt: 1, retainedBy: {},
    } } : {}, phase: 'ready', projectionsBySession: {} }
    const controller = new WorkspaceController({ sessions: { list: { getSnapshot: () => state, subscribe: () => () => {} },
        refresh: async () => {} } as unknown as WorkspaceOptions['sessions'], navigation: {} as WorkspaceOptions['navigation'], storageKey: 'catalog-ui' })
    let failed = true
    const read = vi.fn(async () => { if (failed) throw new Error('transport failure for /api/hapi/catalog: HTTP 502'); return [] })
    const refresh = new CatalogRefresh({ read, accept: hosts => controller.setHostDiscovery(hosts),
        failed: error => controller.catalogDiscoveryFailed(catalogFailureText(error, 'en')) })
    const unrefresh = controller.installCatalogRefresh(refresh.refresh)
    onTestFinished(() => { unrefresh(); refresh.dispose(); controller.dispose() })
    const t: WorkspaceTranslate = key => en[key]
    const workspaces = { archivedSessionIds: [], pinnedSessionIds: [] }
    const props = { controller, wide: true, expandSidebar() {},
        useWorkspaces: (select: (value: typeof workspaces) => unknown) => select(workspaces), t } as unknown as SessionSidebarProps
    render(<SessionSidebar {...props}/> )
    return { controller, read, fail: () => refresh.refresh(), recover: () => { failed = false } }
}

test('an initial empty source list exposes its failure and the existing refresh action clears it', async () => {
    const f = fixture(false)
    await act(() => f.fail())
    expect(screen.getByText(/The source list could not update/)).toBeVisible()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/HTTP 502|\/api\/hapi\/catalog/)
    f.recover(); fireEvent.click(screen.getByRole('status').querySelector('button')!)
    await waitFor(() => expect(screen.queryByText(/The source list could not update/)).not.toBeInTheDocument())
    expect(f.read).toHaveBeenCalledTimes(2)
})

test('a cached list stays usable without adding a global fault notice', async () => {
    const f = fixture(true)
    await act(() => f.fail())
    expect(screen.getByText('Loaded conversation')).toBeInTheDocument()
    expect(screen.queryByText(/The source list could not update/)).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(f.controller.getSnapshot().catalogDiscovery.source).toBe('unavailable')
})
