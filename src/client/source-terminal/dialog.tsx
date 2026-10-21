/** A native modal for terminal accessory actions; the terminal itself stays official. */
import { useEffect, useId, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react'

export function TerminalDialog({ open, title, description, closeLabel, onClose, children }: {
  open: boolean; title: string; description?: string; closeLabel: string; onClose: () => void; children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null), titleId = useId(), descriptionId = useId()
  useEffect(() => {
    const element = dialog.current
    if (!element || !open) return
    element.showModal()
    return () => { element.close() }
  }, [open])
  if (!open) return null
  return <dialog ref={dialog} className="hapi-terminal-dialog" aria-labelledby={titleId} aria-describedby={description ? descriptionId : undefined}
    onCancel={event => { event.preventDefault(); onClose() }}>
    <header><h2 id={titleId}>{title}</h2><button type="button" aria-label={closeLabel} onClick={onClose}>×</button></header>
    <div className="hapi-terminal-dialog-content">{description && <p id={descriptionId} className="hapi-terminal-hint">{description}</p>}{children}</div>
    <footer><button type="button" onClick={onClose}>{closeLabel}</button></footer>
  </dialog>
}
export function Button({ variant, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string }) {
  return <button type="button" data-variant={variant} {...props}>{children}</button>
}
