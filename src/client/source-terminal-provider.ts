/** The official ClientTerminals model receives one exact source-aware Remote adapter. */
import { Context, type Fiber } from '@deepseek-ai/cordis';
import type { Entry } from '@deepseek-ai/cordis-plugin-loader';
import type { TerminalRemote } from '@deepseek-ai/dsh-api-terminal-controller/client';
import { isSourceSessionId, parseSourceSessionId } from '../remote/protocol.ts';
import type { SourceTerminalApi } from '../workspace/terminal-api.ts';

export const SOURCE_TERMINAL_CONSUMER = '@deepseek-ai/dsh-api-terminal-controller';
export const SOURCE_TERMINAL_REALM = 'hhpi:source-terminal';
const service = 'remote.terminal';

/** Stream handles pass through by identity, preserving send(), cancellation and input-window acknowledgements. */
export function sourceTerminalRemote(ordinary: TerminalRemote, source: SourceTerminalApi): TerminalRemote {
    const route = (sessionId: string): TerminalRemote => {
        if (!isSourceSessionId(sessionId)) return ordinary;
        parseSourceSessionId(sessionId);
        return source;
    };
    return {
        environment: (sessionId, signal) => route(sessionId).environment(sessionId, signal),
        shells: (sessionId, signal) => route(sessionId).shells(sessionId, signal),
        list: sessionId => route(sessionId).list(sessionId),
        create: (sessionId, request, signal) => route(sessionId).create(sessionId, request, signal),
        retain: (sessionId, id, signal) => route(sessionId).retain(sessionId, id, signal),
        attach: (sessionId, id, signal) => route(sessionId).attach(sessionId, id, signal),
        rename: (sessionId, id, title) => route(sessionId).rename(sessionId, id, title),
        close: (sessionId, id) => route(sessionId).close(sessionId, id),
    };
}

/** Isolate only the official model's namespace dependency; its service, UI, stores and lifecycle stay official. */
export async function installSourceTerminalProvider(ctx: Context): Promise<() => Promise<void>> {
    const providers = new Map<symbol, Fiber>(), prior = new Map<Entry, Record<string, true | string> | null>();
    let stopped = false;
    const isolate = (entry: Entry): void => {
        if (entry.options.isolate?.[service] === SOURCE_TERMINAL_REALM) return;
        if (!prior.has(entry)) prior.set(entry, entry.options.isolate ? { ...entry.options.isolate } : null);
        entry.options.isolate = { ...entry.options.isolate, [service]: SOURCE_TERMINAL_REALM };
    };
    const provide = (entry: Entry): void => {
        const symbol = entry.context[Context.isolate][service];
        if (stopped || !symbol || providers.has(symbol)) return;
        providers.set(symbol, ctx.inject(['remote', service, 'remote.sourceTerminal'], async owner => {
            const adapter = sourceTerminalRemote(owner.remote.terminal, owner.remote.sourceTerminal);
            const provider = owner.isolate(service, symbol).plugin({ name: 'hhpi-terminal-remote', apply(scope: Context) {
                scope.reflect.provide(service, adapter);
            } });
            await provider;
            return async () => { await provider.dispose(); };
        }));
    };
    const stopHook = ctx.on('loader/patch-context', (entry, next) => {
        if (entry.options.name !== SOURCE_TERMINAL_CONSUMER) { next(); return; }
        isolate(entry); next(); provide(entry);
    }, { prepend: true });
    const stop = async (): Promise<void> => {
        if (stopped) return; stopped = true; stopHook();
        await Promise.all([...providers.values()].map(provider => provider.dispose()));
        const current = new Set(ctx.loader.entries());
        for (const [entry, isolation] of prior) {
            if (!current.has(entry) || entry.options.isolate?.[service] !== SOURCE_TERMINAL_REALM) continue;
            if (!entry.fiber) { if (isolation) entry.options.isolate = isolation; else delete entry.options.isolate; }
            else await entry.update({ isolate: isolation && Object.keys(isolation).length ? isolation : null });
        }
    };
    try {
        for (const entry of ctx.loader.entries()) {
            if (entry.options.name !== SOURCE_TERMINAL_CONSUMER) continue;
            if (!entry.fiber) { isolate(entry); continue; }
            if (entry.options.isolate?.[service] !== SOURCE_TERMINAL_REALM) {
                prior.set(entry, entry.options.isolate ? { ...entry.options.isolate } : null);
                await entry.update({ isolate: { ...entry.options.isolate, [service]: SOURCE_TERMINAL_REALM } });
            }
            provide(entry);
        }
        return stop;
    } catch (error) { await stop(); throw error; }
}
