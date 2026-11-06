import { useState } from 'react'
import type { UseDisclosure } from '@deepseek-ai/dsh-client-ui-chat/client'

/** Each native row keeps independent manual choice; only untouched live rows open automatically. */
export function useLiveDisclosure(original: UseDisclosure, running: boolean): ReturnType<UseDisclosure> {
    const native = original()
    const [manual, setManual] = useState<boolean | null>(null)
    const expanded = manual ?? (native.expanded || running)
    return { expanded, setExpanded: open => { setManual(open); native.setExpanded(open) },
        toggle: () => { setManual(!expanded); native.setExpanded(!expanded) } }
}
