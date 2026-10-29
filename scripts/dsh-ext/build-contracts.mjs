/** Compile real pinned production modules for in-process integration contracts. */
import { build } from 'esbuild';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT } from './prepare.mjs';
const source = process.argv[2];
if (!source) throw new Error('A prepared DSH source directory is required.');
await mkdir(join(ROOT, '.tmp'), { recursive: true });
const paths = {
  BoundHistoryView: 'packages/client/ui-conversation/src/client/conversation/history-view.ts',
  ConversationNodeAssembler: 'packages/client/ui-conversation/src/client/conversation/assembler.ts',
};
const contents = Object.entries(paths).map(([name, path]) => `export { ${name} } from ${JSON.stringify(join(source, path))};`).join('\n')
  + `\nexport * as windowCommit from ${JSON.stringify(join(source, 'packages/api/session-controller/src/client/sessions/window-commit.ts'))};`;
await build({ stdin: { contents, resolveDir: ROOT, loader: 'ts' }, outfile: join(ROOT, '.tmp/hhpi-official-contract.cjs'), bundle: true,
  platform: 'node', format: 'cjs', target: 'node24', packages: 'external', nodePaths: [join(ROOT, 'node_modules')],
  tsconfigRaw: { compilerOptions: { experimentalDecorators: true, useDefineForClassFields: true } } });
console.log('Compiled actual pinned BoundHistoryView, assembler and window coordinator.');
const contract = await readFile(join(source, 'packages/api/session-controller/src/client/sessions/window-commit.ts'), 'utf8');
console.log('::group::Official window coordinator'); console.log(contract); console.log('::endgroup::');
