import { posix } from 'node:path'

/**
 * A source machine path as a local DSH Session header cwd.
 *
 * The official Session header requires a POSIX absolute path (`dsh-session`),
 * while a HAPI source machine may report a Windows drive path or UNC path. The
 * header cwd is a display/workspace anchor for a session that executes on the
 * source machine, so keep the path recognizable without pretending it is a
 * local POSIX path.
 * @param sourcePath - `metadata.path` of the HAPI source session.
 * @returns a POSIX absolute path.
 */
export function sessionHeaderCwd(sourcePath: string | null | undefined): string {
    const value = sourcePath?.trim()
    if (!value) return '/'
    if (posix.isAbsolute(value)) return value
    const drive = /^([A-Za-z]):[\\/](.*)$/.exec(value)
    if (drive) return posix.join(`/${drive[1]!.toUpperCase()}:`, ...drive[2]!.split(/[\\/]+/).filter(Boolean))
    if (/^[\\/]{2}/.test(value)) return posix.join('/unc', ...value.replace(/^[\\/]{2}/, '').split(/[\\/]+/).filter(Boolean))
    // A relative source path has no local absolute meaning; anchor it at root
    // so the header stays valid instead of rejecting the whole session.
    return posix.join('/', ...value.split(/[\\/]+/).filter(Boolean))
}
