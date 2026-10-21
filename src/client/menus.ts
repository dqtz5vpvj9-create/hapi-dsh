/** Dismiss only this plugin's action menus; disclosure panels keep their state. */
export function installWorkspaceMenus(document: Document): () => void {
    const openMenus = (): HTMLDetailsElement[] => [...document.querySelectorAll<HTMLDetailsElement>('details.hapi-menu[open]')]
    const portalOwner = (target: EventTarget | null): HTMLDetailsElement | null => {
        if (!(target instanceof Element)) return null
        const owner = target.closest<HTMLElement>('[data-hapi-menu-owner]')?.dataset.hapiMenuOwner
        const menu = owner ? document.getElementById(owner) : null
        return menu?.matches('details.hapi-menu') ? menu as HTMLDetailsElement : null
    }
    const outside = (event: PointerEvent): void => {
        const owner = portalOwner(event.target)
        for (const menu of openMenus()) if (menu !== owner && (!(event.target instanceof Node) || !menu.contains(event.target))) menu.open = false
    }
    const choose = (event: MouseEvent): void => {
        if (!(event.target instanceof Element)) return
        const button = event.target.closest('button')
        const menu = button?.closest<HTMLDetailsElement>('details.hapi-menu') ?? portalOwner(event.target)
        if (menu && !button?.disabled) menu.open = false
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
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('click', choose)
    document.addEventListener('keydown', escape)
    return () => {
        document.removeEventListener('pointerdown', outside)
        document.removeEventListener('click', choose)
        document.removeEventListener('keydown', escape)
    }
}
