import type { Context } from '@deepseek-ai/cordis'

/**
 * Optional Host services exposed on a source-owned Agent context.
 *
 * Source sessions announce themselves through the official `agents` service so
 * agent lifecycle listeners run for them. Those listeners are ordinary plugins
 * loaded in the profile and may use agent-scoped services such as
 * `systemPrompt`; a hand-built scope has no inject declaration for them, so the
 * property read would fail even though the Host provides the service.
 * @param ctx - the source agent's scoped Context.
 * @param parent - the scope parent Context that sees the Host services.
 * @returns a Context that also exposes the available services by property.
 */
export function withSourceAgentServices(ctx: Context, parent: Context): Context {
    const optional = ['systemPrompt'] as const
    const available: Record<string, unknown> = {}
    for (const name of optional) {
        const service = parent.get(name)
        if (service !== undefined) available[name] = service
    }
    return Object.keys(available).length > 0 ? ctx.extend(available) : ctx
}
