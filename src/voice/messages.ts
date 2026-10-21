/** Adapted from HAPI 0f8ef697 shared/src/messages.ts; AGPL-3.0-only. */
export function isObject(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
interface RoleRecord { role: string; content: unknown; meta?: unknown }
function roleRecord(value: unknown): value is RoleRecord { return isObject(value) && typeof value.role === 'string' && 'content' in value; }
export function unwrapRoleWrappedRecordEnvelope(value: unknown): RoleRecord | null {
    if (roleRecord(value)) return value;
    if (!isObject(value)) return null;
    if (roleRecord(value.message)) return value.message;
    if (isObject(value.data) && roleRecord(value.data.message)) return value.data.message;
    if (isObject(value.payload) && roleRecord(value.payload.message)) return value.payload.message;
    return null;
}
