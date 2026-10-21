// Adapted from HAPI 0f8ef697; original HAPI/Haven/TermBeam notices follow.
// SPDX-License-Identifier: AGPL-3.0-only
// Port of Haven's ToolbarLayout/AlignedToolbarContent semantics. See HAVEN.md.
import { sortKeysByCol } from './defaultKeys.ts'
import type { TouchBarKey } from './types.ts'

export type ToolbarSettings = {
    navMode: 'aligned' | 'inline'
    uniformGrid: boolean
    minKeyWidth: number
}
export const DEFAULT_TOOLBAR_SETTINGS: ToolbarSettings = { navMode: 'aligned', uniformGrid: false, minKeyWidth: 0 }
const NAV_TOP = ['\x1b[H', '\x1b[A', '\x1b[F', '\x1b[5~']
const NAV_BOTTOM = ['\x1b[D', '\x1b[B', '\x1b[C', '\x1b[6~']
const NAV = new Set([...NAV_TOP, ...NAV_BOTTOM])
const isNav = (key: TouchBarKey) => !key.action && !key.modifier && NAV.has(key.send)
export const toolbarRows = (keys: TouchBarKey[]) => ([1, 2] as const).map(row => sortKeysByCol(keys.filter(key => (key.row ?? 1) === row)))

export function alignedColumns(keys: TouchBarKey[]): Array<[TouchBarKey | undefined, TouchBarKey | undefined]> {
    const rows = toolbarRows(keys)
    const split = rows.map(row => {
        const first = row.findIndex(isNav)
        const last = row.map(isNav).lastIndexOf(true)
        return first < 0 ? [row, []] : [row.slice(0, first).filter(key => !isNav(key)), row.slice(last + 1)]
    })
    const columns: Array<[TouchBarKey | undefined, TouchBarKey | undefined]> = []
    const pair = (top: TouchBarKey[], bottom: TouchBarKey[]) => {
        for (let index = 0; index < Math.max(top.length, bottom.length); index++) columns.push([top[index], bottom[index]])
    }
    pair(split[0]![0]!, split[1]![0]!)
    for (let index = 0; index < NAV_TOP.length; index++) {
        const top = keys.find(key => (key.row ?? 1) > 0 && isNav(key) && key.send === NAV_TOP[index])
        const bottom = keys.find(key => (key.row ?? 1) > 0 && isNav(key) && key.send === NAV_BOTTOM[index])
        if (top || bottom) columns.push([top, bottom])
    }
    pair(split[0]![1]!, split[1]![1]!)
    return columns
}

/** Preserve unaffected row order when assigning, hiding or dragging a key. */
export function placeKey(keys: TouchBarKey[], id: string, row: 0 | 1 | 2, beforeId?: string): TouchBarKey[] {
    if (id === beforeId) return keys
    const key = keys.find(item => item.id === id)
    if (!key) return keys
    const remaining = keys.filter(item => item.id !== id)
    const target = sortKeysByCol(remaining.filter(item => (item.row ?? 1) === row))
    const index = beforeId ? target.findIndex(item => item.id === beforeId) : -1
    target.splice(index < 0 ? target.length : index, 0, { ...key, row, size: 1 })
    return [...remaining.filter(item => (item.row ?? 1) !== row), ...target.map((item, index) => ({ ...item, col: index + 1 }))]
}
