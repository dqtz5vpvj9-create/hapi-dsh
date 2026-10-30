/** Single-use, exact-source migration. This file is removed by its guarded application job. */
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
const parent = execFileSync('git', ['rev-parse', 'HEAD^'], { encoding: 'utf8' }).trim();
if (parent !== '489d0c161d0423ce3406c8917725b95769f03145') throw new Error('Reading migration parent changed.');
const changed = [];
function once(text, before, after, count = 1) {
  if (text.split(before).length !== count + 1) throw new Error(`Migration seam changed: ${before.slice(0, 120)}`);
  return text.replaceAll(before, after);
}
async function edit(file, change) {
  const before = await readFile(file, 'utf8'), after = change(before);
  if (before === after) throw new Error(`No source change in ${file}`);
  await writeFile(file, after); changed.push(file);
}
await edit('scripts/dsh-ext/prepare.mjs', text => {
  text = once(text, "import { applyInputContracts } from './input-contracts.mjs';", "import { applyInputContracts } from './input-contracts.mjs';\nimport { applyReadingOccurrences } from './reading-occurrences.mjs';");
  text = once(text, "['packages/api/session-controller', 'packages/client/ui-conversation', 'packages/client/ui-chat']", "['packages/api/session-controller', 'packages/client/ui-slots', 'packages/client/ui-renderer', 'packages/client/ui-session', 'packages/client/ui-conversation', 'packages/client/ui-chat']");
  text = once(text, 'await applyInputContracts(directory);', 'await applyInputContracts(directory);\n  await applyReadingOccurrences(directory);');
  return once(text, "'reader-publication.mjs', 'input-contracts.mjs'", "'reader-publication.mjs', 'input-contracts.mjs', 'reading-occurrences.mjs'");
});
await edit('scripts/dsh-ext/install-extension.mjs', text => once(text, "  '@deepseek-ai/dsh-client-ui-conversation',", "  '@deepseek-ai/dsh-client-ui-slots',\n  '@deepseek-ai/dsh-client-ui-renderer',\n  '@deepseek-ai/dsh-client-ui-session',\n  '@deepseek-ai/dsh-client-ui-conversation',"));
await edit('tests/hhpi-extension-install.test.mjs', text => once(text, 'all three source-built', 'the complete six-package source-built'));
await edit('scripts/dsh-ext/reading-occurrences.mjs', text => once(text,
  "'completeWindowHistory: 1 as const,\\n    readingOccurrences: 1 as const,'",
  "\"completeWindowHistory: 1 as const,\\n    ...Reflect.get(globalThis, '__DSH_CLIENT_READING_OCCURRENCES') === 'off' ? {} : { readingOccurrences: 1 as const },\""));
await edit('src/client/remote-pane.ts', text => {
  for (const name of ['readAttachment', 'updateQueue', 'rename', 'command']) text = once(text, `this.owner.${name}(...args)`, `(this.owner as SessionFace).${name}(...args)`);
  return once(text, '  owns(binding: SessionBinding): boolean', "  isPaneContext(ctx: Context): boolean { return (ctx as Context & { [paneScope]?: PaneTag })[paneScope] !== undefined }\n  owns(binding: SessionBinding): boolean");
});
await edit('src/client/remote-sessions.ts', text => {
  text = once(text, "import { RemoteSourceHistory } from './remote-history.ts'", "import { RemoteSourceHistory } from './remote-history.ts'\nimport { RemotePaneViews } from './remote-pane.ts'");
  text = once(text, '  private readonly records = new Map<SessionId, RecordOwner>()', '  private readonly records = new Map<SessionId, RecordOwner>()\n  private readonly readingViews = new RemotePaneViews()');
  text = once(text, '  get searchResultLimit(): number { return this.original.searchResultLimit }', `  get searchResultLimit(): number { return this.original.searchResultLimit }
  ownsBinding(binding: SessionBinding): boolean {
    return this.readingViews.owns(binding) || this.binding(binding.sessionId) === binding || this.original.ownsBinding?.(binding) === true
  }
  bindingOf(ctx: Context): SessionBinding | undefined {
    if (this.readingViews.isPaneContext(ctx)) return this.readingViews.bindingOf(ctx)
    const id = this.scopeOf(ctx)
    return this.original.bindingOf?.(ctx) ?? (id === undefined ? undefined : this.records.get(id)?.binding)
  }
  openReadingView(reference: SessionReference, viewId: string): SessionReference | undefined {
    this.lifetime.signal.throwIfAborted()
    if (!isSourceSessionId(reference.sessionId)) return this.original.openReadingView?.(reference, viewId)
    if (this.binding(reference.sessionId) !== reference.binding) throw new Error('The canonical source Session is no longer retained.')
    if (this.windowCommit?.readingOccurrences !== 1) throw new Error('Independent source reading requires the complete reading-occurrence extension set.')
    return this.readingViews.open(this.retain(reference.sessionId, { source: 'hapiWorkspace' }), viewId)
  }`);
  text = once(text, "  sessionOf(ctx: Context): SessionFace | undefined { const id = this.scopeOf(ctx); return id ? this.records.get(id)?.session ?? this.original.sessionOf(ctx) : undefined }",
    "  sessionOf(ctx: Context): SessionFace | undefined {\n    if (this.readingViews.isPaneContext(ctx)) return this.readingViews.bindingOf(ctx)?.session\n    const id = this.scopeOf(ctx); return id ? this.records.get(id)?.session ?? this.original.sessionOf(ctx) : undefined\n  }");
  return once(text, '    this.lifetime.abort(); if (this.timer)', '    this.readingViews.dispose()\n    this.lifetime.abort(); if (this.timer)');
});
await edit('src/client/source-sessions.ts', text => once(text,
  "  get searchResultLimit(): number { return this.original.searchResultLimit }", `  get searchResultLimit(): number { return this.original.searchResultLimit }
  ownsBinding(binding: SessionBinding): boolean { return this.binding(binding.sessionId) === binding || this.original.ownsBinding?.(binding) === true }
  bindingOf(ctx: Context): SessionBinding | undefined { return this.original.bindingOf?.(ctx) }
  openReadingView(reference: SessionReference, viewId: string): SessionReference | undefined { return this.original.openReadingView?.(reference, viewId) }`));
