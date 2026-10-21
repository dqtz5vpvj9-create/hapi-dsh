export interface SourceCatalogStartup {
    name: string;
    start(): Promise<void>;
}

/** The Host becomes usable while the complete original catalog keeps importing. */
export async function startSourceCatalogs(
    sources: readonly SourceCatalogStartup[],
    onError: (source: string, error: unknown) => void,
    budgetMs = 5_000,
): Promise<'ready' | 'background'> {
    if (!Number.isFinite(budgetMs) || budgetMs < 0) throw new Error('The source catalog startup budget must be a finite nonnegative duration.');
    const completed = Promise.all(sources.map(source => Promise.resolve().then(() => source.start()).catch(error => {
        onError(source.name, error);
    }))).then(() => 'ready' as const);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([completed, new Promise<'background'>(resolve => { timer = setTimeout(() => { resolve('background'); }, budgetMs); })]);
    } finally { if (timer !== undefined) clearTimeout(timer); }
}
