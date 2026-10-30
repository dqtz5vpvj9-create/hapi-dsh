/** Resolve the retained per-pane binding in the official slash/input service. */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import ts from 'typescript';

export async function applyInputBindingOccurrences(root) {
  const replace = async (file, serviceName) => {
    const path = join(root, file);
    let text = await readFile(path, 'utf8');
    const before = `    const session = sessions.sessionOf(actx)\n    const binding = session === undefined ? undefined : sessions.binding(session.sessionId)\n    if (binding === undefined || binding.session !== session) {`;
    const after = `    const session = sessions.sessionOf(actx)\n    const binding = sessions.bindingOf?.(actx)\n      ?? (session === undefined ? undefined : sessions.binding(session.sessionId))\n    if (binding === undefined || binding.session !== session\n      || (sessions.binding(binding.sessionId) !== binding && sessions.ownsBinding?.(binding) !== true)) {`;
    if (text.split(before).length !== 2) throw new Error(`Pinned ${serviceName} binding seam changed in ${file}.`);
    text = text.replace(before, after);
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    if (source.parseDiagnostics.length) throw new Error(`${file}: ${ts.flattenDiagnosticMessageText(source.parseDiagnostics[0].messageText, '\n')}`);
    await writeFile(path, text);
  };
  await replace('packages/client/ui-input-trigger/src/client/service.ts', 'InputTriggerService');
  await replace('packages/client/ui-commands/src/client/service.ts', 'CommandUiRuntime');
}
