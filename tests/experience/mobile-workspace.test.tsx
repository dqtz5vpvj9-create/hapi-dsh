import { createRef, useState } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import { SidebarScope } from '../../src/client/sidebar-scope.tsx'
import { SidebarSearchControls } from '../../src/client/sidebar-search-controls.tsx'
import { SourceControlRow } from '../../src/client/composer-picker/presentation.tsx'
import { positionPicker } from '../../src/client/composer-picker/position.ts'
import type { SidebarFilter } from '../../src/workspace/sidebar-state.ts'
import { en, type WorkspaceTranslate } from '../../src/client/locales.ts'
import { COMPACT_WORKSPACE_QUERY, useNarrowViewport } from '../../src/workspace/viewport.ts'
import { workspaceStyles } from '../../src/client/styles.ts'
const t: WorkspaceTranslate = key => en[key]

test('directory scope and unread shortcut share one filter without changing counts', async () => {
    const user = userEvent.setup()
    function Directory() {
        const [filter, setFilter] = useState<SidebarFilter>('all')
        return <SidebarScope filter={filter} counts={{ all: 20, running: 1, attention: 2, unread: 3 }} onFilter={setFilter} t={t}/>
    }
    render(<Directory/> )
    const select = screen.getByRole('combobox')
    await user.click(screen.getByRole('button', { name: /3.*Unread/i }))
    expect(select).toHaveValue('unread')
    await user.selectOptions(select, 'attention')
    expect(screen.getByRole('button')).toHaveAttribute('aria-pressed', 'false')
    await user.click(screen.getByRole('button'))
    await user.click(screen.getByRole('button'))
    expect(select).toHaveValue('all')
})

test('persistent search keeps the query visible after blur without opening the keyboard on mount', async () => {
    const user = userEvent.setup(), change = vi.fn()
    const inputRef = createRef<HTMLInputElement>()
    render(<><SidebarSearchControls persistent query="review" onQueryChange={change} start="" end="" onDatesChange={() => {}}
        activityDates={new Set()} expanded={false} onExpandedChange={() => {}} inputRef={inputRef} t={t}/><button>Elsewhere</button></>)
    expect(inputRef.current).not.toHaveFocus()
    await user.click(inputRef.current!)
    await user.click(screen.getByRole('button', { name: 'Elsewhere' }))
    expect(screen.getByRole('searchbox')).toHaveValue('review')
})

test('model and effort controls retain source values and route independently while a write is pending', async () => {
    const user = userEvent.setup(), toggle = vi.fn()
    render(<SourceControlRow summary={{ model: 'GPT-6.1 Terra', effort: 'medium', permission: ':workspace', permissionAvailable: true, serviceTier: null }}
        sessionId="source-a" open={null} panelId="a" pending attention={false} onToggle={toggle} tr={en => en}
        utilities={<><button>Queue and goal</button><button>Reference a file</button><button>Expand editor</button></>}/>)
    expect(screen.getAllByRole('button')).toHaveLength(7)
    await user.click(screen.getByRole('button', { name: 'GPT-6.1 Terra' }))
    expect(toggle).toHaveBeenLastCalledWith('model')
    await user.click(screen.getByRole('button', { name: 'Reasoning effort · Medium' }))
    expect(toggle).toHaveBeenLastCalledWith('effort')
    await user.click(screen.getByRole('button', { name: /Session permissions/ }))
    expect(toggle).toHaveBeenLastCalledWith('permission')
    expect(document.querySelector('button button')).toBeNull()
})

test('phone picker stays above its control and inside the keyboard-adjusted viewport', () => {
    const box = positionPicker({ left: 70, right: 230, top: 390, bottom: 434 }, { left: 0, top: 0, width: 390, height: 460 }, 700)
    expect(box.layout).toBe('popover')
    expect(box.top).toBeGreaterThanOrEqual(12)
    expect(box.top + box.maxHeight).toBeLessThanOrEqual(382)
    expect(box.left + box.width).toBeLessThanOrEqual(378)
})

/** jsdom has no media evaluator. Only the browser media-feature boundary is
 * controlled here; the query, React subscription and styles are production. */
