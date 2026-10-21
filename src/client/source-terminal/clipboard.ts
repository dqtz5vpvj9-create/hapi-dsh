/** Standard DOM clipboard/focus access to the original terminal, without emulator internals. */
export function terminalTextInput(root: HTMLElement | null): HTMLTextAreaElement | null {
  return root?.querySelector<HTMLTextAreaElement>('[data-sidebar-terminal] textarea[aria-label]') ?? null
}
export function terminalSelection(root: HTMLElement | null): { text: string; selected: boolean } {
  const input = terminalTextInput(root)
  if (!input || !root) return { text: '', selected: false }
  // xterm's normal public copy event supplies its own selection. There is no
  // ._core access and this never reads another pane's DOM or clipboard.
  try {
    const data = new DataTransfer()
    input.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: data }))
    const selected = data.getData('text/plain')
    if (selected) return { text: selected, selected: true }
  } catch { /* Some browsers do not permit constructing a clipboard event. */ }
  const selection = root.ownerDocument.defaultView?.getSelection()
  if (selection?.anchorNode && selection.focusNode && root.contains(selection.anchorNode) && root.contains(selection.focusNode) && selection.toString()) {
    return { text: selection.toString(), selected: true }
  }
  // The upstream component does not expose its buffer. A visible snapshot is
  // labelled as such instead of claiming it contains unrendered scrollback.
  return { text: [...root.querySelectorAll('[data-sidebar-terminal] .xterm-rows > div')].map(row => row.textContent?.replace(/\s+$/, '') ?? '').join('\n').replace(/\n+$/, ''), selected: false }
}
export async function copyTerminalText(text: string, within: HTMLElement): Promise<boolean> {
  if (!text) return false
  try { await navigator.clipboard.writeText(text); return true } catch { /* Keep fallback within the modal focus boundary. */ }
  const input = document.createElement('textarea')
  input.value = text; input.readOnly = true; input.style.position = 'fixed'; input.style.left = '-9999px'; within.append(input); input.select()
  try { return document.execCommand?.('copy') ?? false } catch { return false } finally { input.remove() }
}
