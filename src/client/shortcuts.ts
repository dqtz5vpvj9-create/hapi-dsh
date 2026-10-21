import { adjacentPane, type WorkspaceStore } from './model.ts'
import type { Shortcuts } from '@deepseek-ai/dsh-client-shortcuts/client'

/** Original HAPI WorkspaceShell prefix lifetime at 0f8ef697. */
export const WORKSPACE_PREFIX_TIMEOUT_MS = 1500

/** Route the configured official New Session gesture before its default action. */
export function installNewSessionShortcut(shortcuts: Pick<Shortcuts, 'observeFixedInput' | 'catalog' | 'config'>, open: () => void): () => void {
    return shortcuts.observeFixedInput(input => {
        if (input.type === 'reset') return
        const { gesture, context } = input
        if (gesture.composing || gesture.defaultPrevented || context.modal !== null || context.region === 'terminal'
            || shortcuts.config.getSnapshot().status === 'loading') return
        const command = shortcuts.catalog.getSnapshot().find(row => row.id === 'session.new')
        const binding = command?.binding
        if (!binding || command.issue !== null || command.conflicts.length) return
        const codes = binding.secondCode ? [binding.code, binding.secondCode].sort() : [binding.code]
        const pressed = gesture.secondCode ? [gesture.code, gesture.secondCode].sort() : [gesture.code]
        if (codes.length !== pressed.length || codes.some((code, index) => code !== pressed[index])
            || !(['control', 'alt', 'shift', 'meta'] as const).every(modifier => gesture[modifier] === binding.modifiers.includes(modifier))) return
        input.consume()
        if (!gesture.repeat) open()
    })
}

export type WorkspaceCommand = 'splitHorizontal' | 'splitVertical' | 'newWindow' | 'closePane' | 'zoom'
    | 'nextWindow' | 'previousWindow' | 'nextPane' | 'help' | 'restoreWindow' | 'windowList'
    | 'left' | 'right' | 'up' | 'down' | `window:${number}`

export function commandForKey(key: string): WorkspaceCommand | undefined {
    const bindings: Record<string, WorkspaceCommand> = {
        '%': 'splitHorizontal', '"': 'splitVertical', c: 'newWindow', x: 'closePane', z: 'zoom',
        n: 'nextWindow', p: 'previousWindow', o: 'nextPane', '?': 'help', u: 'restoreWindow', w: 'windowList',
        h: 'left', j: 'down', k: 'up', l: 'right',
        ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down',
    }
    if (/^[1-9]$/.test(key)) return `window:${Number(key)}`
    return bindings[key]
}

export function runWorkspaceCommand(store: WorkspaceStore, command: WorkspaceCommand, help: () => void, windowList: () => void = help, pick?: () => void): void {
    if (command.startsWith('window:')) {
        const window = store.getSnapshot().windows[Number(command.slice(7)) - 1]
        if (window) store.selectWindow(window.id)
    } else if (command === 'splitHorizontal') { store.split('horizontal'); pick?.() }
    else if (command === 'splitVertical') { store.split('vertical'); pick?.() }
    else if (command === 'newWindow') { store.createWindow(); pick?.() }
    else if (command === 'closePane') store.closePane(store.focusedPane().id)
    else if (command === 'zoom') store.toggleZoom()
    else if (command === 'nextWindow') store.cycleWindow(1)
    else if (command === 'previousWindow') store.cycleWindow(-1)
    else if (command === 'nextPane') store.cyclePane(1)
    else if (command === 'restoreWindow') store.restoreWindow()
    else if (command === 'help') help()
    else if (command === 'windowList') windowList()
    else {
        const adjacent = adjacentPane(store.active().root, store.focusedPane().id, command as 'left' | 'right' | 'up' | 'down')
        if (adjacent) store.focus(adjacent)
    }
}

/** A bounded tmux prefix state machine, separately testable without a DOM. */
export class PrefixKeys {
    private until = 0
    get active(): boolean { return this.until > 0 }
    clear(): void { this.until = 0 }

    key(event: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; isComposing?: boolean; repeat?: boolean }, now: number): {
        consumed: boolean
        command?: WorkspaceCommand
        armed: boolean
    } {
        if (event.isComposing || event.repeat) return { consumed: false, armed: this.active }
        if (event.ctrlKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === 'b') {
            // A second Ctrl B passes through to the editor, like tmux send-prefix.
            if (this.until > now) { this.clear(); return { consumed: false, armed: false } }
            this.until = now + WORKSPACE_PREFIX_TIMEOUT_MS
            return { consumed: true, armed: true }
        }
        if (this.until <= now) { this.clear(); return { consumed: false, armed: false } }
        this.clear()
        if (event.key === 'Escape') return { consumed: true, armed: false }
        const command = commandForKey(event.key)
        // HAPI consumes an unknown suffix as well; it must not become text in
        // a composer/terminal after the user intentionally entered a prefix.
        return { consumed: true, ...(command ? { command } : {}), armed: false }
    }
}
