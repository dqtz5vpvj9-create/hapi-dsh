/** Presentation seats only. Production task/controller/ledger behavior is tested;
 * native styling, menu focus and Modal dismissal require the actual browser path. */
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react'

function Button({ variant: _variant, size: _size, icon, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string; icon?: ReactNode }) {
  return <button type="button" {...props}>{icon}{children}</button>
}
function Input(props: InputHTMLAttributes<HTMLInputElement>) { return <input {...props}/> }
function Checkbox({ checked, onChange, label, disabled }: { checked: boolean; onChange: (next: boolean) => void; label: string; disabled?: boolean }) {
  return <label><input type="checkbox" checked={checked} disabled={disabled} onChange={event => onChange(event.currentTarget.checked)}/>{label}</label>
}
function Modal({ open, title, children }: { open: boolean; title: string; children?: ReactNode }) {
  return open ? <div role="dialog" aria-modal="true" aria-label={title}>{children}</div> : null
}
function Menu({ open, anchor, items, onSelect }: { open: boolean; anchor: ReactNode; items: readonly { id: string; label: ReactNode; disabled?: boolean }[]; onSelect: (id: string) => void }) {
  return <>{anchor}{open && <div role="menu">{items.map(item => <button key={item.id} type="button" role="menuitem" disabled={item.disabled} onClick={() => onSelect(item.id)}>{item.label}</button>)}</div>}</>
}
const icon = () => <span aria-hidden="true"/>
export const nativeTaskPrimitives = { Button, Input, Checkbox, Modal, Menu, ...Object.fromEntries([
  'IconCheckOutlineRegular', 'IconChevronDownOutlineRegular', 'IconChevronUpOutlineRegular', 'IconChevronLeftOutlineRegular', 'IconChevronRightOutlineRegular', 'IconCloseOutlineRegular', 'IconEditOutlineRegular', 'IconEllipsisOutlineRegular', 'IconGoalOutlineRegular', 'IconPauseOutlineRegular', 'IconPlayOutlineRegular', 'IconQueueOutlineRegular', 'IconRefreshOutlineRegular', 'IconTrashOutlineRegular',
].map(name => [name, icon])) }
