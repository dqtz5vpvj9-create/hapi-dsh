/** Independent offline entry point. No Hub client, product owner or runtime registration. */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { RecoveryPackage, SnapshotReader, offlineRequestSchema, type OfflineRequest, type RecoveryIndex } from './common.ts'
export * from './common.ts'

export interface OfflineStage {
    id: string; version: string
    /** Persist selected input roles/exact mapping so recovery cannot silently change targets. */
    configuration?: unknown
    run(context: { snapshot: SnapshotReader; recovery: RecoveryPackage; request: OfflineRequest }): Promise<void>
}
export async function runOfflineMigration(input: unknown, output: string, stages: readonly OfflineStage[] = []): Promise<RecoveryIndex> {
    const request = offlineRequestSchema.parse(input), recovery = await RecoveryPackage.open(output, request)
    try {
        if (!recovery.hasSnapshot()) {
            const source = await SnapshotReader.open(request.snapshot.root, request.snapshot.inputs)
            await recovery.capture(source)
        }
        const snapshot = await recovery.snapshot()
        for (const selected of request.requiredStages) {
            const stage = stages.find(value => value.id === selected.id && value.version === selected.version)
            if (!stage) continue
            if (stage.configuration !== undefined) recovery.stageConfiguration(stage.id, stage.configuration)
            if (recovery.stage(selected.id)?.state === 'complete') continue
            recovery.stageState(stage.id, stage.version, 'running')
            try { await stage.run({ snapshot, recovery, request }); recovery.stageState(stage.id, stage.version, 'complete') }
            catch (cause) { recovery.stageState(stage.id, stage.version, 'failed', cause instanceof Error ? cause.message : String(cause)); await recovery.writeIndex(); throw cause }
        }
        return recovery.resume()
    } catch (cause) { await recovery.writeIndex(); throw cause }
    finally { recovery.close() }
}
export async function resumeOfflineRecovery(output: string): Promise<RecoveryIndex> {
    const recovery = await RecoveryPackage.open(output)
    try { return await recovery.resume() } finally { recovery.close() }
}
export async function main(args: readonly string[]): Promise<void> {
    const [command, ...options] = args
    const value = (name: string) => { const at = options.indexOf(name); const result = at < 0 ? undefined : options[at + 1]; if (!result || result.startsWith('--')) throw new Error(`Specify ${name}.`); return result }
    if (!['capture', 'resume'].includes(command ?? '')) throw new Error('Usage: index.ts capture --request FILE --output DIRECTORY | resume --output DIRECTORY')
    const output = value('--output'), index = command === 'capture'
        ? await runOfflineMigration(JSON.parse(await readFile(value('--request'), 'utf8')), output) : await resumeOfflineRecovery(output)
    process.stdout.write(`${JSON.stringify({ packageId: index.packageId, status: index.status, inputs: index.inputs.length, objects: index.objects.length, unresolved: index.unresolved })}\n`)
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    void main(process.argv.slice(2)).catch(() => { process.stderr.write('Offline recovery did not complete. Inspect the private package index and original inputs; no source operation was dispatched.\n'); process.exitCode = 1 })
}
