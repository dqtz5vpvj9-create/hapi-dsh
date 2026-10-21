import { randomId } from '../random-id.ts'
// Adapted from HAPI 0f8ef697; original HAPI/Haven/TermBeam notices follow.
// SPDX-License-Identifier: AGPL-3.0-only
// Haven toolbar key IDs and macro presets; browser sequences use TermBeam's encoder.
import { DEFAULT_TOUCHBAR_KEYS } from './defaultKeys.ts'
import { encodeCombo } from './keyCombo.ts'
import type { TouchBarKey } from './types.ts'
const none = { ctrl: false, alt: false, shift: false, meta: false }
export const BUILTIN_KEYS: TouchBarKey[] = [
    ...DEFAULT_TOUCHBAR_KEYS.filter(key => !key.id.startsWith('ctrl-')),
    { id: 'copy', label: 'Copy', send: '', action: 'copy' },
    { id: 'paste', label: 'Paste', send: '', action: 'paste' },
    { id: 'alt', label: 'Alt', send: '', modifier: 'alt' },
    ...['Insert', 'Delete', 'PageUp', 'PageDown', 'Backspace', ...Array.from({ length: 12 }, (_, index) => `F${index + 1}`)].map(name => ({ id: name.toLowerCase(), label: name, send: encodeCombo(name, none) })),
    ...['|', '~', '\\', '`', '-', '_', '=', '+', "'", '"', ';', ':', '!', '?', '@', '#', '$', '%', '^', '&', '*', '(', ')', '[', ']', '{', '}', '<', '>'].map((char, index) => ({ id: `symbol-${index}`, label: char, send: char })),
]
export const MACRO_PRESETS = [
    { label: 'Paste', send: 'PASTE' },
    ...['C', 'D', 'Z', 'L', 'A', 'B', 'R', 'W', 'U'].map(letter => ({ label: `^${letter}`, send: String.fromCharCode(letter.charCodeAt(0) - 64) })),
    { label: '⇧Tab', send: '\x1b[Z' },
    { label: 'C-A-Del', send: '\x1b[3;8~' },
    { label: 'C-Del', send: '\x1b[3;6~' },
    { label: 'C-Ins', send: '\x1b[2;5~' },
    { label: 'S-Ins', send: '\x1b[2;2~' },
]
export function parseSendSequence(text: string): string {
    return text.replace(/\\(u[0-9a-f]{4}|x[0-9a-f]{2}|e|n|r|t|\\)/gi, (_, escape: string) => {
        if (escape[0] === 'u' || escape[0] === 'x') return String.fromCharCode(parseInt(escape.slice(1), 16))
        return ({ e: '\x1b', n: '\n', r: '\r', t: '\t', '\\': '\\' } as Record<string, string>)[escape] ?? escape
    })
}
export const displaySequence = (send: string) => JSON.stringify(send).slice(1, -1)
const havenIds: Record<string, string> = { esc: 'esc_key', enter: 'enter_key', tab: 'tab_key', left: 'arrow_left', right: 'arrow_right', up: 'arrow_up', down: 'arrow_down', slash: 'sym_slash', pageup: 'pgup', pagedown: 'pgdn', copy: 'copy' }
const symbolNames = ['pipe', 'tilde', 'backslash', 'backtick', 'dash', 'underscore', 'equals', 'plus', 'squote', 'dquote', 'semicolon', 'colon', 'bang', 'question', 'at', 'hash', 'dollar', 'percent', 'caret', 'amp', 'star', 'lparen', 'rparen', 'lbracket', 'rbracket', 'lbrace', 'rbrace', 'lt', 'gt']
for (let index = 0; index < symbolNames.length; index++) havenIds[`symbol-${index}`] = `sym_${symbolNames[index]}`
const externalId = (key: TouchBarKey) => havenIds[key.id] ?? key.id
export function exportLayout(keys: TouchBarKey[]): string {
    return JSON.stringify([1, 2].map(row => keys.filter(key => (key.row ?? 1) === row).sort((a, b) => (a.col ?? 1) - (b.col ?? 1)).map(key => {
        const builtin = BUILTIN_KEYS.find(item => item.id === key.id && (item.label === key.label || key.action || key.modifier) && item.send === key.send && item.action === key.action && item.modifier === key.modifier)
        return builtin ? externalId(builtin) : { label: key.label, send: key.action === 'paste' ? 'PASTE' : key.send }
    })), null, 2)
}
export function importLayout(text: string): TouchBarKey[] {
    const rows: unknown = JSON.parse(text)
    if (!Array.isArray(rows) || rows.length < 1 || rows.length > 2) throw new Error('Expected one or two rows')
    return rows.flatMap((row: unknown, rowIndex: number) => {
        if (!Array.isArray(row)) throw new Error('Each row must be an array')
        return row.map((item: unknown, index: number): TouchBarKey => {
            let key: TouchBarKey
            if (typeof item === 'string') {
                const builtin = BUILTIN_KEYS.find(value => externalId(value) === item)
                if (!builtin) throw new Error(`Unknown key: ${item}`)
                key = { ...builtin }
            } else if (item && typeof item === 'object' && 'label' in item && 'send' in item && typeof item.label === 'string' && typeof item.send === 'string' && item.label && item.send) {
                key = { id: `custom-${randomId()}`, label: item.label, send: item.send === 'PASTE' ? '' : item.send, ...(item.send === 'PASTE' ? { action: 'paste' as const } : {}) }
            } else throw new Error('Custom keys need a label and a send string')
            return { ...key, row: (rowIndex + 1) as 1 | 2, col: index + 1, size: 1 }
        })
    })
}
