/** Build-time diagnostics for the exact source contracts used by the overlay. */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
const root = process.argv[2];
if (!root) throw new Error('A prepared DSH source directory is required.');
const files = await readdir(join(root, 'packages/client/ui-conversation/src/client'), { recursive: true });
for (const name of files.filter(name => /\.(ts|tsx)$/.test(name))) {
  const file = `packages/client/ui-conversation/src/client/${name}`;
  const content = await readFile(join(root, file), 'utf8');
  if (content.includes('class BoundConversation') || content.includes('cursor: String') || name.endsWith('assembler.ts')) {
    console.log(`::group::${file}\n${content}\n::endgroup::`);
  }
}
for (const file of [
  'packages/api/session-controller/src/client/contract/window-commit.ts',
  'packages/client/ui-conversation/src/client/conversation/history-view.ts',
  'packages/client/ui-conversation/src/client/contract/history-view.ts',
  'tsconfig.client.json',
]) console.log(`::group::${file}\n${await readFile(join(root, file), 'utf8')}\n::endgroup::`);
