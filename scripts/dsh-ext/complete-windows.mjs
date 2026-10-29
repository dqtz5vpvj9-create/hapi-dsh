/** Optional complete-window input, applied structurally to pinned TypeScript sources only. */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import ts from 'typescript';
function parse(path, text) { return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS); }
function definition(source, name) {
  const nodes = source.statements.filter(node => (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) && node.name?.text === name);
  if (nodes.length !== 1) throw new Error(`Pinned source contract ${name} was not found exactly once.`);
  return nodes[0];
}
function applyEdits(text, edits) {
  let previous = text.length + 1;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    if (edit.end > previous) throw new Error('Overlapping DSH source edits.');
    text = text.slice(0, edit.start) + edit.text + text.slice(edit.end); previous = edit.start;
  }
  return text;
}
async function addMembers(root, file, name, members) {
  const path = join(root, file), text = await readFile(path, 'utf8'), source = parse(path, text), node = definition(source, name);
  await writeFile(path, applyEdits(text, [{ start: node.end - 1, end: node.end - 1, text: `\n${members}\n` }]));
}
export async function applyCompleteWindows(root) {
  const contract = 'packages/api/session-controller/src/client/contract/history-source.ts';
  await addMembers(root, contract, 'HistoryFeedV1', `
  /** Opt-in: every read and delta snapshot describes the complete bounded window. */
  readonly mode?: 'complete-window'
  /** Synchronous acknowledgement at the official reader publication boundary. */
  readonly publication?: {
    validate(version: SourceVersion): void
    accept(version: SourceVersion): void
    discard(version: SourceVersion): void
  }
  /** Recover this reading region; explicit latest is a separate navigation. */
  refresh?(budget: Budget, signal: AbortSignal): Promise<HistorySnapshotV1>
`);
  await addMembers(root, contract, 'HistoryDeltaV1', `
  /** Required by complete-window feeds, including authoritative cursors and gap state. */
  readonly snapshot?: HistorySnapshotV1
`);
  await addMembers(root, 'packages/client/ui-conversation/src/client/contract/history-view.ts', 'HistoryViewSnapshotV1', `
  /** Opaque source boundaries; undefined preserves the legacy event-coordinate path. */
  readonly before?: string | null
  readonly after?: string | null
`);
  const file = 'packages/client/ui-conversation/src/client/conversation/history-view.ts';
  const path = join(root, file), text = await readFile(path, 'utf8'), source = parse(path, text), owner = definition(source, 'BoundHistoryView');
  const member = name => {
    const nodes = owner.members.filter(node => node.name?.getText(source) === name);
    if (nodes.length !== 1) throw new Error(`Pinned BoundHistoryView.${name} was not found exactly once.`);
    return nodes[0];
  };
  const edits = [];
  const prepend = (name, code) => {
    const body = member(name).body; if (!body) throw new Error(`Missing method body: ${name}`);
    const start = body.getStart(source) + 1; edits.push({ start, end: start, text: `\n${code}\n` });
  };
  prepend('read', `    this.assertLive(); signal?.throwIfAborted()
    await this.openingPromise
    if (this.feed?.mode === 'complete-window') return this.requestComplete(request, signal)`);
  prepend('startPage', `    if (this.feed?.mode === 'complete-window') return this.requestComplete(request)`);
  prepend('resync', `    if (this.feed?.mode === 'complete-window') return this.requestComplete(null)`);
  prepend('applyDelta', `    if (this.feed?.mode === 'complete-window') {
      const follow = this.followAbort
      return this.serializeComplete(async () => {
        if (follow?.signal.aborted || this.released) return false
        if (delta.base !== this.versionCursor || delta.snapshot?.version !== delta.version) {
          throw Object.assign(new Error('The complete history stream has a version gap.'), { code: 'STALE_VERSION' })
        }
        await this.commitSnapshot(delta.snapshot)
        this.headChanged = delta.headChanged
        this.publish()
        return false
      })
    }`);
  const commit = member('commitSnapshot'), bodyStart = commit.body.getStart(source) + 1;
  let inner = text.slice(bodyStart, commit.body.end - 1);
  const signalEdits = [];
  const visitSignal = node => {
    if (ts.isPropertyAccessExpression(node) && node.getText(source) === 'this.abort.signal') signalEdits.push({ start: node.getStart(source) - bodyStart, end: node.end - bodyStart, text: 'commitSignal' });
    else ts.forEachChild(node, visitSignal);
  };
  ts.forEachChild(commit.body, visitSignal); inner = applyEdits(inner, signalEdits);
  edits.push({ start: commit.getStart(source), end: commit.end, text: `private async commitSnapshot(snapshot: HistorySnapshotV1, commitSignal: AbortSignal = this.abort.signal): Promise<void> {
    const publication = this.feed?.mode === 'complete-window' ? this.feed.publication : undefined
    const previous = this.completeCandidate
    if (this.feed?.mode === 'complete-window' && !publication) throw new Error('A complete-window source must acknowledge publication.')
    publication?.validate(snapshot.version)
    this.completeCandidate = snapshot
    try {${inner}
    } catch (error) {
      publication?.discard(snapshot.version)
      throw error
    } finally { this.completeCandidate = previous }
  }` });
  const startMethod = member('start');
  const awaitInitial = node => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'this.commitSnapshot' && !ts.isAwaitExpression(node.parent)) edits.push({ start: node.getStart(source), end: node.getStart(source), text: 'await ' });
    ts.forEachChild(node, awaitInitial);
  };
  ts.forEachChild(startMethod.body, awaitInitial);
  const publish = member('publishWindow');
  const assemblerCalls = publish.body.statements.filter(statement => ts.isVariableStatement(statement)
    && statement.declarationList.declarations.some(declaration => declaration.initializer && ts.isCallExpression(declaration.initializer)
      && declaration.initializer.expression.getText(source) === 'this.assembler.replaceWindow'));
  if (assemblerCalls.length !== 1) throw new Error('The official window publication boundary changed.');
  prepend('publishWindow', `    if (this.feed?.mode === 'complete-window') this.feed.publication!.validate(version)`);
  edits.push({ start: assemblerCalls[0].end, end: assemblerCalls[0].end, text: `
    if (this.feed?.mode === 'complete-window') {
      this.feed.publication!.accept(version)
      if (this.completeCandidate?.version === version) {
        this.beforeCursor = this.completeCandidate.before
        this.afterCursor = this.completeCandidate.after
      }
    }` });
  const snapshot = member('currentSnapshot');
  const returns = snapshot.body.statements.filter(node => ts.isReturnStatement(node) && node.expression && ts.isObjectLiteralExpression(node.expression));
  if (returns.length !== 1) throw new Error('The official view snapshot shape changed.');
  const at = returns[0].expression.getStart(source) + 1;
  edits.push({ start: at, end: at, text: `
      before: this.feed?.mode === 'complete-window' ? this.beforeCursor : undefined,
      after: this.feed?.mode === 'complete-window' ? this.afterCursor : undefined,` });
  edits.push({ start: owner.end - 1, end: owner.end - 1, text: `
  private completeSerial: Promise<unknown> = Promise.resolve()
  private completeCandidate: HistorySnapshotV1 | null = null
  private beforeCursor: string | null = null
  private afterCursor: string | null = null
  private readonly completeRequests = new Map<string, {
    promise: Promise<HistoryViewSnapshotV1>; abort: AbortController; users: number; settled: boolean
  }>()
  /** Page reads and source revisions share this same reader's publication queue. */
  private serializeComplete<T>(operation: () => Promise<T>): Promise<T> {
    const work = this.completeSerial.then(operation, operation)
    this.completeSerial = work.then(() => {}, () => {})
    return work
  }
  private requestComplete(request: HistoryReadV1 | null, signal?: AbortSignal): Promise<HistoryViewSnapshotV1> {
    this.assertLive(); signal?.throwIfAborted()
    const key = JSON.stringify(request)
    let held = this.completeRequests.get(key)
    if (!held) {
      if (this.completeRequests.size >= 16) return Promise.reject(Object.assign(new Error('The reader navigation queue is full.'), { code: 'CAPACITY_EXCEEDED' }))
      const abort = new AbortController()
      const work = this.serializeComplete(() => this.readComplete(request, AbortSignal.any([abort.signal, this.abort.signal])))
      held = { promise: work, abort, users: 0, settled: false }; this.completeRequests.set(key, held)
      const current = held
      void work.finally(() => { current.settled = true; if (this.completeRequests.get(key) === current) this.completeRequests.delete(key) }).catch(() => {})
    }
    const current = held; ++current.users
    const waited = signal ? new Promise<HistoryViewSnapshotV1>((resolve, reject) => {
      const stop = (): void => { signal.removeEventListener('abort', stop); reject(signal.reason ?? new DOMException('Reader cancelled.', 'AbortError')) }
      signal.addEventListener('abort', stop, { once: true })
      current.promise.then(value => { signal.removeEventListener('abort', stop); resolve(value) }, error => { signal.removeEventListener('abort', stop); reject(error) })
      if (signal.aborted) stop()
    }) : current.promise
    return waited.finally(() => { if (--current.users === 0 && !current.settled) current.abort.abort() })
  }
  private async readComplete(request: HistoryReadV1 | null, signal: AbortSignal): Promise<HistoryViewSnapshotV1> {
    this.assertLive(); signal.throwIfAborted()
    const feed = this.feed
    if (!feed || feed.mode !== 'complete-window') throw new Error('The complete-window source is not open.')
    this.followAbort?.abort(); this.followAbort = null
    this.busy = true; this.publish()
    let candidate: HistorySnapshotV1 | undefined
    try {
      if (request === null) {
        if (!feed.refresh) throw Object.assign(new Error('The source cannot recover this reading window.'), { code: 'TARGET_UNAVAILABLE' })
        candidate = await feed.refresh(HISTORY_VIEW_BUDGET, signal)
      } else candidate = await feed.read(request, HISTORY_VIEW_BUDGET, signal)
      signal.throwIfAborted()
      await this.commitSnapshot(candidate, signal)
      if (this.correction === 'failed') throw Object.assign(new Error(this.correctionError ?? 'The reader position could not be restored.'), { code: 'TARGET_UNAVAILABLE' })
      this.phase = 'ready'; this.failure = null
    } catch (error) {
      if (candidate) feed.publication?.discard(candidate.version)
      if (!this.released && !signal.aborted) {
        this.phase = 'error'
        this.failure = typeof error === 'object' && error !== null && 'code' in error
          && ['STALE_VERSION', 'CAPACITY_EXCEEDED', 'TARGET_UNAVAILABLE', 'DISPOSED'].includes(String(error.code))
          ? error.code as HistoryViewSnapshotV1['failure'] : 'TARGET_UNAVAILABLE'
      }
      throw error
    } finally {
      this.busy = false; this.publish()
      if (!this.released && this.versionCursor !== null) this.startFollow(this.versionCursor)
    }
    return this.currentSnapshot()
  }
` });
  const output = applyEdits(text, edits), diagnostics = parse(path, output).parseDiagnostics;
  if (diagnostics.length) throw new Error(ts.flattenDiagnosticMessageText(diagnostics[0].messageText, '\n'));
  await writeFile(path, output);
  const entry = join(root, 'packages/api/session-controller/src/client/index.ts');
  await writeFile(entry, `${await readFile(entry, 'utf8')}\n/** Optional complete-window reader contract installed with this source extension. */\nexport const COMPLETE_WINDOW_HISTORY_VERSION = 1 as const\n`);
}
