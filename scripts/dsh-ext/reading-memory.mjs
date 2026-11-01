/** Optional external scroll memory for the official reader; native in-memory behavior remains the default. */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import ts from 'typescript';

export async function applyReadingMemory(root) {
  const contract = 'packages/client/ui-chat/src/client/contract/reading-memory.ts';
  await writeFile(join(root, contract), `import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ChatScrollPosition } from './slots.ts'

/** A hosting shell may persist semantic reading positions in its authenticated storage scope. */
export interface ChatScrollMemoryV1 {
  forBinding(binding: SessionBinding): {
    read(): ChatScrollPosition | null
    save(position: ChatScrollPosition | null): void
  } | undefined
}
declare module '@deepseek-ai/cordis' {
  interface Context { chatScrollMemory: ChatScrollMemoryV1 }
}
export function readingMemoryEnabled(): boolean {
  return Reflect.get(globalThis, '__DSH_CLIENT_READING_MEMORY') !== 'off'
    && process.env.DSH_CLIENT_READING_MEMORY !== 'off'
}
`);
  const path = join(root, 'packages/client/ui-chat/src/client/apply.ts');
  let text = await readFile(path, 'utf8');
  const changes = [
    ['const scrollKey = binding.viewId === undefined ? sessionId : JSON.stringify([sessionId, binding.viewId])', "const scrollKey = binding.viewId === undefined ? sessionId : JSON.stringify([sessionId, binding.viewId])\n        const durableScroll = readingMemoryEnabled() ? ctx.get('chatScrollMemory')?.forBinding(binding) : undefined"],
    ['if (position === null) chatScrollPositions.delete(scrollKey)', 'durableScroll?.save(position)\n              if (position === null) chatScrollPositions.delete(scrollKey)'],
    ['read: () => chatScrollPositions.get(scrollKey) ?? null,', 'read: () => durableScroll ? durableScroll.read() : chatScrollPositions.get(scrollKey) ?? null,'],
  ];
  for (const [before, after] of changes) {
    if (text.split(before).length !== 2) throw new Error(`Pinned Chat reading memory seam changed: ${before}`);
    text = text.replace(before, after);
  }
  text = "import { readingMemoryEnabled } from './contract/reading-memory.ts'\n" + text;
  const ast = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  if (ast.parseDiagnostics.length) throw new Error(ts.flattenDiagnosticMessageText(ast.parseDiagnostics[0].messageText, '\n'));
  await writeFile(path, text);
  const entry = join(root, 'packages/client/ui-chat/src/client/index.ts');
  await writeFile(entry, `${await readFile(entry, 'utf8')}\nexport type { ChatScrollMemoryV1 } from './contract/reading-memory.ts'\n`);
}
