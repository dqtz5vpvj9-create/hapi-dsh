/** One-time, source-only edits for the failures from integration run 40911449889. */
import assert from 'node:assert/strict';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
const parent = execFileSync('git', ['rev-parse', 'HEAD^'], { encoding: 'utf8' }).trim();
assert.equal(parent, 'bb7b3e24cda57160389334dbe4f8af65b352d029', 'This source edit is bound to its reviewed parent.');
async function replace(path, before, after) {
  const text = await readFile(path, 'utf8');
  assert.equal(text.split(before).length, 2, `Expected one source match in ${path}`);
  await writeFile(path, text.replace(before, after));
}
await replace('src/client/remote-history.ts', 'present = new Set(entries.map(entry => entry.event.seq))', 'present = new Set<number>(entries.map(entry => entry.event.seq))');
await replace('tests/codex-session-controller.test.ts', "assert.deepEqual(NativeAwareSessionController.inject, ['loader', 'hapi'])", "assert.deepEqual(NativeAwareSessionController.inject, ['loader'], 'HAPI is an optional source; the ordinary controller must start without it')");
const paths = [
  'tests/client-native-late-merge.test.ts', 'tests/codex-history-cache.test.ts',
  'tests/codex-native.test.ts', 'tests/hapi-agent.test.ts',
  'tests/hapi-catalog-startup.test.ts', 'tests/hapi-native-library.test.ts',
  'tests/hapi-sidechains.test.ts', 'tests/fixtures/source-event-queue.ts',
  'tests/source-window-attachments.test.ts',
];
for (const path of paths) {
  let text = await readFile(path, 'utf8');
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true), edits = [];
  let joinRequired = false;
  const visit = node => {
    if (ts.isStringLiteral(node) && (node.text === '/mnt/cache/data-cache' || node.text.startsWith('/mnt/cache/data-cache/'))) {
      const suffix = node.text.slice('/mnt/cache/data-cache'.length).replace(/^\//, '');
      assert.ok(!suffix.includes('..'), `Unexpected temporary path in ${path}`);
      joinRequired ||= suffix.length > 0;
      edits.push({ start: node.getStart(source), end: node.end,
        text: suffix ? `testTemporaryJoin(testTemporaryRoot(), ${JSON.stringify(suffix)})` : 'testTemporaryRoot()' });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(edits.length > 0, `No reviewed temporary directory found in ${path}`);
  assert.ok(!text.includes('testTemporaryRoot'), `Temporary alias already exists in ${path}`);
  for (const edit of edits.sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  text = "import { tmpdir as testTemporaryRoot } from 'node:os'\n" + (joinRequired ? "import { join as testTemporaryJoin } from 'node:path'\n" : '') + text;
  await writeFile(path, text);
}
const doctorPath = 'tests/host-bundle-doctor.test.ts';
await replace(doctorPath, "createHarness, repositoryRoot, seedProfile", "createHarness, seedProfile");
await replace(doctorPath, "const TOKEN = 'doctor-secret-token-value'", "import { createDoctorPackage } from './fixtures/doctor-package.ts'\n\nconst TOKEN = 'doctor-secret-token-value'");
await replace(doctorPath, 'async function runDoctor(harness: Harness): Promise<DoctorResult>', 'async function runDoctor(harness: Harness, packageRoot?: string): Promise<DoctorResult>');
await replace(doctorPath, 'packageRoot: repositoryRoot,', 'packageRoot: packageRoot ?? await createDoctorPackage(harness.root),');
await writeFile(doctorPath, await readFile(doctorPath, 'utf8') + `
// The package fixture is an IO boundary only; missing artifacts still fail.
test('doctor rejects a missing browser artifact without relying on a repository build', async () => {
    const harness = await createHarness()
    try {
        await seedProfile(harness.dshHome, harness.profile)
        assert.equal((await harness.install('a')).ok, true)
        const packageRoot = await createDoctorPackage(harness.root)
        await rm(join(packageRoot, 'dist', 'client.js'))
        const result = await runDoctor(harness, packageRoot)
        assert.equal(check(result, 'bundle-artifacts').status, 'fail')
        assert.equal(result.ok, false)
    } finally {
        await rm(harness.root, { recursive: true, force: true })
    }
})
`);
await unlink('.github/workflows/hhpi-baseline-fix-once.yml');
await unlink('scripts/hhpi-baseline-fix-once.mjs');
