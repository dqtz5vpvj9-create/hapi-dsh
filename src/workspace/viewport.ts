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
        const update = (): void => {
            const top = root.current?.getBoundingClientRect().top ?? 0
            setHeight(Math.max(0, (viewport?.height ?? window.innerHeight) + (viewport?.offsetTop ?? 0) - top))
        }
        update(); viewport?.addEventListener('resize', update); viewport?.addEventListener('scroll', update); window.addEventListener('resize', update)
        return () => { viewport?.removeEventListener('resize', update); viewport?.removeEventListener('scroll', update); window.removeEventListener('resize', update) }
    }, [root, mobile])
    return height
}
