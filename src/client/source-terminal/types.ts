// Source: HAPI 0f8ef697, AGPL-3.0-only.
export type TerminalModifier = 'ctrl' | 'alt' | 'shift'

export type TouchBarKey = {
    id: string
    label: string
    send: string
    row?: 0 | 1 | 2
    col?: number
    size?: number
    style?: 'plain' | 'accent' | 'danger' | 'custom'
    bg?: string
    color?: string
    modifier?: TerminalModifier | 'meta'
    action?: 'copy' | 'paste' | 'keyboard' | 'snippets'
}
