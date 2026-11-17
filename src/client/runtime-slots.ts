/** Use the installed extension's Slot core alongside its renderer, even when
 * the enclosing DSH shell still embeds an older platform seed. */
type OfficialSlots = typeof import('@deepseek-ai/dsh-client-ui-slots')
declare const __HAPI_DSH_OFFICIAL_SLOTS_SOURCE__: string
export const GRAPH_SLOTS_MODULE = '@deepseek-ai/dsh-client-ui-slots'
export function createGraphSlots(source = __HAPI_DSH_OFFICIAL_SLOTS_SOURCE__): OfficialSlots {
    return new Function(`${source}\nreturn __HAPI_DSH_OFFICIAL_SLOTS__;\n//# sourceURL=hhpi-official-slots.js`)() as OfficialSlots
}
