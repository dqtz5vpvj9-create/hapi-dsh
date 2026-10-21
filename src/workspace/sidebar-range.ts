/** Original HAPI recent window budget: two viewport lengths in each direction. */
export type SidebarWindowRange = { startIndex: number; endIndex: number; overscan: number; count: number }
export function sidebarWindowRange(range: SidebarWindowRange, pins: readonly number[] = []): number[] {
    // Reuse the clipped edge budget without mounting an entire expanded tree.
    const count = Math.min(range.count, range.endIndex - range.startIndex + 1 + range.overscan * 2)
    const start = Math.max(0, Math.min(range.startIndex - range.overscan, range.count - count))
    return [...new Set([...Array.from({ length: Math.max(0, count) }, (_, offset) => start + offset), ...pins.filter(index => Number.isInteger(index) && index >= 0 && index < range.count)])].sort((a, b) => a - b)
}
