/** Presentation boundary for Node tests of source routing, not toolbar layout. */
import { createElement, type ComponentProps } from 'react'

export function Button({ variant: _variant, size: _size, ...props }: ComponentProps<'button'> & { variant?: string; size?: string }) {
    return createElement('button', props)
}
