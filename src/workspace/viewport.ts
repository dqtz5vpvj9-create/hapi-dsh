/** Phone projection follows HAPI's 640px boundary without changing saved geometry. */
import { useEffect, useState, type RefObject } from 'react'

export function useNarrowViewport(): boolean {
    const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 640px)').matches)
    useEffect(() => {
        const media = window.matchMedia('(max-width: 640px)')
        const changed = (): void => { setNarrow(media.matches) }
        changed(); media.addEventListener('change', changed)
        return () => { media.removeEventListener('change', changed) }
    }, [])
    return narrow
}

/** The software keyboard changes the visible viewport without changing layout. */
export function useWorkspaceViewport(root: RefObject<HTMLElement>, mobile: boolean): number | undefined {
    const [height, setHeight] = useState<number>()
    useEffect(() => {
        if (!mobile) { setHeight(undefined); return }
        const viewport = window.visualViewport
        let restingHeight = window.innerHeight
        const update = (): void => {
            const top = root.current?.getBoundingClientRect().top ?? 0
            setHeight(Math.max(0, (viewport?.height ?? window.innerHeight) + (viewport?.offsetTop ?? 0) - top))
            const editing = document.activeElement instanceof HTMLElement && root.current?.contains(document.activeElement)
                && document.activeElement.matches('[contenteditable=true],textarea,input:not([type=button])')
            if (!editing) restingHeight = window.innerHeight
            root.current?.toggleAttribute('data-software-keyboard', Boolean(editing && viewport && viewport.scale === 1 && Math.max(restingHeight, window.innerHeight) - viewport.height > 120))
        }
        update(); viewport?.addEventListener('resize', update); viewport?.addEventListener('scroll', update); window.addEventListener('resize', update)
        document.addEventListener('focusin', update); document.addEventListener('focusout', update)
        return () => { viewport?.removeEventListener('resize', update); viewport?.removeEventListener('scroll', update); window.removeEventListener('resize', update)
            document.removeEventListener('focusin', update); document.removeEventListener('focusout', update); root.current?.removeAttribute('data-software-keyboard') }
    }, [root, mobile])
    return height
}
