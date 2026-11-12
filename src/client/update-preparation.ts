/** Public embedding contract: editors finish durable writes before a page update. */
export type WorkspaceCheckpointKind = 'message' | 'attachment' | 'document' | 'reading' | 'workspace';
export interface WorkspaceCheckpointParticipant {
    kind: WorkspaceCheckpointKind;
    label: string;
    /** A draft/reader revision, not source metadata or an operation receipt comparison. */
    revision(): string | number;
    current(): boolean;
    /** Sample the actual owner before freezing the revision; ordinary saves omit this. */
    capture?(signal: AbortSignal): void | Promise<void>;
    save(signal: AbortSignal): void | Promise<void>;
}
export interface WorkspaceUpdatePreparations {
    register(label: string, prepare: () => void | Promise<void>, phase?: 'prepare' | 'verify'): () => void;
    checkpoint(): Promise<void>;
    registerCheckpoint(participant: WorkspaceCheckpointParticipant): () => void;
}
export function createWorkspaceUpdatePreparations(options: { timeoutMs?: number } = {}): WorkspaceUpdatePreparations & { dispose(): void } {
    const entries = new Set<{ label: string; prepare: (signal: AbortSignal) => void | Promise<void>; phase: 'prepare' | 'verify' }>();
    const lifetime = new AbortController();
    let running: Promise<void> | undefined, disposed = false;
    const timeoutMs = options.timeoutMs ?? 15_000;
    const register = (label: string, prepare: (signal: AbortSignal) => void | Promise<void>, phase: 'prepare' | 'verify' = 'prepare') => {
        if (disposed) return () => {};
        const entry = { label, prepare, phase }; entries.add(entry); return () => { entries.delete(entry); };
    };
    return {
        register(label, prepare, phase = 'prepare') {
            return register(label, prepare, phase);
        },
        registerCheckpoint(participant) {
            let prepared: string | number | undefined;
            const validate = () => {
                if (!participant.current()) throw new Error('The original source or account changed. The page has not been updated.');
                if (prepared !== participant.revision()) throw new Error('The draft or reading position changed while saving. Review it and try the update again.');
            };
            const prepare = register(participant.label, async signal => {
                prepared = undefined;
                if (!participant.current()) throw new Error('The original source or account changed. The page has not been updated.');
                if (participant.capture) {
                    await participant.capture(signal);
                    signal.throwIfAborted();
                    if (!participant.current()) throw new Error('The original source or account changed. The page has not been updated.');
                }
                prepared = participant.revision();
                await participant.save(signal);
                signal.throwIfAborted(); validate();
            });
            const verify = register(participant.label, validate, 'verify');
            return () => { prepare(); verify(); };
        },
        checkpoint() {
            if (running) return running;
            running = (async () => {
                if (disposed) throw new Error('The workspace is closed.');
                const snapshot = [...entries];
                for (const phase of ['prepare', 'verify'] as const) {
                    const outcomes = await Promise.allSettled(snapshot.filter(entry => entry.phase === phase).map(async entry => {
                        let timer: ReturnType<typeof setTimeout> | undefined;
                        const attempt = new AbortController();
                        try {
                            await Promise.race([Promise.resolve().then(() => entry.prepare(AbortSignal.any([lifetime.signal, attempt.signal]))), new Promise<never>((_, reject) => {
                                timer = setTimeout(() => { attempt.abort(); reject(new Error('Saving has not finished. The current page and editors remain open; try again after the plugin responds.')); }, timeoutMs);
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
        dispose() { disposed = true; lifetime.abort(); entries.clear(); },
    };
}
