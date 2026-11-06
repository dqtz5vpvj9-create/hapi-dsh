/** Source-only refinements for complete history input contracts. */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import ts from 'typescript';
export async function applyInputContracts(root) {
  const path = join(root, 'packages/client/ui-conversation/src/client/contract/history-view.ts');
  let text = await readFile(path, 'utf8');
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const contract = source.statements.find(node => ts.isInterfaceDeclaration(node) && node.name.text === 'HistoryViewSnapshotV1');
  if (!contract) throw new Error('The pinned history view snapshot contract changed.');
  const edits = ['before', 'after'].map(name => {
    const member = contract.members.find(node => node.name?.getText(source) === name);
    if (!member?.type || !member.questionToken) throw new Error(`Missing optional history boundary ${name}.`);
    return { position: member.type.end, text: ' | undefined' };
  });
  for (const edit of edits.sort((a, b) => b.position - a.position)) text = text.slice(0, edit.position) + edit.text + text.slice(edit.position);
  await writeFile(path, text);
}
