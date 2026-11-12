/** Preserve the official ordinary DSH namespace without a native-source fallback. */
import type { Context } from '@deepseek-ai/cordis'
import { WorkspaceFiles, type Config, type WorkspaceFileScope } from '@deepseek-ai/dsh-api-workspace-files'
import type { WorkspaceByteReadOptions, WorkspaceDirectoryListing, WorkspaceFileBytes, WorkspaceFileRange,
    WorkspaceFileStat, WorkspaceFileText, WorkspaceFileWatchFrame } from '@deepseek-ai/dsh-api-workspace-files/types'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { officialProviderContext } from '../shared/official-provider.ts'
import { assertOrdinarySourceTarget } from '../shared/source-access.ts'

export class OrdinaryWorkspaceFiles extends TypertRemoteService {
    static inject = ['loader']
    static Config = WorkspaceFiles.Config
    constructor(ctx: Context, _config: Config) { super(ctx, 'workspaceFiles') }
    private delegate(scope: WorkspaceFileScope): WorkspaceFiles {
        assertOrdinarySourceTarget(scope.sessionId)
        const service = officialProviderContext(this.ctx, 'workspace-files').get('workspaceFiles')
        if (!service) throw new Error('The official WorkspaceFiles delegate is not active')
        return service
    }
    @Remote
    read(scope: WorkspaceFileScope, path: string, range: WorkspaceFileRange, signal: AbortSignal): Promise<WorkspaceFileText> {
        return this.delegate(scope).read(scope, path, range, signal)
    }
    @Remote
    readBytes(scope: WorkspaceFileScope, path: string, options: WorkspaceByteReadOptions, signal: AbortSignal): Promise<WorkspaceFileBytes> {
        return this.delegate(scope).readBytes(scope, path, options, signal)
    }
    @Remote
    stat(scope: WorkspaceFileScope, path: string, signal: AbortSignal): Promise<WorkspaceFileStat> {
        return this.delegate(scope).stat(scope, path, signal)
    }
    @Remote
    list(scope: WorkspaceFileScope, path: string, signal: AbortSignal): Promise<WorkspaceDirectoryListing> {
        return this.delegate(scope).list(scope, path, signal)
    }
    @Remote({ mode: 'stream' })
    changes(scope: WorkspaceFileScope, path: string, signal: AbortSignal): AsyncIterable<WorkspaceFileWatchFrame> {
        return this.delegate(scope).changes(scope, path, signal)
    }
}
export default OrdinaryWorkspaceFiles
