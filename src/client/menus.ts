/** Dismiss only this plugin's action menus; disclosure panels keep their state. */
export function installWorkspaceMenus(document: Document): () => void {
    const view = document.defaultView
    const historyKey = '__hhpiWorkspaceMenu'
    const owner = view?.crypto.randomUUID()
    type Layer = { url: string; state: unknown; ownedState: unknown }
    let layer: Layer | undefined
    let returning: Layer | undefined
    let scheduled: ReturnType<typeof setTimeout> | undefined
    let stopped = false
    const openMenus = (): HTMLDetailsElement[] => [...document.querySelectorAll<HTMLDetailsElement>('details.hapi-menu[open]')]
    const owns = (entry: Layer): boolean => view?.location.href === entry.url
        && view.history.state === entry.ownedState && view.history.state?.[historyKey] === owner
    const schedule = (): void => {
        if (stopped || scheduled !== undefined) return
        scheduled = setTimeout(() => { scheduled = undefined; synchronize() }, 0)
    }
    const synchronize = (): void => {
        if (!view || stopped || returning) return
        // A route action may have already replaced this menu's history entry.
        // It owns the new entry; menu cleanup must never traverse it backwards.
        if (layer && !owns(layer)) layer = undefined
        if (openMenus().length) {
            if (layer) return
            const state: unknown = view.history.state
            layer = { url: view.location.href, state, ownedState: undefined }
            view.history.pushState({ ...(state && typeof state === 'object' ? state : {}), [historyKey]: owner }, '', layer.url)
            layer.ownedState = view.history.state
        } else if (layer) {
            const entry = layer
            layer = undefined
            if (!owns(entry)) return
            returning = entry
            view.history.back()
        }
    }
    const portalOwner = (target: EventTarget | null): HTMLDetailsElement | null => {
        if (!(target instanceof Element)) return null
        const owner = target.closest<HTMLElement>('[data-hapi-menu-owner]')?.dataset.hapiMenuOwner
        const menu = owner ? document.getElementById(owner) : null
        return menu?.matches('details.hapi-menu') ? menu as HTMLDetailsElement : null
    }
    const outside = (event: PointerEvent): void => {
        const owner = portalOwner(event.target)
        const menus = openMenus()
        for (const menu of menus) if (menu !== owner && (!(event.target instanceof Node) || !menu.contains(event.target))) menu.open = false
        if (menus.length || layer || returning) schedule()
    }
    const choose = (event: MouseEvent): void => {
        if (!(event.target instanceof Element)) return
        const button = event.target.closest('button')
        if (!button || button.disabled) return
        const menu = button.closest<HTMLDetailsElement>('details.hapi-menu') ?? portalOwner(event.target)
        if (menu) { menu.open = false; schedule() }
    }
    const escape = (event: KeyboardEvent): void => {
        if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return
        for (const menu of openMenus()) {
            menu.open = false
            if (event.target instanceof Node && (menu.contains(event.target) || portalOwner(event.target) === menu)) {
                menu.querySelector('summary')?.focus()
                event.preventDefault()
            }
        }
        schedule()
    }
    const toggle = (event: Event): void => {
        if (event.target instanceof Element && event.target.matches('details.hapi-menu')) schedule()
    }
    const back = (): void => {
        if (returning) {
            returning = undefined
            if (stopped) { view?.removeEventListener('popstate', back); return }
            // An outside click can close one menu and open another before the
            // asynchronous traversal completes. Keep that new menu open.
            synchronize()
            return
        }
        if (!layer || owns(layer)) return // Ignore a delayed event for an older entry.
        layer = undefined
        const menus = openMenus()
        for (const menu of menus) menu.open = false
        menus.at(-1)?.querySelector('summary')?.focus({ preventScroll: true })
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('click', choose)
    document.addEventListener('keydown', escape)
    document.addEventListener('toggle', toggle, true)
    view?.addEventListener('popstate', back)
    return () => {
        stopped = true
        if (scheduled !== undefined) clearTimeout(scheduled)
        document.removeEventListener('pointerdown', outside)
        document.removeEventListener('click', choose)
        document.removeEventListener('keydown', escape)
        document.removeEventListener('toggle', toggle, true)
        if (layer && owns(layer)) {
            const entry = layer
            layer = undefined
            // Disposal must not initiate an asynchronous navigation while the
            // next application/route is mounting. Restore only our current state.
            view!.history.replaceState(entry.state, '', entry.url)
        }
        if (!returning) view?.removeEventListener('popstate', back)
    }
}
