/** Actual SourceControls/CompactComposerTools. Official dock markup/counter content is an explicit DOM seat. */
import { fireEvent, render, screen, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { SourceControls, type InputProps } from '../../src/client/composer-picker/index.tsx'
import { composerPickerStyles } from '../../src/client/composer-picker/styles.ts'

test('HHPI activity leaves the persistent footer, remains in More details, and ordinary DSH stays unchanged', () => {
    const ctx = { get: () => undefined, locale: { subscribe: () => () => {}, getSnapshot: () => ({ active: 'en' }) },
        sessions: { binding: () => { throw new Error('These controls must keep their own public binding') } } } as unknown as Context
    const input = { phase: 'plain', draft: '', attachmentIds: [] }, session = { running: false }
    const controls = (sessionId: string) => {
        const props = { sessionId, sessionBinding: { session: { metadata: { getSnapshot: () => ({ capabilities: { steer: false } }) } } },
            useInput: (select: (value: typeof input) => unknown) => select(input), useSession: (select: (value: typeof session) => unknown) => select(session), inputActions: {},
            renderSlot: (name: string) => name === 'hapi.source.composer-details' ? <span data-composer-stat="activity">1 turns 23 steps</span> : null,
        } as unknown as InputProps
        return <SourceControls ctx={ctx} props={props} initial={{ model: null, effort: null, permission: null, serviceTier: null }}
            permissionCapable={false} data={null} loading={false} busy={false} pending={null} error={null} sourceLocked={false}
            refresh={async () => {}} apply={async () => false}/>
    }
    const view = render(<><style>{composerPickerStyles}</style><section data-testid="source">
        <div data-composer-card>{controls('hhpi:machine:source:codex:original')}</div>
        <div data-composer-dock><span data-composer-stat="activity">1 turns 23 steps</span><span data-composer-stat="usage">123 tok</span></div>
    </section><section data-testid="ordinary"><div data-composer-card/>
        <div data-composer-dock><span data-composer-stat="activity">4 turns 7 steps</span></div></section></>)
    const source = screen.getByTestId('source'), ordinary = screen.getByTestId('ordinary')
    const footer = source.querySelector('[data-composer-dock]')!
    for (const stat of footer.querySelectorAll('[data-composer-stat]')) expect(getComputedStyle(stat).display).toBe('none')
    expect(getComputedStyle(ordinary.querySelector('[data-composer-stat]')!).display).not.toBe('none')
    fireEvent.click(within(source).getByRole('button', { name: 'More input controls' }))
    const details = screen.getByRole('dialog', { name: 'More input controls' })
    expect(within(details).getByText('1 turns 23 steps')).toBeVisible()
    expect(getComputedStyle(details.querySelector('[data-composer-stat]')!).display).not.toBe('none')
    view.unmount()
})

test('More expands the original card and retains its draft when the toolbar expansion seat is hidden', () => {
    const focus = vi.fn(() => screen.getByRole('textbox').focus())
    const session = { metadata: { getSnapshot: () => ({ capabilities: { steer: false } }) } }, binding = { session, ctx: {} }
    const ctx = { get: () => undefined, locale: { subscribe: () => () => {}, getSnapshot: () => ({ active: 'en' }) },
        conversation: { input: { for: () => ({ focus }) } } } as unknown as Context
    const props = { sessionId: 'hhpi:fixture:source:codex:owned', sessionBinding: binding,
        useInput: (select: (value: { phase: string }) => unknown) => select({ phase: 'plain' }), useSession: () => false,
        inputActions: {}, renderSlot: () => null } as unknown as InputProps
    // jsdom has no size containers; only the CSS seat decision is this boundary.
    render(<><style>{composerPickerStyles}{'.hapi-composer-expand-trigger{display:none!important}'}</style>
        <section className="hapi-pane"><div data-composer-card><textarea aria-label="Unsent draft" defaultValue="Keep my paragraph"/>
            <SourceControls ctx={ctx} props={props} initial={{ model: 'GPT-6-Astra', effort: 'xhigh', permission: null, serviceTier: null }}
                permissionCapable={false} data={null} loading={false} busy={false} pending={null} error={null} sourceLocked={false}
                refresh={async () => {}} apply={async () => false}/></div></section></>)
    const draft = screen.getByRole('textbox'), card = draft.closest('[data-composer-card]')
    fireEvent.click(screen.getByRole('button', { name: 'More input controls' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: 'More input controls' })).getByRole('button', { name: 'Expand editor' }))
    expect(card).toHaveAttribute('data-hapi-composer-expanded')
    expect(draft).toHaveFocus()
    fireEvent.click(screen.getByRole('button', { name: 'More input controls' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: 'More input controls' })).getByRole('button', { name: 'Collapse editor' }))
    expect(card).not.toHaveAttribute('data-hapi-composer-expanded')
    expect(screen.getByRole('textbox')).toBe(draft)
    expect(draft).toHaveValue('Keep my paragraph')
    expect(focus).toHaveBeenCalledTimes(2)
})
