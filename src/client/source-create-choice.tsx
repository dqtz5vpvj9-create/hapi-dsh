/** Native DSH controls for the two Host-addressed creation forms. */
import { useEffect, useId, useState } from 'react'
import { Button, IconChevronDownOutlineRegular, Menu, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'

export function CreationChoice({ label, value, options, disabled = false, placeholder, onChange }: {
    label: string; value: string; options: readonly { id: string; label: string; disabled?: boolean }[]
    disabled?: boolean; placeholder: string; onChange(value: string): void
}) {
    const id = useId(), [open, setOpen] = useState(false)
    useEffect(() => { if (disabled) setOpen(false) }, [disabled])
    const selected = options.find(option => option.id === value)
    return <div className="hhpi-create-field">
        <label id={`${id}-label`} htmlFor={id}>{label}</label>
        <Menu open={open && !disabled} portal={false} className="hhpi-create-choice" selectedId={value}
            items={options as readonly MenuEntry[]} onClose={() => setOpen(false)} onSelect={next => { setOpen(false); if (next !== value) onChange(next) }}
            anchor={<Button id={id} type="button" variant="outline" disabled={disabled || options.length === 0}
                aria-labelledby={`${id}-label ${id}-value`} aria-haspopup="menu" aria-expanded={open && !disabled}
                onClick={() => setOpen(current => !current)}>
                <span id={`${id}-value`}>{selected?.label ?? placeholder}</span><IconChevronDownOutlineRegular/>
            </Button>}/>
    </div>
}
