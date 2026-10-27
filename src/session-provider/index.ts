/**
 * Host half of the pre-UI source-session composition package.
 *
 * The client graph row exists because this package declares `dsh.client`.
 * The Host half intentionally owns no lifecycle or data; the authoritative
 * Session controller, HAPI bridge, and native execution remain unchanged.
 */
export const name = 'hapi-dsh-session-provider'
export function apply(): void {}
