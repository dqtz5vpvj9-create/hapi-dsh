/** Public embedding contract: editors finish durable writes before a page update. */
export interface WorkspaceUpdatePreparations {
    register(label: string, prepare: () => void | Promise<void>, phase?: 'prepare' | 'verify'): () => void;
    checkpoint(): Promise<void>;
}
export function createWorkspaceUpdatePreparations(options: { timeoutMs?: number } = {}): WorkspaceUpdatePreparations & { dispose(): void } {
    const entries = new Set<{ label: string; prepare: () => void | Promise<void>; phase: 'prepare' | 'verify' }>();
    let running: Promise<void> | undefined, disposed = false;
    const timeoutMs = options.timeoutMs ?? 15_000;
    return {
        register(label, prepare, phase = 'prepare') {
            if (disposed) return () => {};
            const entry = { label, prepare, phase }; entries.add(entry); return () => { entries.delete(entry); };
        },
        checkpoint() {
            if (running) return running;
            running = (async () => {
                if (disposed) throw new Error('The workspace is closed.');
                const snapshot = [...entries];
                for (const phase of ['prepare', 'verify'] as const) {
                    const outcomes = await Promise.allSettled(snapshot.filter(entry => entry.phase === phase).map(async entry => {
                        let timer: ReturnType<typeof setTimeout> | undefined;
                        try {
                            await Promise.race([Promise.resolve().then(() => entry.prepare()), new Promise<never>((_, reject) => {
                                timer = setTimeout(() => reject(new Error('Saving has not finished. The current page and editors remain open; try again after the plugin responds.')), timeoutMs);
                            })]);
                        } catch (error) { throw new Error(`${entry.label}: ${error instanceof Error ? error.message : String(error)}`); }
                        finally { clearTimeout(timer); }
                    }));
                    const failures = outcomes.flatMap(result => result.status === 'rejected' ? [result.reason as Error] : []);
                    if (failures.length) throw new Error(failures.map(error => error.message).join('\n'));
                    if (disposed || snapshot.some(entry => !entries.has(entry)) || [...entries].some(entry => !snapshot.includes(entry))) throw new Error('The open views changed while saving. Review the workspace and try the update again.');
                }
            })().finally(() => { running = undefined; });
            return running;
        },
        dispose() { disposed = true; entries.clear(); },
    };
}
