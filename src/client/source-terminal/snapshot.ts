/** The official mounted terminal owns selection and visible text; no second attachment is opened. */
export type TerminalTextSnapshot = { kind: 'selected' | 'visible'; lines: string[] }

export async function readTerminalCopySnapshot(local: { text: string; selected: boolean }, signal: AbortSignal): Promise<TerminalTextSnapshot> {
    signal.throwIfAborted()
    return { kind: local.selected ? 'selected' : 'visible', lines: local.text.split('\n') }
}
