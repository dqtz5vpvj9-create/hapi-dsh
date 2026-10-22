import { useEffect, useState } from 'react'

/** Cancel the previous timer when the reader changes the search phrase. */
export function useDebouncedSidebarQuery(input: string, delay = 180): string {
    const [query, setQuery] = useState(input)
    useEffect(() => {
        if (!input) { setQuery(''); return }
        const timer = setTimeout(() => setQuery(input), delay)
        return () => clearTimeout(timer)
    }, [input, delay])
    return query
}
