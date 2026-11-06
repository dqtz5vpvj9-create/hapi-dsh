/** Optional, source-only reading occurrences. Native Session identity and authorization never change. */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import ts from 'typescript';

function replace(text, before, after, count = 1) {
  if (text.split(before).length !== count + 1) throw new Error(`Pinned reading seam changed: ${before.slice(0, 160)}`);
  return text.replaceAll(before, after);
}
async function edit(root, file, transform) {
  const path = join(root, file), text = await readFile(path, 'utf8'), result = transform(text);
  const source = ts.createSourceFile(path, result, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  if (source.parseDiagnostics.length) throw new Error(`${file}: ${ts.flattenDiagnosticMessageText(source.parseDiagnostics[0].messageText, '\n')}`);
  await writeFile(path, result);
}
function member(text, ownerName, code) {
  const source = ts.createSourceFile('source.ts', text, ts.ScriptTarget.Latest, true);
  const found = source.statements.filter(node => node.name?.text === ownerName);
  if (found.length !== 1 || !('members' in found[0])) throw new Error(`Pinned reading owner changed: ${ownerName}`);
  const at = found[0].end - 1;
  return text.slice(0, at) + `\n${code}\n` + text.slice(at);
}
/** Pass the exact renderer scope to session inject factories, after their existing arguments. */
function scopedInjects(text, rewrite) {
  const source = ts.createSourceFile('apply.ts', text, ts.ScriptTarget.Latest, true), edits = [];
  const visit = node => {
    if (ts.isPropertyAssignment(node) && node.name.getText(source) === 'inject' && ts.isArrowFunction(node.initializer)
      && node.initializer.parameters[0]?.name.getText(source) === 'sessionId') {
      const fn = node.initializer, hasStore = ts.isObjectLiteralExpression(node.parent)
        && node.parent.properties.some(property => property.name?.getText(source) === 'store');
      const parameters = fn.parameters.map(parameter => parameter.getText(source));
      if (hasStore && parameters.length === 1) parameters.push('_actions: unknown');
      parameters.push('readingScope?: import(\'@deepseek-ai/dsh-client-ui-slots\').StandardSourceBinding');
      const original = fn.getText(source), head = original.slice(0, fn.body.getStart(source) - fn.getStart(source));
      const close = head.lastIndexOf(')');
      if (close < 0) throw new Error('A scoped inject must use a parenthesized signature.');
      const typed = '(' + parameters.join(', ') + head.slice(close);
      edits.push({ start: fn.getStart(source), end: fn.end, value: typed + rewrite(fn.body.getText(source)) });
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  for (const change of edits.sort((a, b) => b.start - a.start)) text = text.slice(0, change.start) + change.value + text.slice(change.end);
  return text;
}
const resolveBinding = `
/** Resolve a renderer-owned occurrence without minting or guessing a Session identity. */
function readingBinding(sessions: import('@deepseek-ai/dsh-api-session-controller/client').ISessions,
  id: SessionId, source?: import('@deepseek-ai/dsh-client-ui-slots').StandardSourceBinding): SessionBinding {
  const binding = source?.owner as SessionBinding | undefined ?? sessions.binding(id)
  if (binding === undefined || binding.sessionId !== id
    || (sessions.binding(id) !== binding && sessions.ownsBinding?.(binding) !== true)) {
    throw new Error('The Conversation reading occurrence is no longer retained.')
  }
  return binding
}
`;

export async function applyReadingOccurrences(root) {
  await edit(root, 'packages/api/session-controller/src/client/sessions/service.ts', text => member(text, 'SessionBinding', `
  /** Optional presentation occurrence; never an execution or authorization identity. */
  readonly viewId?: string
`));
  await edit(root, 'packages/api/session-controller/src/client/contract/sessions.ts', text => member(text, 'ISessions', `
  /** Validate a retained presentation binding in addition to the canonical binding. */
  ownsBinding?(binding: SessionBinding): boolean
  /** Resolve the exact retained occurrence inherited by a scoped input context. */
  bindingOf?(ctx: Context): SessionBinding | undefined
  /** Acquire an independent reading/input occurrence without creating an execution Agent. */
  openReadingView?(reference: SessionReference, viewId: string): SessionReference | undefined
`));
  await edit(root, 'packages/api/session-controller/src/client/contract/window-commit.ts', text => member(text, 'WindowCommitFactoryV1', `
  /** Installed as one set with scope-aware renderer, Session, Conversation and Chat. */
  readonly readingOccurrences?: 1
`));
  await edit(root, 'packages/api/session-controller/src/client/sessions/window-commit.ts', text => replace(text,
    'completeWindowHistory: 1 as const,', "completeWindowHistory: 1 as const,\n    ...Reflect.get(globalThis, '__DSH_CLIENT_READING_OCCURRENCES') === 'off' ? {} : { readingOccurrences: 1 as const },"));

  await edit(root, 'packages/client/ui-slots/src/renderer.ts', text => member(text, 'StandardSourceBinding', `
  /** Optional domain identity supplied to inject callbacks; defaults to the store scope key. */
  readonly injectionKey?: string
  /** Opaque domain owner validated by its scope adapter. The renderer does not interpret it. */
  readonly owner?: unknown
`));
  await edit(root, 'packages/client/ui-slots/src/index.ts', text => {
    for (const name of ['InjectParams', 'FactoryInjectParams']) {
      const source = ts.createSourceFile('index.ts', text, ts.ScriptTarget.Latest, true);
      const node = source.statements.find(node => ts.isTypeAliasDeclaration(node) && node.name.text === name);
      if (!node) throw new Error(`Missing scope contract ${name}`);
      const body = node.type.getText(source).replace(/\[sessionId:([^\]]+)\]/g,
        '[sessionId:$1, readingScope?: import(\'./renderer.ts\').StandardSourceBinding]');
      text = text.slice(0, node.type.getStart(source)) + body + text.slice(node.type.end);
    }
    return text;
  });
  await edit(root, 'packages/client/ui-renderer/src/client/scoped-slots.tsx', text => {
    text = replace(text, "entry: Pick<StoredEntry, 'inject'>,", "entry: Pick<StoredEntry, 'inject' | 'store'>,");
    text = replace(text, 'if (binding !== undefined) args.push(binding.key)', 'if (binding !== undefined) args.push(binding.injectionKey ?? binding.key)');
    return replace(text, 'if (actions !== undefined) args.push(actions)',
      'if (entry.store !== undefined) args.push(actions)\n  if (binding !== undefined) args.push(binding)');
  });
  await edit(root, 'packages/client/ui-session/src/client/index.ts', text => {
    text = replace(text, "props: ['sessionId'],", "props: ['sessionId', 'sessionBinding'],");
    text = replace(text, 'props: { sessionId: binding.sessionId },', 'props: { sessionId: binding.sessionId, sessionBinding: binding },');
    text = replace(text, "readonly ['sessionId']", "readonly ['sessionId', 'sessionBinding']");
    text = replace(text, 'if (this.sessions.binding(reference.sessionId) !== owner)',
      'if (this.sessions.binding(reference.sessionId) !== owner && this.sessions.ownsBinding?.(owner) !== true)');
    text = replace(text, 'key: binding.sessionId,\n      ctx: binding.ctx,',
      'key: binding.viewId === undefined ? binding.sessionId : JSON.stringify([binding.sessionId, binding.viewId]),\n      injectionKey: binding.sessionId,\n      owner: binding,\n      ctx: binding.ctx,');
    // These interfaces live inside a declaration merge, so use exact member anchors.
    text = replace(text, 'interface SessionStandardProps {', 'interface SessionStandardProps {\n    /** Exact optional reading/input owner; sessionId remains canonical. */\n    sessionBinding?: SessionBinding');
    return replace(text, 'interface SessionMaybeStandardProps {', 'interface SessionMaybeStandardProps {\n    /** Absent outside a retained occurrence. */\n    sessionBinding?: SessionBinding');
  });

  await edit(root, 'packages/client/ui-conversation/src/client/conversation/assembly.ts', text => {
    text = member(text, 'ConversationBinding', `
  /** The selected occurrence's official reader, absent on the native default path. */
  readonly readingView?: ConversationHistoryViewV1 | undefined
`);
    text = member(text, 'BoundConversation', `
  private selectedReading: ConversationHistoryViewV1 | undefined
  private stopSelectedReading: () => void = () => {}
  get readingView(): ConversationHistoryViewV1 | undefined { return this.selectedReading }
  private publishReading(): void {
    const view = this.readingId === undefined ? undefined : this.historyViews.get(this.readingId)?.view
    if (view === undefined) return
    this.snapshot.set(this.currentSnapshot())
    this.openTurn.set(view.openTurn())
  }
`);
    text = replace(text, 'private readonly commitFactory: WindowCommitFactoryV1 | undefined,',
      'private readonly commitFactory: WindowCommitFactoryV1 | undefined,\n    private readonly readingId?: string,');
    text = replace(text, 'this.replace(feed.getSnapshot())', `if (readingId !== undefined) {
      const reading = this.historyView(readingId)
      if (reading === undefined) throw new Error('A reading occurrence requires an installed history source.')
      this.selectedReading = reading
      this.viewStore = reading.reads
      this.stopSelectedReading = reading.snapshot.subscribe(() => { this.publishReading() })
      this.publishReading()
      return
    }
    this.replace(feed.getSnapshot())`);
    text = replace(text, 'activate(target: string): void {', `activate(target: string): void {
    if (this.readingId !== undefined) {
      this.historyViews.get(this.readingId)?.view.activate(target)
      this.publishReading()
      return
    }`);
    text = replace(text, 'rebuild(): void { this.publish(this.assembler.rebuildRegistry()) }', `rebuild(): void {
    if (this.readingId !== undefined) {
      this.historyViews.get(this.readingId)?.view.rebuild()
      this.publishReading()
    } else this.publish(this.assembler.rebuildRegistry())
  }`);
    text = replace(text, 'this.disposeFeed()\n', 'this.disposeFeed()\n    this.stopSelectedReading()\n', 1);
    text = replace(text, 'activeTargets: this.assembler.activityTargets(),',
      'activeTargets: (this.readingId === undefined ? undefined : this.historyViews.get(this.readingId)?.view)?.activityTargets() ?? this.assembler.activityTargets(),');
    text = replace(text, 'if (this.sessions.binding(sessionId) !== owner)',
      'if (this.sessions.binding(sessionId) !== owner && this.sessions.ownsBinding?.(owner) !== true)');
    return replace(text, 'this.sessions.windowCommit,\n    )', 'this.sessions.windowCommit,\n      owner.viewId,\n    )');
  });
  await edit(root, 'packages/client/ui-conversation/src/client/conversation/history-view.ts', text => {
    text = member(text, 'BoundHistoryView', `
  /** Every target, including tool/request inspection, shares this occurrence assembler. */
  activate(target: string): void { this.assertLive(); this.assembler.activateTarget(target); this.assembler.flush(); this.publish() }
  rebuild(): void { this.assertLive(); this.assembler.rebuildRegistry(); this.assembler.flush(); this.publish() }
  activityTargets(): ReadonlySet<string> { return this.assembler.activityTargets() }
  openTurn(): number | undefined { return this.assembler.openTurn() }
`);
    // Publish the selected view synchronously inside the same commit checkpoint.
    // The mounted Chat's participant schedules its final correction in React layout.
    const source = ts.createSourceFile('history-view.ts', text, ts.ScriptTarget.Latest, true);
    const owner = source.statements.find(node => node.name?.text === 'BoundHistoryView');
    const publish = owner.members.find(node => node.name?.getText(source) === 'publishWindow');
    const at = publish.body.end - 1;
    return text.slice(0, at) + "\n    if (this.feed?.mode === 'complete-window') this.publish()\n  " + text.slice(at);
  });
  await edit(root, 'packages/client/ui-conversation/src/client/input/hub.ts', text => {
    text = replace(text, 'const binding = session === undefined ? undefined : sessions.binding(session.sessionId)',
      'const binding = sessions.bindingOf?.(actx) ?? (session === undefined ? undefined : sessions.binding(session.sessionId))');
    text = replace(text, 'if (this.sessions().binding(binding.sessionId) !== binding)',
      'if (this.sessions().binding(binding.sessionId) !== binding && this.sessions().ownsBinding?.(binding) !== true)');
    text = replace(text, 'shell.setDraft(readConversationDraft(binding.sessionId))',
      'shell.setDraft(readConversationDraft(binding.viewId === undefined ? binding.sessionId : JSON.stringify([binding.sessionId, binding.viewId])))');
    return member(text, 'InputHub', `
  /** Exact occurrence counterpart of the legacy id-addressed trigger lookup. */
  inputTriggersFor(binding: SessionBinding): InputTriggerController | undefined { return this.controller(binding.ctx) }
`);
  });
  await edit(root, 'packages/client/ui-conversation/src/client/stores.ts', text => replace(text,
    'readConversationDraft(sessionId: SessionId)', 'readConversationDraft(sessionId: string)'));
  await edit(root, 'packages/client/ui-conversation/src/client/apply.ts', text => {
    text += resolveBinding;
    text = replace(text, 'const activateView = (sessionId: SessionId, preferred: string | null): void => {',
      'const activateView = (sessionId: SessionId | SessionBinding, preferred: string | null): void => {');
    text = replace(text, 'const restoreView = (sessionId: SessionId): void => {\n    activateView(sessionId, readConversationViewPreference(sessionId))',
      "const restoreView = (sessionId: SessionId | SessionBinding): void => {\n    activateView(sessionId, readConversationViewPreference(typeof sessionId === 'string' ? sessionId : sessionId.sessionId))");
    text = text.replaceAll('restoreView(binding.sessionId)', 'restoreView(binding)');
    return scopedInjects(text, body => body
      .replaceAll('inputHub.shell(sessionId)', 'inputHub.shellFor(readingBinding(sessions, sessionId, readingScope))')
      .replaceAll('inputHub.inputTriggers(sessionId)', 'inputHub.inputTriggersFor(readingBinding(sessions, sessionId, readingScope))')
      .replaceAll('activateView(sessionId, view)', 'activateView(readingBinding(sessions, sessionId, readingScope), view)'));
  });
  await edit(root, 'packages/client/ui-chat/src/client/apply.ts', text => {
    text += resolveBinding + `
const readingPaging = new WeakMap<object, ChatViewInjected['hooks']['historyPaging']>()
function occurrencePaging(view: import('@deepseek-ai/dsh-client-ui-conversation/client').ConversationHistoryViewV1): ChatViewInjected['hooks']['historyPaging'] {
  let source = readingPaging.get(view)
  if (source !== undefined) return source
  let previous: unknown, value: import('@deepseek-ai/dsh-client-ui-conversation/client').HistoryPagingV1
  source = { subscribe: listener => view.snapshot.subscribe(listener), getSnapshot: () => {
    const snapshot = view.snapshot.getSnapshot()
    if (snapshot !== previous) {
      previous = snapshot
      value = { busy: snapshot.busy, hasOlder: snapshot.hasBefore, detached: snapshot.hasAfter, headChanged: snapshot.headChanged }
    }
    return value
  } }
  readingPaging.set(view, source)
  return source
}
`;
    text = replace(text, 'participation.register(CHAT_READING_VIEW_ID, participant)',
      'participation.register(binding.viewId ?? CHAT_READING_VIEW_ID, participant)');
    text = replace(text, "const folding = ctx.get('chatPresentationConsumer')?.presentation(binding.sessionId)",
      "const folding = binding.viewId === undefined ? ctx.get('chatPresentationConsumer')?.presentation(binding.sessionId)\n        : { foldCompletedTurns: false, stepGrouping: 'none' as const, virtualizeGroupMembers: true }");
    text = replace(text, "historyPaging: historyPagingSource(ctx.get('historyPagingConsumer'), binding.sessionId),",
      "historyPaging: conversation.readingView === undefined ? historyPagingSource(ctx.get('historyPagingConsumer'), binding.sessionId) : occurrencePaging(conversation.readingView),");
    text = replace(text, 'new Map<SessionId, ChatScrollPosition>()', 'new Map<string, ChatScrollPosition>()');
    text = scopedInjects(text, body => {
      body = body.replaceAll('ctx.sessions.binding(sessionId)', 'readingBinding(ctx.sessions, sessionId, readingScope)');
      if (!body.includes('chatScroll:')) return body;
      body = body.replaceAll('chatScrollPositions.delete(sessionId)', 'chatScrollPositions.delete(scrollKey)')
        .replaceAll('chatScrollPositions.set(sessionId, position)', 'chatScrollPositions.set(scrollKey, position)')
        .replaceAll('chatScrollPositions.get(sessionId)', 'chatScrollPositions.get(scrollKey)');
      body = replace(body, 'const session = binding.session', `const session = binding.session
        const reading = ctx.uiConversation.binding(binding).readingView
        const scrollKey = binding.viewId === undefined ? sessionId : JSON.stringify([sessionId, binding.viewId])`);
      return replace(body, '...windowCommitInjection(ctx, binding),', `...windowCommitInjection(ctx, binding),
          ...reading === undefined ? {} : { mountedChatSource: {
            readLatest: async (signal: AbortSignal) => { await reading.read({ kind: 'latest' }, signal) },
          } },`);
    });
    return text;
  });
}
