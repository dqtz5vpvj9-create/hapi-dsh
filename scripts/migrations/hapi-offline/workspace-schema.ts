/** HAPI workspace v2 wire format, retained for importing existing windows without dropping resources.
 * Adapted from HAPI shared/src/{workspaces,documents}.ts at 0f8ef697. SPDX-License-Identifier: AGPL-3.0-only
 */
import { z } from 'zod';

const id = z.string().min(1).max(256);
export const legacyDocumentRefSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('file'), path: z.string().min(1).max(8192), machineId: id.optional() }).strict(),
    z.object({ kind: z.literal('artifact'), artifactId: z.string().min(1).max(8192), fileName: z.string().max(1024), mimeType: z.string().max(256) }).strict(),
]);
export type LegacyDocumentRef = z.infer<typeof legacyDocumentRefSchema>;
export const legacyPaneResourceSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('empty') }).strict(),
    z.object({ kind: z.literal('chat'), sessionId: id }).strict(),
    z.object({ kind: z.literal('terminal'), sessionId: id, terminalId: id }).strict(),
    z.object({ kind: z.literal('document'), sessionId: id, document: legacyDocumentRefSchema }).strict(),
]);
export type LegacyPaneResource = z.infer<typeof legacyPaneResourceSchema>;
export type LegacyWorkspaceNode = { type: 'pane'; id: string; resource: LegacyPaneResource }
    | { type: 'split'; id: string; axis: 'horizontal' | 'vertical'; children: LegacyWorkspaceNode[]; weights: number[] };
export interface LegacyWorkspaceSnapshot {
    schemaVersion: 2;
    revision: number;
    workspaces: Array<{ id: string; name: string; autoName?: boolean | undefined; root: LegacyWorkspaceNode }>;
}
const node: z.ZodType<LegacyWorkspaceNode> = z.lazy(() => z.discriminatedUnion('type', [
    z.object({ type: z.literal('pane'), id, resource: legacyPaneResourceSchema }).strict(),
    z.object({ type: z.literal('split'), id, axis: z.enum(['horizontal', 'vertical']),
        children: z.array(node).min(2).max(128), weights: z.array(z.number().positive().finite()).min(2).max(128) })
        .strict().refine(value => value.children.length === value.weights.length, 'A split needs one weight for each child'),
]));
const snapshot = z.object({ schemaVersion: z.literal(2), revision: z.number().int().nonnegative(),
    workspaces: z.array(z.object({ id, name: z.string().min(1).max(200), autoName: z.boolean().optional(), root: node }).strict()).max(256),
}).strict();
export const legacyWorkspaceSnapshotSchema: z.ZodType<LegacyWorkspaceSnapshot> = z.unknown().transform((value, context) => {
    let count = 0;
    const bounded = (input: unknown, depth: number): boolean => {
        if (depth > 32 || ++count > 8192) return false;
        if (!input || typeof input !== 'object' || !('children' in input)) return true;
        return !Array.isArray(input.children) || input.children.every(child => bounded(child, depth + 1));
    };
    if (value && typeof value === 'object' && 'workspaces' in value && Array.isArray(value.workspaces)
        && !value.workspaces.every(window => bounded(window?.root, 0))) {
        context.addIssue({ code: 'custom', message: 'Existing workspace geometry exceeds supported bounds' });
        return z.NEVER;
    }
    const parsed = snapshot.safeParse(value);
    if (!parsed.success) { context.addIssue({ code: 'custom', message: 'The source workspace is not a valid HAPI v2 snapshot' }); return z.NEVER; }
    const ids = new Set<string>();
    const visit = (value: { id: string; children?: LegacyWorkspaceNode[] }): boolean => {
        if (ids.has(value.id)) return false;
        ids.add(value.id);
        return value.children?.every(visit) ?? true;
    };
    if (!parsed.data.workspaces.every(window => visit(window) && visit(window.root))) {
        context.addIssue({ code: 'custom', message: 'Existing workspace identities are not unique' }); return z.NEVER;
    }
    return parsed.data;
});
