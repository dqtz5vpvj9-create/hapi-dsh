import { z } from 'zod'
export const sourceDirectoryRequestSchema = z.strictObject({ machineId: z.string().min(1).max(512), path: z.string().min(1).max(8192), includeHidden: z.boolean().optional() })
export const sourceDirectorySchema = z.object({ entries: z.array(z.object({ name: z.string().min(1), type: z.enum(['file', 'directory', 'other']), isSymbolicLink: z.boolean().optional(), isGitRepo: z.boolean().optional() })) })
export const sourcePathsRequestSchema = z.strictObject({ machineId: z.string().min(1).max(512), paths: z.array(z.string().min(1).max(8192)).min(1).max(100) })
export const sourcePathsSchema = z.object({ exists: z.record(z.string(), z.boolean()), outsideWorkspaceRoots: z.array(z.string()).optional() })
export type SourceDirectoryRequest = z.infer<typeof sourceDirectoryRequestSchema>
export type SourceDirectory = z.infer<typeof sourceDirectorySchema>
export type SourcePathsRequest = z.infer<typeof sourcePathsRequestSchema>
export type SourcePaths = z.infer<typeof sourcePathsSchema>
