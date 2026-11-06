/** Source-only repairs for the approved Pane menu, file picker and Chat policy contracts. */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
export async function applyInteractionOccurrences(root) {
  const edit = async (file, changes) => {
    const path = join(root, file); let text = await readFile(path, 'utf8');
    for (const [before, after] of changes) {
      if (!text.includes(before)) throw new Error(`Pinned interaction source changed: ${file}: ${before.slice(0, 80)}`);
      text = text.replace(before, after);
    }
    await writeFile(path, text);
  };
  await edit('packages/client/ui-input-trigger/src/types.ts', [
    ['readonly sessionId: SessionId', "readonly sessionId: SessionId\n  /** Exact retained composer occurrence, when supplied by the input owner. */\n  readonly binding?: import('@deepseek-ai/dsh-api-session-controller/client').SessionBinding"],
  ]);
  await edit('packages/client/ui-input-trigger/src/client/controller.ts', [
    ['sessionId: SessionId\n', "sessionId: SessionId\n  binding?: import('@deepseek-ai/dsh-api-session-controller/client').SessionBinding\n"],
    ['return { sessionId: this.deps.sessionId }', 'return { sessionId: this.deps.sessionId, ...(this.deps.binding ? { binding: this.deps.binding } : {}) }'],
  ]);
  await edit('packages/client/ui-input-trigger/src/client/service.ts', [
    ['sessionId: id,', 'sessionId: id,\n      ...(binding.viewId === undefined ? {} : { binding }),'],
  ]);
  await edit('packages/client/ui-input-trigger/src/client/index.ts', [
    ['inject: (sessionId): MenuViewInjected => {', "inject: (sessionId, readingScope?: import('@deepseek-ai/dsh-client-ui-slots').StandardSourceBinding): MenuViewInjected => {"],
    ['const actx = sessions.scope(sessionId)', "const binding = readingScope?.owner as import('@deepseek-ai/dsh-api-session-controller/client').SessionBinding | undefined\n        const actx = binding === undefined ? sessions.scope(sessionId) : (sessions.binding(sessionId) === binding || sessions.ownsBinding?.(binding) === true) ? binding.ctx : undefined"],
  ]);
  await edit('packages/client/ui-conversation/src/client/input/hub.ts', [
    ['canPickFiles(id: SessionId): boolean {\n    const binding = this.sessions().binding(id)', "canPickFiles(id: SessionId | SessionBinding): boolean {\n    const binding = typeof id === 'string' ? this.sessions().binding(id) : (this.sessions().binding(id.sessionId) === id || this.sessions().ownsBinding?.(id) === true) ? id : undefined"],
    ['pickFiles(id: SessionId): void {\n    const binding = this.sessions().binding(id)', "pickFiles(id: SessionId | SessionBinding): void {\n    const binding = typeof id === 'string' ? this.sessions().binding(id) : (this.sessions().binding(id.sessionId) === id || this.sessions().ownsBinding?.(id) === true) ? id : undefined"],
  ]);
  await edit('packages/client/ui-conversation/src/client/apply.ts', [
    ['available(session: { sessionId: SessionId }): boolean', 'available(session: { sessionId: SessionId; binding?: SessionBinding }): boolean'],
    ["run(session: { sessionId: SessionId }): void", "run(session: { sessionId: SessionId; binding?: SessionBinding }): void"],
    ['inputHub.canPickFiles(session.sessionId)', 'inputHub.canPickFiles(session.binding ?? session.sessionId)'],
    ['inputHub.pickFiles(session.sessionId)', 'inputHub.pickFiles(session.binding ?? session.sessionId)'],
  ]);
  await edit('packages/client/ui-chat/src/client/apply.ts', [
    ["const folding = binding.viewId === undefined ? ctx.get('chatPresentationConsumer')?.presentation(binding.sessionId)\n        : { foldCompletedTurns: false, stepGrouping: 'none' as const, virtualizeGroupMembers: true }", "const folding = ctx.get('chatPresentationConsumer')?.presentation(binding.sessionId)\n        ?? (binding.viewId === undefined ? undefined : { foldCompletedTurns: false, stepGrouping: 'none' as const, virtualizeGroupMembers: true })"],
  ]);
}
