import type { SourceApproval, SourceOperation } from '../remote/protocol.ts'
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
export type SimpleApprovalDecision = NonNullable<SourceOperation['decision']>
export function simpleApprovalDecisions(request: SourceApproval): readonly SimpleApprovalDecision[] {
    if (!['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(request.method)) return []
    const available = request.params.availableDecisions
    const decisions: readonly SimpleApprovalDecision[] = ['accept', 'acceptForSession', 'decline', 'cancel']
    return Array.isArray(available) ? decisions.filter(value => available.includes(value)) : ['accept', 'decline']
}
/** Render source-declared permission scope without turning an unknown profile into a blanket grant. */
export function nativePermissionDescriptions(value: unknown, zh: boolean): readonly string[] {
    if (!object(value)) return []
    const descriptions: string[] = []
    const network = value.network
    if (object(network) && network.enabled === true) descriptions.push(zh ? '允许网络访问' : 'Network access')
    const fs = value.fileSystem
    if (object(fs)) {
        for (const [key, label] of [['read', zh ? '读取' : 'Read'], ['write', zh ? '写入' : 'Write']] as const) {
            if (Array.isArray(fs[key])) for (const path of fs[key]) if (typeof path === 'string') descriptions.push(`${label}: ${path}`)
        }
        if (Array.isArray(fs.entries)) for (const entry of fs.entries) {
            if (!object(entry) || !object(entry.path)) continue
            const special = object(entry.path.value) ? entry.path.value : null
            const roots: Record<string, string> = { root: zh ? '整个文件系统' : 'Entire filesystem', minimal: zh ? '最小系统路径' : 'Minimal system paths', project_roots: zh ? '项目根目录' : 'Project roots', tmpdir: zh ? '系统临时目录' : 'System temporary directory', slash_tmp: '/tmp' }
            const path = entry.path, location = typeof path.path === 'string' ? path.path : typeof path.pattern === 'string' ? path.pattern
                : special ? `${roots[String(special.kind)] ?? (typeof special.path === 'string' ? special.path : zh ? '原生特殊路径（见技术详情）' : 'Native special path (see details)')}${typeof special.subpath === 'string' ? ` / ${special.subpath}` : ''}`
                : zh ? '原生特殊路径（见技术详情）' : 'Native special path (see details)'
            const access = entry.access === 'read' ? zh ? '读取' : 'Read' : entry.access === 'write' ? zh ? '写入' : 'Write' : entry.access === 'deny' ? zh ? '禁止访问' : 'Deny access' : String(entry.access ?? '')
            descriptions.push(`${access}: ${location}`)
        }
    }
    return descriptions
}
