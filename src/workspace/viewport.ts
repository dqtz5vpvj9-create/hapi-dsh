/** Phone projection follows HAPI's 640px boundary without changing saved geometry. */
import { useEffect, useState } from 'react'

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