await edit('src/client/surface/session-view.tsx', text => {
  text = once(text, "import { isSourceSessionId } from '../../remote/protocol.ts'", "import { isSourceSessionId } from '../../remote/protocol.ts'\nimport type { RemotePaneSession } from '../remote-pane.ts'");
  text = once(text, '    const entries = new Map<string, Entry>()', '    const entries = new Map<string, Entry>()\n    const readingReferences = new Map<string, SessionReference>()');
  text = once(text, '            let entry: Entry = { ...options,', `            if (isSourceSessionId(options.reference.sessionId)) {
                const reference = ctx.sessions.openReadingView?.(options.reference, identity)
                if (!reference) throw new Error('This Host has no independent official source reader.')
                try {
                    const reading = ctx.uiConversation.binding(reference.binding).readingView
                    if (!reading) throw new Error('The official Conversation did not install the Pane reading window.')
                    ;(reference.binding.session as RemotePaneSession).attach(reading)
                } catch (error) { reference.release(); throw error }
                readingReferences.set(identity, reference)
                options = { ...options, reference }
            }
            let entry: Entry = { ...options,`);
  text = once(text, 'bindRemotePaneReading(options.target, options.reference, options.navigation)', 'bindRemotePaneReading(ctx, options.target, options.reference, options.navigation)');
  text = once(text, '                    removed = Promise.all([unmounted, preparation.dispose()]).then(() => {})', `                    removed = Promise.all([unmounted, preparation.dispose()]).then(() => {
                        readingReferences.get(identity)?.release()
                        readingReferences.delete(identity)
                    })`);
  text = once(text, '            initialHistory.clear(); entries.clear(); publish()', `            initialHistory.clear(); entries.clear(); publish()
            for (const reference of readingReferences.values()) reference.release()
            readingReferences.clear()`);
  // Direct sources use the very same mounted navigation/commit/layout path as the button.
  const before = `            const before = reference.binding.eventSource.getSnapshot().entries[0]?.event.seq
            const session = reference.binding.session as SessionReference['binding']['session'] & Partial<SourceViewportSession>
            if (!await wait(session.loadViewportPage ? session.loadViewportPage(pagePlan.next(port)) : session.loadOlder())) return false
            if (!await nextActiveFrame()) return false
            const after = reference.binding.eventSource.getSnapshot().entries[0]?.event.seq`;
  const after = `            const session = reference.binding.session as SessionReference['binding']['session'] & Partial<SourceViewportSession & RemotePaneSession>
            const direct = isSourceSessionId(reference.sessionId)
            const before = direct ? session.readingView?.snapshot.getSnapshot().before : reference.binding.eventSource.getSnapshot().entries[0]?.event.seq
            if (direct) {
                const control = resolveMountedChatForPane(target)
                if (!control) return false
                if (!await wait(control.loadOlder(stopped))) return false
            } else if (!await wait(session.loadViewportPage ? session.loadViewportPage(pagePlan.next(port)) : session.loadOlder())) return false
            if (!await nextActiveFrame()) return false
            const after = direct ? session.readingView?.snapshot.getSnapshot().before : reference.binding.eventSource.getSnapshot().entries[0]?.event.seq`;
  return once(text, before, after);
});
await edit('src/client/composer-autosave-seat.tsx', text => {
  text = once(text, 'const binding = ctx.sessions.binding(props.sessionId)', 'const binding = props.sessionBinding ?? ctx.sessions.binding(props.sessionId)', 2);
  text = once(text, "composerDraftKey(pane?.hostId ?? 'local', props.sessionId, observed?.sidechain ? undefined : source ?? undefined)", "composerDraftKey(pane?.hostId ?? 'local', props.sessionBinding?.viewId === undefined ? props.sessionId : JSON.stringify([props.sessionId, pane?.paneId ?? props.sessionBinding.viewId]), observed?.sidechain ? undefined : source ?? undefined)");
  return once(text, '[key, props.sessionId, props.inputActions]', '[key, props.sessionId, props.sessionBinding, props.inputActions]');
});
await edit('src/client/composer-enter/index.tsx', text => once(text,
  'binding = owner.sessions.binding(latest.sessionId)', 'binding = latest.sessionBinding ?? owner.sessions.binding(latest.sessionId)'));
await edit('src/client/remote-controls.tsx', text => {
  text = once(text, 'ctx.sessions.binding(props.sessionId)?.session', '(props.sessionBinding ?? ctx.sessions.binding(props.sessionId))?.session', 2);
  return once(text, 'const scope = ctx.sessions.scope(props.sessionId)', 'const scope = props.sessionBinding?.ctx ?? ctx.sessions.scope(props.sessionId)');
});
// Remove only the enumerated single-use migration input and job after successful application.
await unlink('scripts/hhpi-reading-bootstrap.mjs');
await unlink('.github/workflows/hhpi-reading-bootstrap.yml');
console.log(JSON.stringify({ changed, removed: ['scripts/hhpi-reading-bootstrap.mjs', '.github/workflows/hhpi-reading-bootstrap.yml'] }));
