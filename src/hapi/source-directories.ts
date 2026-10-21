import { z } from 'zod'
import { HapiRequestError } from '../codex/contracts.ts'
import { sourceDirectoryRequestSchema, sourceDirectorySchema, sourcePathsRequestSchema, sourcePathsSchema, type SourceDirectoryRequest, type SourceDirectory, type SourcePathsRequest, type SourcePaths } from '../source-directory-types.ts'
import type { HapiClient } from './client.ts'
const response = sourceDirectorySchema.partial().extend({ success: z.boolean(), error: z.string().optional() })
export async function sourceDirectory(client: Pick<HapiClient, 'request'>, input: SourceDirectoryRequest): Promise<SourceDirectory> {
    const request = sourceDirectoryRequestSchema.parse(input)
    const result = response.parse(await client.request(`/api/machines/${encodeURIComponent(request.machineId)}/list-directory`, {
        method: 'POST', body: { path: request.path, includeHidden: request.includeHidden === true },
    }))
    if (!result.success) throw new HapiRequestError(result.error ?? 'The source Runner could not list this directory', 'rejected', 400)
    return { entries: (result.entries ?? []).filter(entry => !/[\\/\0]/.test(entry.name) && entry.name !== '.' && entry.name !== '..') }
}
export async function sourcePaths(client: Pick<HapiClient, 'request'>, input: SourcePathsRequest): Promise<SourcePaths> {
    const request = sourcePathsRequestSchema.parse(input)
    return sourcePathsSchema.parse(await client.request(`/api/machines/${encodeURIComponent(request.machineId)}/paths/exists`, { method: 'POST', body: { paths: request.paths } }))
}
