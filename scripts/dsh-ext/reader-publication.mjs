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
  if (errors.length) {
    const position = source(path, result).getLineAndCharacterOfPosition(errors[0].start ?? 0);
    throw new Error(`${file}:${position.line + 1}:${position.character + 1}: ${ts.flattenDiagnosticMessageText(errors[0].messageText, '\n')}`);
  }
  await writeFile(path, result);
}
const insert = (edits, at, text) => edits.push({ start: at, end: at, text });
export async function applyReaderPublication(root) {
  await edit(root, 'packages/api/session-controller/src/client/contract/window-commit.ts', (ast, edits) => {
    const measurement = named(ast, 'WindowReaderMeasurementV1'), anchor = method(measurement, ast, 'anchor');
    const shape = anchor.type?.types?.find(ts.isTypeLiteralNode);
    if (!shape) throw new Error('Pinned reader anchor shape changed.');
    insert(edits, shape.getStart(ast) + 1, '\n    /** Semantic node/group owning a more precise DOM anchor; correction still uses key. */\n    readonly ownerKey?: string;\n');
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
  await edit(root, 'packages/client/ui-chat/src/client/contract/slots.ts', (ast, edits) => {
    const position = named(ast, 'ChatScrollPosition');
    insert(edits, position.end - 1, '\n  /** Semantic node/group owning the exact DOM reading anchor. */\n  readonly anchorOwnerKey?: string\n');
  });
  await edit(root, 'packages/client/ui-chat/src/client/chat/use-chat-viewport.ts', (ast, edits) => {
    const owner = named(ast, 'ChatViewport'), capture = method(owner, ast, 'capturePosition');
    let matched = 0;
    const visit = node => {
      if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'position'
        && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
        const declaration = node.parent.parent;
        insert(edits, declaration.getStart(ast), `const anchorOwnerKey = anchor.closest<HTMLElement>('[data-chat-node-key]')?.dataset.chatNodeKey
      ?? anchor.closest<HTMLElement>('[data-chat-group-key]')?.dataset.chatGroupKey
    `);
        insert(edits, node.initializer.getStart(ast) + 1, '\n      ...anchorOwnerKey === undefined ? {} : { anchorOwnerKey },'); ++matched;
      }
      ts.forEachChild(node, visit);
    };
    visit(capture);
    if (matched !== 1) throw new Error('Pinned viewport reading-position capture changed.');
  });
  await edit(root, 'packages/client/ui-chat/src/client/chat/use-chat-scroll.ts', (ast, edits) => {
    const create = named(ast, 'createWindowCommitReader');
    let matched = 0;
    const visit = node => {
      if (ts.isObjectLiteralExpression(node) && node.properties.some(property => ts.isPropertyAssignment(property)
        && property.name.getText(ast) === 'key' && property.initializer.getText(ast) === 'position.anchorKey')) {
        insert(edits, node.getStart(ast) + 1, ' ...position.anchorOwnerKey === undefined ? {} : { ownerKey: position.anchorOwnerKey },'); ++matched;
      }
      ts.forEachChild(node, visit);
    };
    visit(create);
    if (matched !== 1) throw new Error('Pinned Chat reader measurement changed.');
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
        if (entry.kind === 'node' && entry.groupPart !== undefined
          && JSON.stringify([entry.key, entry.groupPart]) === key) return true
        if (entry.kind === 'group') {
          if (key === \`group:\${entry.key}\`) return true
          if (group.store.groupSource(entry.key).getSnapshot()?.members.some(member => member.key === key
            || member.groupPart !== undefined && JSON.stringify([member.key, member.groupPart]) === key)) return true
        }
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
      if (ts.isExpressionStatement(node) && ts.isBinaryExpression(node.expression) && node.expression.left.getText(ast) === 'this.phase' && node.expression.right.getText(ast) === "'ready'") insert(edits, node.end, '\n      completed = true;\n      ');
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
        && !candidate.assembled.containsReadingKey(measurement.anchor.ownerKey ?? measurement.anchor.key)) {
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

/** The UI publisher commits DOM before measured readers correct their own viewport. */
export async function applyReaderLayout(root) {
  await edit(root, 'packages/client/ui-conversation/src/client/conversation/assembly.ts', (ast, edits) => {
    insert(edits, 0, "import { flushSync } from 'react-dom'\n");
    const create = method(named(ast, 'BoundConversation'), ast, 'createWindowCoordinator');
    let count = 0;
    const visit = node => {
      if (ts.isCallExpression(node) && node.expression.getText(ast) === 'view.publishCandidate') {
        edits.push({ start: node.getStart(ast), end: node.end, text: 'flushSync(() => view.publishCandidate(candidate))' }); ++count;
      }
      ts.forEachChild(node, visit);
    };
    visit(create);
    if (count !== 1) throw new Error('Pinned UI history layout publication changed.');
  });
  await edit(root, 'packages/client/ui-chat/src/client/chat/use-chat-viewport.ts', (ast, edits) => {
    const owner = named(ast, 'ChatViewport');
    const body = name => { const node = method(owner, ast, name); return node.body ?? node.initializer?.body; };
    const pin = body('pinReading');
    edits.push({ start: pin.getStart(ast), end: pin.end, text: `{
    const rows = this.virtualRows
    if (rows === null) return
    if (anchorKey === null) { rows.pinReading(null); return }
    const anchor = this.anchor(anchorKey)
    const semanticKey = anchor?.closest<HTMLElement>('[data-chat-node-key]')?.dataset.chatNodeKey
      ?? anchor?.closest<HTMLElement>('[data-chat-group-key]')?.dataset.chatGroupKey ?? anchorKey
    const owner = this.anchorOwners.get(semanticKey)
      ?? anchor?.closest<HTMLElement>('[data-chat-virtual-row]')?.dataset.chatVirtualKey
    if (owner !== undefined && rows.contains(owner)) rows.pinReading(semanticKey)
  }` });
    const restore = body('restore');
    insert(edits, restore.getStart(ast) + 1, '\n    if (this.pendingRestore !== null) this.releaseDestination()\n    this.pendingRestore = null\n');
    let revealed = 0;
    const reveal = node => {
      if (ts.isIfStatement(node) && ts.isCallExpression(node.expression)
        && node.expression.expression.getText(ast) === 'this.revealKey') {
        edits.push({ start: node.getStart(ast), end: node.end, text: `if (this.revealKey(position.anchorOwnerKey ?? position.anchorKey)) {
      this.pendingRestore = position
      return null
    }` }); ++revealed;
      }
      ts.forEachChild(node, reveal);
    };
    reveal(restore);
    if (revealed !== 1) throw new Error('Pinned viewport virtual restore changed.');
    insert(edits, body('restoreVirtualLayout').getStart(ast) + 1, `
    const pending = this.pendingRestore
    if (pending !== null) {
      const row = this.anchor(pending.anchorKey)
      if (row === null) {
        if (this.anchor(pending.anchorOwnerKey ?? pending.anchorKey, 'node') !== null) {
          this.pendingRestore = null
          this.releaseDestination()
        }
        return
      }
      this.pendingRestore = null
      this.virtualLayoutPosition = null
      this.align(row, pending.anchorTop, null)
      this.releaseDestination()
      return
    }
    if (!changed) {
      this.virtualLayoutPosition = null
      return
    }
`);
    const layout = method(owner, ast, 'restoreVirtualLayout').initializer;
    if (!layout || !ts.isArrowFunction(layout) || layout.parameters.length !== 0) throw new Error('Pinned virtual layout callback changed.');
    edits.push({ start: layout.parameters.pos, end: layout.parameters.end, text: 'changed = true' });
    insert(edits, body('stopPreserving').getStart(ast) + 1, '\n    if (this.pendingRestore !== null) this.releaseDestination()\n    this.pendingRestore = null\n');
    const align = body('align');
    const returning = align.statements.find(node => ts.isReturnStatement(node) && node.expression
      && ts.isCallExpression(node.expression) && node.expression.expression.getText(ast) === 'this.write');
    if (!returning) throw new Error('Pinned viewport semantic landing changed.');
    insert(edits, returning.getStart(ast), `const ownerKey = row.closest<HTMLElement>('[data-chat-node-key]')?.dataset.chatNodeKey
      ?? row.closest<HTMLElement>('[data-chat-group-key]')?.dataset.chatGroupKey
    `);
    const anchor = returning.expression.arguments[3];
    insert(edits, anchor.getStart(ast) + 1, ' ...ownerKey === undefined ? {} : { ownerKey },');
    const write = method(owner, ast, 'write'), anchorType = write.parameters.find(node => node.name.getText(ast) === 'anchor')?.type;
    if (!anchorType || !ts.isTypeLiteralNode(anchorType)) throw new Error('Pinned viewport landing anchor changed.');
    insert(edits, anchorType.getStart(ast) + 1, ' ownerKey?: string;');
    let saved = 0;
    const save = node => {
      if (ts.isObjectLiteralExpression(node) && node.properties.some(property => ts.isPropertyAssignment(property)
        && property.name.getText(ast) === 'anchorKey' && property.initializer.getText(ast) === 'anchor.key')) {
        insert(edits, node.getStart(ast) + 1, ' ...anchor.ownerKey === undefined ? {} : { anchorOwnerKey: anchor.ownerKey },'); ++saved;
      }
      ts.forEachChild(node, save);
    };
    save(write);
    if (saved !== 1) throw new Error('Pinned viewport landing memory changed.');
    const preserve = node => {
      if (ts.isObjectLiteralExpression(node) && node.properties.some(property => ts.isPropertyAssignment(property)
        && property.name.getText(ast) === 'key' && property.initializer.getText(ast) === 'position.anchorKey')) {
        insert(edits, node.getStart(ast) + 1, ' ...position.anchorOwnerKey === undefined ? {} : { ownerKey: position.anchorOwnerKey },');
      }
      ts.forEachChild(node, preserve);
    };
    preserve(body('preserve'));
    insert(edits, owner.end - 1, '\n  private pendingRestore: ChatScrollPosition | null = null\n');
  });
  await edit(root, 'packages/client/ui-chat/src/client/contract/slots.ts', (ast, edits) => {
    let count = 0;
    const visit = node => {
      if (ts.isPropertySignature(node) && node.name.getText(ast) === 'afterLayout') {
        edits.push({ start: node.type.getStart(ast), end: node.type.end, text: '(changed?: boolean) => void' }); ++count;
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
    if (count !== 1) throw new Error('Pinned virtual layout completion contract changed.');
  });
  await edit(root, 'packages/client/ui-chat/src/client/chat/VirtualChatRows.tsx', (ast, edits) => {
    const layout = named(ast, 'VirtualLayoutCommit');
    edits.push({ start: layout.getStart(ast), end: layout.end, text: `interface VirtualLayoutProps {
  readonly model: readonly VirtualChatRow[]
  readonly revision: number
  readonly margin: number
  readonly before: () => void
  readonly after: (changed: boolean, revision: number) => void
  readonly children: ReactNode
}
class VirtualLayoutCommit extends Component<VirtualLayoutProps> {
  override getSnapshotBeforeUpdate(previous: VirtualLayoutProps): { changed: boolean; revision: number } {
    this.props.before()
    return { changed: previous.model !== this.props.model || previous.revision !== this.props.revision
      || previous.margin !== this.props.margin, revision: this.props.revision }
  }
  override componentDidUpdate(_previous: VirtualLayoutProps, _state: unknown, snapshot: { changed: boolean; revision: number }): void {
    this.props.after(snapshot.changed, snapshot.revision)
  }
  override render(): ReactNode { return this.props.children }
}` });
    let state = 0, measured = 0, resized = 0, wired = 0, completed = 0;
    const visit = node => {
      if (ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => declaration.name.getText(ast) === 'scrollElement')) {
        insert(edits, node.end, '\n  const layoutRevision = useRef(0)\n  const pendingLayout = useRef<{ changed: boolean; revision: number } | null>(null)\n'); ++state;
      }
      if (ts.isPropertyAssignment(node) && node.name.getText(ast) === 'measureElement' && ts.isArrowFunction(node.initializer)) {
        const statement = node.initializer.body.statements?.find(statement => ts.isReturnStatement(statement)
          && statement.expression?.getText(ast) === 'borderBox + margin');
        if (!statement) throw new Error('Pinned virtual row measurement changed.');
        edits.push({ start: statement.getStart(ast), end: statement.end, text: `const size = borderBox + margin
      const key = instance.options.getItemKey(instance.indexFromElement(element))
      if (instance.itemSizeCache.get(key) !== size) layoutRevision.current++
      return size` }); ++measured;
      }
      if (ts.isExpressionStatement(node) && node.expression.getText(ast) === 'virtualizer.resizeItem(index, size)') {
        insert(edits, node.getStart(ast), 'if (virtualizer.itemSizeCache.get(virtualizer.options.getItemKey(index)) !== size) layoutRevision.current++\n      '); ++resized;
      }
      if (ts.isJsxOpeningElement(node) && node.tagName.getText(ast) === 'VirtualLayoutCommit') {
        insert(edits, node.attributes.getStart(ast), 'model={rows} revision={layoutRevision.current} margin={scrollMargin} ');
        const after = node.attributes.properties.find(property => ts.isJsxAttribute(property) && property.name.getText(ast) === 'after')?.initializer;
        if (!after || !ts.isJsxExpression(after) || !after.expression) throw new Error('Pinned virtual layout completion changed.');
        edits.push({ start: after.expression.getStart(ast), end: after.expression.end,
          text: '(changed, revision) => { pendingLayout.current = { changed, revision } }' }); ++wired;
      }
      if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useLayoutEffect'
        && node.arguments[0]?.getText(ast).includes('measuredLayout.current = measured')) {
        const effect = node.arguments[0];
        if (!ts.isArrowFunction(effect) || !ts.isBlock(effect.body)) throw new Error('Pinned virtual row layout measurement changed.');
        insert(edits, effect.body.end - 1, `
    const commit = pendingLayout.current
    pendingLayout.current = null
    if (commit !== null) virtualization.afterLayout(commit.changed || commit.revision !== layoutRevision.current)
  `); ++completed;
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
    if (state !== 1 || measured !== 1 || resized !== 1 || wired !== 1 || completed !== 1) throw new Error('Pinned virtual layout change signals changed.');
  });
  await edit(root, 'packages/client/ui-chat/src/client/chat/use-chat-scroll.ts', (ast, edits) => {
    let retained = 0, restored = 0, saved = 0;
    const visit = node => {
      if (ts.isPropertyAssignment(node) && node.name.getText(ast) === 'capturePosition'
        && node.initializer.getText(ast) === '() => viewport.capturePosition()') {
        edits.push({ start: node.initializer.getStart(ast), end: node.initializer.end, text: `() => {
        const position = viewport.capturePosition()
        if (position !== null && !reading.followingTail) viewport.beginPreserving(position)
        return position
      }` }); ++retained;
      }
      if (ts.isPropertyAssignment(node) && node.name.getText(ast) === 'savedAnchorKey'
        && node.initializer.getText(ast) === 'saved?.anchorKey ?? null') {
        edits.push({ start: node.initializer.getStart(ast), end: node.initializer.end, text: 'saved?.anchorOwnerKey ?? saved?.anchorKey ?? null' }); ++saved;
      }
      if (ts.isObjectLiteralExpression(node) && node.properties.some(property => ts.isPropertyAssignment(property)
        && property.name.getText(ast) === 'anchorKey' && property.initializer.getText(ast) === 'anchor.key')) {
        insert(edits, node.getStart(ast) + 1, ' ...anchor.ownerKey === undefined ? {} : { anchorOwnerKey: anchor.ownerKey },'); ++restored;
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
    if (retained !== 1 || restored !== 1 || saved !== 1) throw new Error('Pinned Chat commit-time reading ownership changed.');
  });
}
