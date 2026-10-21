/** Reserved display namespaces created by this plugin, including cold generations.
 * The namespace proves source ownership, never an executable source address.
 * Operations still resolve Hub/session/machine from the authoritative projection.
 */
export function isNativeDisplayId(id: string): boolean {
    return /^hapi-codex-[0-9a-f]{32}(?:-r[1-9][0-9]*)?(?:-child-[0-9a-f]{24})?$/.test(id)
}
export function isObservedDisplayId(id: string): boolean {
    return /^hapi-observed-[0-9a-f]{32}(?:-r[1-9][0-9]*)?(?:-child-[0-9a-f]{24})?$/.test(id)
}
export function isSourceDisplayId(id: string): boolean {
    return isNativeDisplayId(id) || isObservedDisplayId(id)
}
export function isSourceChildDisplayId(id: string): boolean {
    return /-child-[0-9a-f]{24}$/.test(id) && isSourceDisplayId(id)
}