function viewportMedia(initial: { width: number; height: number; pointer: 'fine' | 'coarse' }) {
    let features = initial
    const lists: Array<{ changed: () => void; listeners: Set<EventListenerOrEventListenerObject> }> = []
    const matchMedia = vi.fn((query: string) => {
        const matches = () => query.split(',').some(branch => branch.split(/\s+and\s+/).every(term => {
            const feature = /^\((max-width|max-height|pointer):\s*(\d+px|coarse|fine)\)$/.exec(term.trim())
            if (!feature) throw new Error(`Unsupported fixture media feature: ${term}`)
            return feature[1] === 'pointer' ? features.pointer === feature[2]
                : (feature[1] === 'max-width' ? features.width : features.height) <= Number.parseInt(feature[2]!, 10)
        }))
        const listeners = new Set<EventListenerOrEventListenerObject>()
        let previous = matches()
        const list = {
            media: query, get matches() { return matches() },
            addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => { listeners.add(listener) },
            removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => { listeners.delete(listener) },
        }
        lists.push({ listeners, changed: () => {
            const next = matches()
            if (next === previous) return
            previous = next
            for (const listener of listeners) {
                const event = new Event('change')
                if (typeof listener === 'function') listener(event)
                else listener.handleEvent(event)
            }
        } })
        return list
    })
    vi.stubGlobal('matchMedia', matchMedia)
    return { matchMedia, change(next: typeof initial) { features = next; for (const list of lists) list.changed() },
        get subscriptions() { return lists.reduce((sum, list) => sum + list.listeners.size, 0) } }
}

function ViewportProjection() {
    const compact = useNarrowViewport()
    return <div data-testid="projection" data-compact={compact}>
        <textarea aria-label="Owned draft" defaultValue={'Retained paragraph\n'.repeat(80)}/>
        <span>Owned attachment 105B</span>
    </div>
}

test.each([
    { width: 390, height: 844, pointer: 'coarse' as const, compact: true },
    { width: 844, height: 390, pointer: 'coarse' as const, compact: true },
    { width: 844, height: 390, pointer: 'fine' as const, compact: false },
    { width: 1280, height: 800, pointer: 'coarse' as const, compact: false },
])('compact projection at $width×$height with $pointer pointer is $compact', ({ compact, ...features }) => {
    viewportMedia(features)
    render(<ViewportProjection/>)
    expect(screen.getByTestId('projection')).toHaveAttribute('data-compact', String(compact))
    // Both mobile-shell blocks follow the same layout policy as the Pane owner.
    expect(workspaceStyles.split(`@media ${COMPACT_WORKSPACE_QUERY} {`)).toHaveLength(3)
})

test('touch rotation retains the mounted draft, attachment and editor selection without changing projection', () => {
    const media = viewportMedia({ width: 390, height: 844, pointer: 'coarse' })
    const view = render(<ViewportProjection/>)
    const input = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Owned draft' })
    fireEvent.change(input, { target: { value: `${input.value}Current unsent edit` } })
    const retained = input.value
    input.setSelectionRange(35, 48); input.scrollTop = 120
    act(() => { media.change({ width: 844, height: 390, pointer: 'coarse' }) })
    expect(screen.getByTestId('projection')).toHaveAttribute('data-compact', 'true')
    act(() => { media.change({ width: 390, height: 844, pointer: 'coarse' }) })
    expect(screen.getByRole('textbox')).toBe(input)
    expect(input).toHaveValue(retained)
    expect([input.selectionStart, input.selectionEnd, input.scrollTop]).toEqual([35, 48, 120])
    expect(screen.getByText('Owned attachment 105B')).toBeVisible()
    view.unmount()
    expect(media.subscriptions).toBe(0)
})

test('layout media changes update projection; a visual keyboard resize alone does not', () => {
    const media = viewportMedia({ width: 1280, height: 800, pointer: 'coarse' })
    render(<ViewportProjection/>)
    expect(screen.getByTestId('projection')).toHaveAttribute('data-compact', 'false')
    act(() => { window.dispatchEvent(new Event('resize')) })
    expect(screen.getByTestId('projection')).toHaveAttribute('data-compact', 'false')
    act(() => { media.change({ width: 1280, height: 500, pointer: 'coarse' }) })
    expect(screen.getByTestId('projection')).toHaveAttribute('data-compact', 'true')
    act(() => { media.change({ width: 1280, height: 500, pointer: 'fine' }) })
    expect(screen.getByTestId('projection')).toHaveAttribute('data-compact', 'false')
})
