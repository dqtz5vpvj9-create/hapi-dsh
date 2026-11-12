/** Plain source references also used by offline protocol/adapter consumers. */
export function selectionQuote(path: string, quote: string, version?: string): string {
    return `[选区引用 / Document selection]\nSource: ${path}\nRevision: ${version ?? 'not reported'}\n${quote.split('\n').map(line => `> ${line}`).join('\n')}\n`
}
