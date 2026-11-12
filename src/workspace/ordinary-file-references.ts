/** Keep the official search owner/configuration; HHPI has its own source service. */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import FileReferenceService, { type FileReferenceCandidate } from '@deepseek-ai/dsh-file-reference'
import { officialProviderContext, officialProviderScope } from '../shared/official-provider.ts'
import { assertOrdinarySourceTarget } from '../shared/source-access.ts'

export class OrdinaryFileReferences extends FileReferenceService {
    static inject = ['loader']
    override list(agent: Agent, query: string, signal: AbortSignal): Promise<FileReferenceCandidate[]> {
        assertOrdinarySourceTarget(agent.id)
        const service = officialProviderContext(this.ctx, 'file-reference-local').get('fileReferences')
        if (!service) throw new Error('The official file-reference delegate is not active')
        return service.list(agent, query, signal)
    }
}

/** The original isolated package may become ready after this routing plugin. */
export default {
    inject: OrdinaryFileReferences.inject,
    apply(ctx: Context): void {
        let armed = false
        const arm = () => {
            if (armed) return
            const rows = [...ctx.loader.entries()].filter(entry => entry.options.id === 'file-reference-local'
                && entry.options.name === '@deepseek-ai/dsh-file-reference-local')
            const entry = rows[0]
            if (rows.length !== 1 || !entry || entry.disabled || entry.options.isolate?.fileReferences !== true) {
                throw new Error('The original file-reference-local package root must remain enabled in its own service isolate')
            }
            if (!entry.realm) return
            armed = true
            officialProviderScope(ctx, 'file-reference-local').inject(['fileReferences'], (ready: Context) => {
                const publicLabel = ctx[Context.isolate].fileReferences
                if (publicLabel === undefined) throw new Error('The public file-reference service scope is unavailable')
                ready.isolate('fileReferences', publicLabel).plugin(OrdinaryFileReferences)
            })
        }
        ctx.on('loader/patch-context', (entry, next) => { next(); if (entry.options.id === 'file-reference-local') arm() }, { global: true })
        arm()
    },
}
