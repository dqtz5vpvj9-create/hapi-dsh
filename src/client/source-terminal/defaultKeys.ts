// Adapted from HAPI 0f8ef697; original HAPI/Haven/TermBeam notices follow.
// Adapted from TermBeam; see UPSTREAM.md and docs/licenses/TERMBEAM-MIT.txt.
import type { TouchBarKey } from './types.ts';

/** HAPI's Haven-inspired layout; TermBeam owns key dispatch and customization. */
export const DEFAULT_TOUCHBAR_KEYS: TouchBarKey[] = [
    { id: 'keyboard', label: '⌨', send: '', action: 'keyboard', row: 1, col: 1 },
    { id: 'slash', label: '/', send: '/', row: 1, col: 2 },
    { id: 'ctrl-c', label: '^C', send: '\x03', row: 1, col: 3 },
    { id: 'esc', label: 'Esc', send: '\x1b', row: 1, col: 4 },
    { id: 'ctrl-b', label: '^B', send: '\x02', row: 1, col: 5 },
    { id: 'tab', label: 'Tab', send: '\x09', row: 1, col: 6 },
    { id: 'home', label: 'Home', send: '\x1b[H', row: 1, col: 7 },
    { id: 'up', label: '↑', send: '\x1b[A', row: 1, col: 8 },
    { id: 'end', label: 'End', send: '\x1b[F', row: 1, col: 9 },
    { id: 'enter', label: '↵', send: '\r', row: 2, col: 1 },
    { id: 'ctrl-d', label: '^D', send: '\x04', row: 2, col: 2 },
    { id: 'shift', label: 'Shift', send: '', modifier: 'shift', row: 2, col: 3 },
    { id: 'ctrl', label: 'Ctrl', send: '', modifier: 'ctrl', row: 2, col: 4 },
    { id: 'snippets', label: '✂', send: '', action: 'snippets', row: 2, col: 5 },
    // The aligned renderer pairs navigation independently of these saved positions.
    { id: 'left', label: '←', send: '\x1b[D', row: 2, col: 7 },
    { id: 'down', label: '↓', send: '\x1b[B', row: 2, col: 8 },
    { id: 'right', label: '→', send: '\x1b[C', row: 2, col: 9 },
];

/** Sort touchbar keys within a row by their starting column.
 *
 *  CSS Grid `auto-flow: row` (the default) doesn't reliably backtrack when
 *  DOM order has a key at a later column ahead of one at an earlier column.
 *  After a drag-swap (e.g. `Tab` at col 3 ↔ `↓` at col 6), the persisted
 *  `touchBarKeys` array still has the keys in their original array order,
 *  so DOM order no longer matches visual column order. Without sorting,
 *  later keys get pushed onto a phantom CSS row 2, where the JS-computed
 *  bar height clips them — they vanish from the rendered TouchBar even
 *  though the customizer's Live Preview still shows them (the Live Preview
 *  shipped this fix in commit ab68d5eb; the runtime bar regressed).
 *
 *  Returns a new array, never mutates input. */
export function sortKeysByCol<T extends { col?: number }>(keys: T[]): T[] {
  return [...keys].sort((a, b) => (a.col ?? 1) - (b.col ?? 1));
}

/** Map from a TouchBarKey "look" preset to the display name shown in the
 *  customizer. */
export const KEY_LOOK_OPTIONS: { value: NonNullable<TouchBarKey['style']>; label: string; description: string }[] = [
  { value: 'plain', label: 'Plain', description: 'Default key style' },
  { value: 'accent', label: 'Accent', description: 'Brand color (Enter, primary actions)' },
  { value: 'danger', label: 'Danger', description: 'Red (^C, destructive)' },
  { value: 'custom', label: 'Custom', description: 'Pick your own background and text colors' },
];

