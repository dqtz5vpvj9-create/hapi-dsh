/** Read-only offline CLI. No credentials, configuration loading, network,
 * model invocation, source writes, or filesystem output. */
import { open } from 'node:fs/promises'

const help = `Usage: node --import tsx scripts/diagnose-source-history.ts <hapi-export.json|->
       node --import tsx scripts/diagnose-source-history.ts --native-pages <captured-pages.json|->

Reads the original HAPI v2 JSON export (100 MiB maximum) and writes only fixed
schema/category counts to stdout. Use - to read JSON from stdin.
--native-pages instead reads the explicit local {session,pages,requests?}
capture of original /sessions/:id/messages responses. It does not fetch them.
The input stays unchanged. No source content, IDs, paths or credentials are
printed, including on failure. Native Hub exports do not establish that the
native RPC history is complete. This does not verify the live renderer.
`
const args = process.argv.slice(2)
if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) process.stdout.write(help)
else {
    try {
        const { diagnoseSourceHistory, DiagnosticInputError, MAX_DIAGNOSTIC_INPUT_BYTES } = await import('./source-history-diagnostics.ts')
        const nativePages = args[0] === '--native-pages', filename = args[nativePages ? 1 : 0]
        if (args.length !== (nativePages ? 2 : 1) || !filename || filename.startsWith('--')) throw new DiagnosticInputError('invalid-arguments')
        const chunks: Buffer[] = []; let bytes = 0
        const consume = (chunk: Buffer | string): void => {
            const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
            bytes += data.byteLength
            if (bytes > MAX_DIAGNOSTIC_INPUT_BYTES) throw new DiagnosticInputError('input-too-large')
            chunks.push(data)
        }
        if (filename === '-') for await (const chunk of process.stdin) consume(chunk as Buffer)
        else {
            const file = await open(filename, 'r')
            try {
                const facts = await file.stat()
                if (!facts.isFile()) throw new DiagnosticInputError('input-unreadable')
                if (facts.size > MAX_DIAGNOSTIC_INPUT_BYTES) throw new DiagnosticInputError('input-too-large')
                for (;;) {
                    const chunk = Buffer.allocUnsafe(64 * 1024)
                    const { bytesRead } = await file.read(chunk, 0, chunk.length, null)
                    if (!bytesRead) break
                    consume(chunk.subarray(0, bytesRead))
                }
            } finally { await file.close() }
        }
        const json = Buffer.concat(chunks).toString('utf8')
        const report = nativePages ? (await import('./native-page-diagnostics.ts')).diagnoseNativePages(json) : diagnoseSourceHistory(json)
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    } catch (error) {
        // Never print Error.message/stack: JSON errors and fs errors include
        // source contents or the private input filename.
        const known = new Set(['input-unreadable', 'input-too-large', 'input-invalid-json', 'unsupported-export-envelope',
            'unsupported-export-version', 'invalid-session-schema', 'diagnostic-unavailable', 'invalid-arguments',
            'unsupported-native-pages-envelope', 'invalid-native-page-schema', 'invalid-native-requests-schema'])
        const candidate = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined
        const code = typeof candidate === 'string' && known.has(candidate) ? candidate : 'input-unreadable'
        process.stdout.write(`${JSON.stringify({ diagnosticVersion: 1, error: code })}\n`)
        process.exitCode = 2
    }
}
