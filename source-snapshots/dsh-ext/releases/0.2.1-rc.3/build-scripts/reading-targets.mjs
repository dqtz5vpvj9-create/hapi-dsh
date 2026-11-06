/** Scope the remaining official history consumers without changing canonical resource authorization. */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import ts from 'typescript';
const scopeType = "import('@deepseek-ai/dsh-client-ui-slots').StandardSourceBinding";
const resolver = `
/** Use the same retained presentation owner as the surrounding official SessionProvider. */
function readingTargetBinding(ctx: import('@deepseek-ai/cordis').Context,
  id: import('@deepseek-ai/dsh-session/types').SessionId,
  scope?: import('@deepseek-ai/dsh-client-ui-slots').StandardSourceBinding,
): import('@deepseek-ai/dsh-api-session-controller/client').SessionBinding {
  const owner = scope?.owner as import('@deepseek-ai/dsh-api-session-controller/client').SessionBinding | undefined
    ?? ctx.sessions.binding(id)
  if (!owner || owner.sessionId !== id || (ctx.sessions.binding(id) !== owner && ctx.sessions.ownsBinding?.(owner) !== true)) {
    throw new Error('The history detail occurrence is no longer retained.')
  }
  return owner
}
`;
export async function applyReadingTargets(root) {
  const changes = [
    ['packages/client/ui-trajectory/src/client/index.ts', [
      ['inject: (sessionId: SessionId): TrajectoryViewInjected => {', `inject: (sessionId: SessionId, readingScope?: ${scopeType}): TrajectoryViewInjected => {`],
      ['const session = ctx.sessions.binding(sessionId)?.session', 'const binding = readingTargetBinding(ctx, sessionId, readingScope)\n      const session = binding.session'],
      ["ctx.uiConversation.binding(sessionId).target('trajectory')", "ctx.uiConversation.binding(binding).target('trajectory')"],
    ]],
    ['packages/client/ui-tool/src/client/tool/toolviews/todo-row.tsx', [
      ["inject: ['slots', 'uiConversation']", "inject: ['slots', 'uiConversation', 'sessions']"],
      ['inject: (sessionId): TodoHistoryInjected => ({', `inject: (sessionId, readingScope?: ${scopeType}): TodoHistoryInjected => ({`],
      ["ctx.uiConversation.binding(sessionId).target('tool-todo-history')", "ctx.uiConversation.binding(readingTargetBinding(ctx, sessionId, readingScope)).target('tool-todo-history')"],
    ]],
    ['packages/client/ui-plan/src/client/index.ts', [
      ['inject: (sessionId: SessionId): PlanCardsInjected => {', `inject: (sessionId: SessionId, readingScope?: ${scopeType}): PlanCardsInjected => {`],
      ['const binding = ctx.sessions.binding(sessionId)', 'const binding = readingTargetBinding(ctx, sessionId, readingScope)'],
    ]],
  ];
  for (const [file, edits] of changes) {
    const path = join(root, file);
    let text = await readFile(path, 'utf8');
    for (const [before, after] of edits) {
      if (text.split(before).length !== 2) throw new Error(`Pinned history detail seam changed in ${file}: ${before}`);
      text = text.replace(before, after);
    }
    text += resolver;
    const parsed = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    if (parsed.parseDiagnostics.length) throw new Error(`${file}: ${ts.flattenDiagnosticMessageText(parsed.parseDiagnostics[0].messageText, '\n')}`);
    await writeFile(path, text);
  }
}
