/** Build-time diagnostics for the exact source contracts used by the overlay. */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
const root = process.argv[2];
if (!root) throw new Error('A prepared DSH source directory is required.');
for (const file of [
  'packages/client/ui-chat/src/client/chat/use-chat-navigation.ts',
  'packages/client/ui-conversation/src/client/contract/history-view.ts',
  'packages/client/ui-conversation/src/client/conversation/bound-conversation.ts',
  'packages/client/ui-conversation/src/client/conversation/assembler.ts',
  'packages/api/session-controller/src/client/contract/window-commit.ts',
]) {
  const content = await readFile(join(root, file), 'utf8');
  console.log(`::group::${file}`);
  console.log(content);
  console.log('::endgroup::');
}
for (const file of ['package.json', 'tsconfig.client.json', 'packages/client/ui-chat/tsconfig.json', 'packages/api/session-controller/tsdown.config.ts']) {
  try { console.log(`::group::${file}\n${await readFile(join(root, file), 'utf8')}\n::endgroup::`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
