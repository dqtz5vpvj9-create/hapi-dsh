import type { TestContext } from 'node:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runOfflineMigration, type OfflineRequest, type OfflineStage } from '../../scripts/migrations/hapi-offline/index.ts'
export async function offlineDomainFixture(t: TestContext, values: Record<string, unknown>, stage: OfflineStage) {
    const root = await mkdtemp('/mnt/cache/data-cache/hhpi-offline-domain-'), snapshot = join(root, 'snapshot'), output = join(root, 'recovery')
    t.after(() => rm(root, { recursive: true, force: true })); await mkdir(snapshot)
    const inputs: OfflineRequest['snapshot']['inputs'] = []
    for (const [id, value] of Object.entries(values)) {
        const binary = Buffer.isBuffer(value), path = `${inputs.length}.${binary ? 'bin' : 'json'}`
        await writeFile(join(snapshot, path), binary ? value : JSON.stringify(value))
        inputs.push({ id, path, format: binary ? 'binary' : 'json', version: 'synthetic-schema-fixture' })
    }
    const request: OfflineRequest = { version: 1, packageId: 'synthetic-domain-package', scope: 'account-a-origin-a', snapshot: { id: 'synthetic-domain-snapshot', root: snapshot, inputs }, requiredStages: [{ id: stage.id, version: stage.version }] }
    const index = await runOfflineMigration(request, output, [stage])
    const objects = await Promise.all(index.objects.map(async row => ({ ...row, body: JSON.parse(await readFile(join(output, row.file), 'utf8')) as { value: { original?: unknown; converted?: unknown; disposition?: string; blockers?: string[]; counts?: unknown } } })))
    return { root, snapshot, output, request, index, objects }
}
