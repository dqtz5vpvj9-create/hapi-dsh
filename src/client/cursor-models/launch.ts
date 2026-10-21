import type { SourceMachineOptions } from '../../source-machine-types.ts'
import { buildCursorEffortPickerOptions, resolveCursorVariantOptions } from './catalog.ts'
import { buildCursorCatalogFromSources, buildCursorPickerState, normalizeCursorPickerWireId, resolveCursorBaseFromWire, resolveWireIdForBaseChange } from './picker.ts'

/** A stale form value must never extend the advertised Runner catalog. The
 * explicit custom-ID control remains the escape hatch for uncatalogued IDs. */
export function cursorLaunchPicker(options: SourceMachineOptions | null, model: string, selectedBase?: string) {
    const catalog = buildCursorCatalogFromSources({ sessionModels: [],
        machineModels: (options?.models ?? []).map(row => ({ modelId: row.id, name: row.name })),
        cliModelSkus: options?.cliModelSkus ?? [],
    })
    const wire = normalizeCursorPickerWireId(model) ?? 'auto'
    const picker = buildCursorPickerState({ catalog, currentWireId: wire })
    const base = selectedBase ?? resolveCursorBaseFromWire(wire, catalog)
    const variants = buildCursorEffortPickerOptions(resolveCursorVariantOptions(base === 'auto' ? null : base, catalog))
    // An existing, still-advertised ACP wire is also an exact source choice.
    // Keep it selectable while newer CLI SKU labels are available alongside it.
    if (wire !== 'auto' && catalog.wireToBase.get(wire) === base && !variants.some(row => row.value === wire)) {
        variants.unshift({ value: wire, label: wire })
    }
    const unavailable = wire !== 'auto' && !catalog.wireToBase.has(wire)
        || base !== 'auto' && !catalog.variantsByBase.has(base)
    const pendingVariant = base !== 'auto' && catalog.wireToBase.get(wire) !== base
    return { ...picker, base, wire, variants, unavailable, pendingVariant,
        modelValue: picker.mode === 'dual' ? base : wire,
        variantValue: variants.some(row => row.value === wire) ? wire : '',
    }
}

/** Selecting a base with multiple choices never silently picks an effort or
 * speed. The separate persisted base keeps an unfinished choice across reload. */
export function chooseCursorLaunchModel(picker: ReturnType<typeof cursorLaunchPicker>, value: string) {
    if (picker.mode === 'flat') return { model: value, cursorBase: resolveCursorBaseFromWire(value, picker.catalog) }
    return { model: resolveWireIdForBaseChange(value, picker.catalog) ?? '', cursorBase: value }
}
