import { readFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService, type Principal } from '@deepseek-ai/dsh-typert-protocol'
import type { AppServiceContext, AppSourceRoute } from './app-service-types.ts'
import { SourceAliasIndex, sourceAliasDocumentSchema, type SourceAliasResolution } from './source-aliases.ts'
import { sourceAliasRequestSchema } from './source-alias-api.ts'
import type { z } from 'zod'

declare module '@deepseek-ai/cordis' { interface Context { sourceAliases: SourceAliasService } }

/** Loading a finite operator-installed alias file never contacts a retired Hub. */
export class SourceAliasService extends TypertRemoteService {
    private readonly lifetime = new AbortController()
    constructor(ctx: Context, private readonly options: {
        path: string
        context(principal: Principal): AppServiceContext
        locate(source: AppSourceRoute, principal: Principal, signal: AbortSignal): Promise<AppSourceRoute | null>
    }) {
        super(ctx, 'sourceAliases')
        ctx.effect(() => () => this.lifetime.abort(), 'hhpi: offline source aliases')
    }
    @Remote('resolve')
    async resolve(raw: z.infer<typeof sourceAliasRequestSchema>, signal?: AbortSignal): Promise<SourceAliasResolution> {
        const invocation = this.ctx.invocation
        if (!invocation) throw new RemoteError('remote-access/denied', 'An authenticated application connection is required.', { action: 'sourceAliases', reason: 'no-allow' })
        const request = sourceAliasRequestSchema.parse(raw), principal = invocation.peer.principal
        const lifetime = AbortSignal.any([this.lifetime.signal, invocation.signal, invocation.peer.signal, ...(signal ? [signal] : [])])
        lifetime.throwIfAborted()
        const context = this.options.context(principal)
        let value: unknown
        try { value = JSON.parse(await readFile(this.options.path, { encoding: 'utf8', signal: lifetime })) }
        catch (error) {
            lifetime.throwIfAborted()
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'unmapped', recovery: [] }
            throw error
        }
        const document = sourceAliasDocumentSchema.parse(value)
        if (document.scope.accountId !== context.scope.accountId || document.scope.origin !== context.scope.origin) return { status: 'scope-invalid' }
        const index = new SourceAliasIndex(document, context.scope)
        return index.resolve(request.reference, {
            scope: context.scope, current: () => !lifetime.aborted,
            authorize: async source => { await context.authorizeSource(source); return true },
            locate: source => this.options.locate(source, principal, lifetime),
        }, lifetime)
    }
}
