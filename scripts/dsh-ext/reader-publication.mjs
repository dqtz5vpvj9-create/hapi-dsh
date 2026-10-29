/** Generic source-level reader protection and incremental complete-window publication. */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import ts from 'typescript';
function source(path, text) { return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true); }
function named(file, name) {
  const found = file.statements.filter(node => node.name?.text === name);
  if (found.length !== 1) throw new Error(`Pinned source definition changed: ${name}`);
  return found[0];
}
function method(owner, file, name) {
  const found = owner.members.filter(node => node.name?.getText(file) === name);
  if (found.length !== 1) throw new Error(`Pinned source method changed: ${name}`);
  return found[0];
}
async function edit(root, file, change) {
  const path = join(root, file), text = await readFile(path, 'utf8'), ast = source(path, text), edits = [];
  change(ast, edits, text);
  let result = text, previous = text.length + 1;
  for (const item of edits.sort((a, b) => b.start - a.start)) {
    if (item.end > previous) throw new Error('Overlapping reader source edits.');
    result = result.slice(0, item.start) + item.text + result.slice(item.end); previous = item.start;
  }
  const errors = source(path, result).parseDiagnostics;
  if (errors.length) throw new Error(ts.flattenDiagnosticMessageText(errors[0].messageText, '\n'));
  await writeFile(path, result);
}
const insert = (edits, at, text) => edits.push({ start: at, end: at, text });
export async function applyReaderPublication(root) {
  await edit(root, 'packages/api/session-controller/src/client/contract/window-commit.ts', (ast, edits) => {
    const host = named(ast, 'WindowCommitHostV1');
    insert(edits, host.end - 1, `\n  /** Validate all commit-time readers before publishing; absent for legacy hosts. */\n  validate?(candidate: Candidate, measurements: readonly WindowReaderMeasurementV1[]): void\n`);
    const factory = named(ast, 'WindowCommitFactoryV1');
    insert(edits, factory.end - 1, `\n  /** Installed together with optional complete-window publication and reader validation. */\n  readonly completeWindowHistory?: 1\n`);
  });
  await edit(root, 'packages/api/session-controller/src/client/sessions/window-commit.ts', (ast, edits) => {
    const owner = named(ast, 'WindowCommitCoordinator'), commit = method(owner, ast, 'commitWindow');
    let matches = 0;
    const visit = node => {
      if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && node.expression.expression.getText(ast) === 'this.host.publish') {
        insert(edits, node.getStart(ast), 'this.host.validate?.(record.candidate, [...measurements.values()])\n          '); ++matches;
      }
      ts.forEachChild(node, visit);
    };
    visit(commit);
    if (matches !== 1) throw new Error('Pinned coordinator publication checkpoint changed.');
    const factory = named(ast, 'createWindowCommitFactory');
    let marked = false;
    const mark = node => {
      if (!marked && ts.isObjectLiteralExpression(node)) { insert(edits, node.getStart(ast) + 1, '\n    completeWindowHistory: 1 as const,'); marked = true; }
      else ts.forEachChild(node, mark);
    };
    mark(factory);
    if (!marked) throw new Error('Pinned coordinator capability factory changed.');
  });
  await edit(root, 'packages/client/ui-conversation/src/client/conversation/assembler.ts', (ast, edits) => {
    const owner = named(ast, 'ConversationNodeAssembler');
    insert(edits, owner.end - 1, `
  /** Whether a materialized node or group still owns this reader anchor. */
  containsReadingKey(key: string): boolean {
    for (const context of this.contexts.values()) {
      for (const node of context.current.values()) if (node?.key === key) return true
    }
    for (const group of this.groups.values()) {
      for (const entry of group.store.entries) {
        if (entry.key === key) return true
        if (entry.kind === 'group' && group.store.groupSource(entry.key).getSnapshot()?.members.some(member => member.key === key)) return true
      }
    }
    return false
  }
`);
  });
  await edit(root, 'packages/client/ui-conversation/src/client/conversation/history-view.ts', (ast, edits) => {
    const owner = named(ast, 'BoundHistoryView'), publish = method(owner, ast, 'publishWindow');
    let replaced = 0;
    const visit = node => {
      if (ts.isCallExpression(node) && node.expression.getText(ast) === 'this.assembler.replaceWindow') {
        edits.push({ start: node.getStart(ast), end: node.end, text: "this.feed?.mode === 'complete-window' ? this.publishCompleteEntries(entries, hasBefore) : this.assembler.replaceWindow(entries, hasBefore)" }); ++replaced;
      } else ts.forEachChild(node, visit);
    };
    visit(publish);
    if (replaced !== 1) throw new Error('Pinned complete-window assembler checkpoint changed.');
    const read = method(owner, ast, 'readComplete');
    insert(edits, read.body.getStart(ast) + 1, `\n    this.completePreserveAnchor = request === null || request.kind === 'before' || request.kind === 'after'\n    let completed = false\n`);
    const visitRead = node => {
      if (ts.isExpressionStatement(node) && ts.isBinaryExpression(node.expression) && node.expression.left.getText(ast) === 'this.phase' && node.expression.right.getText(ast) === "'ready'") insert(edits, node.end, '\n      completed = true');
      if (ts.isIfStatement(node) && node.expression.getText(ast) === '!this.released && this.versionCursor !== null') edits.push({ start: node.expression.getStart(ast), end: node.expression.end, text: '!this.released && this.versionCursor !== null && (completed || signal.aborted)' });
      ts.forEachChild(node, visitRead);
    };
    visitRead(read);
    const tries = read.body.statements.filter(ts.isTryStatement);
    if (tries.length !== 1 || !tries[0].finallyBlock) throw new Error('Complete-window read cleanup changed.');
    insert(edits, tries[0].finallyBlock.getStart(ast) + 1, '\n      this.completePreserveAnchor = true\n');
    insert(edits, owner.end - 1, `
  private completePreserveAnchor = true
  /** Called with every mounted reader's fresh measurement before the publication. */
  validateCandidate(candidate: HistoryWindowCandidateV1, measurements: readonly import('@deepseek-ai/dsh-api-session-controller/client').WindowReaderMeasurementV1[]): void {
    if (this.feed?.mode !== 'complete-window' || !this.completePreserveAnchor) return
    for (const measurement of measurements) {
      if (measurement.available && !measurement.following && measurement.anchor !== null
        && !candidate.assembled.containsReadingKey(measurement.anchor.key)) {
        throw Object.assign(new Error('The prepared window would evict a visible reader anchor.'), { code: 'CAPACITY_EXCEEDED' })
      }
    }
  }
  /** Preserve resident context/node identities for ordinary complete-window growth. */
  private publishCompleteEntries(entries: readonly SessionEventLikeEntry[], hasBefore: boolean): ReturnType<ConversationNodeAssembler['replaceWindow']> {
    if (this.entries.length === 0) return this.assembler.replaceWindow(entries, hasBefore)
    const previous = new Map(this.entries.map(entry => [entry.event.seq, entry]))
    const next = new Map(entries.map(entry => [entry.event.seq, entry]))
    const first = this.entries[0]!.event.seq, last = this.entries.at(-1)!.event.seq
    if (this.entries.some(entry => next.get(entry.event.seq) !== entry)
      || entries.some(entry => !previous.has(entry.event.seq) && entry.event.seq > first && entry.event.seq < last)) {
      return this.assembler.replaceWindow(entries, hasBefore)
    }
    let publication = this.assembler.prepend(entries.filter(entry => entry.event.seq < first), hasBefore)
    for (const entry of entries) if (entry.event.seq > last) {
      const value = this.assembler.append(entry)
      if (value === 'immediate' || publication === 'none') publication = value
    }
    return publication
  }
`);
  });
  await edit(root, 'packages/client/ui-conversation/src/client/conversation/assembly.ts', (ast, edits) => {
    const owner = named(ast, 'BoundConversation'), create = method(owner, ast, 'createWindowCoordinator');
    let added = false;
    const visit = node => {
      if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'host' && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
        insert(edits, node.initializer.getStart(ast) + 1, `
      validate: (candidate, measurements) => {
        const view = live()
        if (view === undefined) throw new Error('The reading window was released before publication.')
        view.validateCandidate(candidate, measurements)
      },`); added = true;
      }
      ts.forEachChild(node, visit);
    };
    visit(create);
    if (!added) throw new Error('Pinned Conversation coordinator host changed.');
  });
}
