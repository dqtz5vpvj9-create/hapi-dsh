/** Original HAPI schedule semantics: presets are resolved when Send is pressed. */
export const schedulePresets = ['+5m', '+30m', '+1h', '+4h'] as const;
export type SchedulePreset = typeof schedulePresets[number];
export type ScheduleSelection = { type: 'preset'; preset: SchedulePreset } | { type: 'absolute'; ms: number };
const delays: Record<SchedulePreset, number> = { '+5m': 300_000, '+30m': 1800_000, '+1h': 3600_000, '+4h': 14400_000 };
export function resolveSchedule(selection: ScheduleSelection, sendNow: number): number {
    return selection.type === 'preset' ? sendNow + delays[selection.preset] : selection.ms;
}
export function scheduleError(value: number, now: number): 'invalid' | 'past' | 'too-far' | null {
    if (!Number.isSafeInteger(value) || value <= 0) return 'invalid';
    if (value < now - 30_000) return 'past';
    if (value > now + 7 * 86400_000) return 'too-far';
    return null;
}
export function readScheduleSelection(value: unknown, legacyDate?: string): ScheduleSelection {
    if (value && typeof value === 'object') {
        const item = value as { type?: unknown; preset?: unknown; ms?: unknown };
        if (item.type === 'preset' && schedulePresets.includes(item.preset as SchedulePreset)) return { type: 'preset', preset: item.preset as SchedulePreset };
        if (item.type === 'absolute' && typeof item.ms === 'number' && Number.isSafeInteger(item.ms)) return { type: 'absolute', ms: item.ms };
    }
    const previous = legacyDate ? new Date(legacyDate).getTime() : NaN;
    return Number.isFinite(previous) ? { type: 'absolute', ms: previous } : { type: 'preset', preset: '+5m' };
}
export function persistSchedule(storage: Pick<Storage, 'getItem' | 'setItem'> | undefined, key: string, value: unknown): boolean {
    try {
        if (!storage) return false;
        const encoded = JSON.stringify(value); storage.setItem(key, encoded);
        return storage.getItem(key) === encoded;
    } catch { return false; }
}
