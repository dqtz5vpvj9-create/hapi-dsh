import { createRef, useState } from 'react'
import { render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import { SidebarScope } from '../../src/client/sidebar-scope.tsx'
import { SidebarSearchControls } from '../../src/client/sidebar-search-controls.tsx'
import { SourceControlRow } from '../../src/client/composer-picker/presentation.tsx'
import { positionPicker } from '../../src/client/composer-picker/position.ts'
import type { SidebarFilter } from '../../src/workspace/sidebar-state.ts'
import { en, type WorkspaceTranslate } from '../../src/client/locales.ts'
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
    render(<SourceControlRow summary={{ model: 'source-model', effort: 'high', permission: null, permissionAvailable: false, serviceTier: null }}
        sessionId="source-a" open={null} panelId="a" pending attention={false} onToggle={toggle} tr={en => en}/>)
    await user.click(screen.getByRole('button', { name: /source-model/ }))
    expect(toggle).toHaveBeenLastCalledWith('model')
    await user.click(screen.getByRole('button', { name: /Reasoning effort/ }))
    expect(toggle).toHaveBeenLastCalledWith('effort')
    expect(screen.queryByRole('button', { name: /Session permissions/ })).not.toBeInTheDocument()
})

test('phone picker stays above its control and inside the keyboard-adjusted viewport', () => {
    const box = positionPicker({ left: 70, right: 230, top: 390, bottom: 434 }, { left: 0, top: 0, width: 390, height: 460 }, 700)
    expect(box.layout).toBe('popover')
    expect(box.top).toBeGreaterThanOrEqual(12)
    expect(box.top + box.maxHeight).toBeLessThanOrEqual(382)
    expect(box.left + box.width).toBeLessThanOrEqual(378)
})
