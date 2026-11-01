/** Optional source-level composer admission policy. Native optimistic sends stay unchanged. */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import ts from 'typescript';

function replace(text, before, after, count = 1) {
  if (text.split(before).length !== count + 1) throw new Error(`Pinned input acceptance seam changed: ${before.slice(0, 140)}`);
  return text.replaceAll(before, after);
}
async function edit(root, file, transform) {
  const path = join(root, file), text = transform(await readFile(path, 'utf8'));
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  if (source.parseDiagnostics.length) throw new Error(`${file}: ${ts.flattenDiagnosticMessageText(source.parseDiagnostics[0].messageText, '\n')}`);
  await writeFile(path, text);
}

export async function applyInputAcceptance(root) {
  await edit(root, 'packages/api/session-controller/src/client/contract/session.ts', text => replace(text,
    'export interface ISession {', `export interface ISession {
  /**
   * Optional composer policy: retain the draft until the default sink accepts
   * ownership. A local durable queue may accept before any network delivery.
   * Absence preserves optimistic clear and concurrent native DSH submissions.
   */
  readonly inputCommitPolicy?: 'after-acceptance'
`));

  await edit(root, 'packages/client/ui-conversation/src/client/input/hub.ts', text => replace(text,
    '      actx,\n      submissionState:', '      actx,\n      inputCommitPolicy: session.inputCommitPolicy,\n      submissionState:'));

  await edit(root, 'packages/client/ui-conversation/src/client/contract/input.ts', text => replace(text,
    "  | { readonly type: 'commit-draft'; readonly retainSuffixOf: string | null }",
    "  | { readonly type: 'commit-draft'; readonly retainSuffixOf: string | null; readonly attempt?: SubmitAttempt }"));

  await edit(root, 'packages/client/ui-conversation/src/client/input/machine.ts', text => {
    text = replace(text, "  private phase: InputState['phase'] = 'plain'", `  /** Only the opted-in ordinary sink waits; editing stays in the plain phase. */
  private acceptanceAttempt: SubmitAttempt | undefined
  constructor(private readonly commitAfterAcceptance = false) {}

  get awaitingAcceptance(): boolean { return this.acceptanceAttempt !== undefined }

  private phase: InputState['phase'] = 'plain'`);
    text = replace(text,
      '  private detachedEffects(attempt: SubmitAttempt): readonly InputEffect[] {\n    return [',
      `  private detachedEffects(attempt: SubmitAttempt): readonly InputEffect[] {
    if (this.commitAfterAcceptance) {
      this.acceptanceAttempt = attempt
      return [{ type: 'default-sink', attempt, draft: attempt.draftSnapshot, mode: attempt.mode }]
    }
    return [`);
    text = replace(text,
      "    if (this.phase === 'adjudicating' || this.phase === 'submitting') return []",
      "    if (this.awaitingAcceptance || this.phase === 'adjudicating' || this.phase === 'submitting') return []");
    text = replace(text,
      `    if (!this.detached.delete(ev.attempt.seq)) return []
    const text = ev.message ?? ev.outcome?.text
    if (text === undefined) return []
    return [{ type: 'notice', level: ev.ok && ev.outcome?.kind !== 'error' ? 'info' : 'error', text }]`,
      `    if (!this.detached.delete(ev.attempt.seq)) return []
    const waiting = this.acceptanceAttempt?.seq === ev.attempt.seq
    if (waiting) this.acceptanceAttempt = undefined
    const effects: InputEffect[] = waiting && ev.ok
      ? [{ type: 'commit-draft', retainSuffixOf: ev.attempt.draftSnapshot, attempt: ev.attempt }]
      : []
    const text = ev.message ?? ev.outcome?.text
    if (text !== undefined) effects.push({ type: 'notice', level: ev.ok && ev.outcome?.kind !== 'error' ? 'info' : 'error', text })
    return effects`);
    return replace(text, '    this.detached.clear()\n    this.phase', '    this.detached.clear()\n    this.acceptanceAttempt = undefined\n    this.phase');
  });

  await edit(root, 'packages/client/ui-conversation/src/client/input/facade.ts', text => {
    text = replace(text, 'export interface SessionInputDeps {', `export interface SessionInputDeps {
  /** Optional local admission boundary; the sink must resolve success only after taking ownership. */
  inputCommitPolicy?: 'after-acceptance' | undefined`);
    text = replace(text, '  private readonly core = new SubmitMachine()', '  private readonly core: SubmitMachine\n  private readonly commitAfterAcceptance: boolean');
    text = replace(text, '  constructor(private readonly deps: SessionInputDeps) {', `  constructor(private readonly deps: SessionInputDeps) {
    this.commitAfterAcceptance = deps.inputCommitPolicy === 'after-acceptance'
      && Reflect.get(globalThis, '__DSH_CLIENT_INPUT_ACCEPTANCE') !== 'off'
    this.core = new SubmitMachine(this.commitAfterAcceptance)`);
    text = replace(text, `  submit(mode: InputSubmitMode = 'queue', source?: 'click' | 'enter'): void {
    if (this.disposed) return`, `  submit(mode: InputSubmitMode = 'queue', source?: 'click' | 'enter'): void {
    if (this.disposed || this.core.awaitingAcceptance
      || (this.commitAfterAcceptance && this.attachmentFlights.size > 0)) return`);
    text = replace(text, '        this.commitSend(attachmentIds)\n        this.notifySubmission(submission)',
      '        if (!this.commitAfterAcceptance) this.commitSend(attachmentIds)\n        this.notifySubmission(submission)');
    text = replace(text, "        void this.deps.defaultSink('', attachmentIds, mode, controller.signal).then((outcome) => {",
      "        void this.callDefaultSink('', attachmentIds, mode, controller.signal).then((outcome) => {");
    text = replace(text, `          if (outcome.kind === 'success') return
          this.restoreAttachments(attachmentIds)`, `          if (outcome.kind === 'success') {
            if (this.commitAfterAcceptance) this.retireAcceptedAttachments(attachmentIds)
            return
          }
          if (!this.commitAfterAcceptance) this.restoreAttachments(attachmentIds)`);
    text = replace(text, `          this.restoreAttachments(attachmentIds)
          this.notify('error', error instanceof Error ? error.message : String(error))`,
      `          if (!this.commitAfterAcceptance) this.restoreAttachments(attachmentIds)
          this.notify('error', error instanceof Error ? error.message : String(error))`);
    text = replace(text, '        this.commitDraft(fx.retainSuffixOf)', '        this.commitDraft(fx.retainSuffixOf, fx.attempt)');
    text = replace(text, '  private commitDraft(retainSuffixOf: string | null): void {', `  private commitDraft(retainSuffixOf: string | null, attempt?: SubmitAttempt): void {
    // A replacement/interleaved edit is a new draft. Only an unchanged sent
    // prefix can be removed without discarding text typed during admission.
    if (attempt !== undefined && retainSuffixOf !== null) {
      const record = this.detachedDrafts.get(attempt.seq)
      if (record === undefined || !this.projection.clipboardText.startsWith(retainSuffixOf)) return
      const prefix = this.projection.occurrences.filter(item => item.offset < retainSuffixOf.length)
      if (prefix.length !== record.occurrences.length || record.occurrences.some((old, index) => {
        const next = prefix[index]
        return next === undefined || old.occurrenceId !== next.occurrenceId || old.source !== next.source
          || old.ref !== next.ref || old.offset !== next.offset || old.length !== next.length
      })) return
    }`);
    text = replace(text, `    const attachmentIds = [...this.attachmentIds]
    this.attachmentIds = []
    const occurrences`, `    const attachmentIds = [...this.attachmentIds]
    if (!this.commitAfterAcceptance) this.attachmentIds = []
    const occurrences`);
    text = replace(text, 'this.deps.defaultSink(draft.trim(), attachmentIds, mode, attempt.signal)', 'this.callDefaultSink(draft.trim(), attachmentIds, mode, attempt.signal)');
    text = replace(text, 'this.deps.defaultSink(out.trim(), attachmentIds, mode, attempt.signal)', 'this.callDefaultSink(out.trim(), attachmentIds, mode, attempt.signal)');
    text = replace(text, `        this.detachedDrafts.delete(attempt.seq)
        this.dispatchRun(({ type: 'sink-settled', attempt, ok: true, outcome }))`, `        const record = this.detachedDrafts.get(attempt.seq)
        if (this.commitAfterAcceptance && record !== undefined) this.retireAcceptedAttachments(record.attachmentIds)
        this.dispatchRun(({ type: 'sink-settled', attempt, ok: true, outcome }))
        this.detachedDrafts.delete(attempt.seq)`);
    text = replace(text, `    this.detachedDrafts.delete(attempt.seq)
    this.restoreAttachments(record.attachmentIds)`, `    this.detachedDrafts.delete(attempt.seq)
    if (this.commitAfterAcceptance) {
      // The original editor never cleared. Failure must not overwrite edits
      // or restore attachments the user deliberately removed in the meantime.
      this.dispatchRun({ type: 'sink-settled', attempt, ok: false, ...(message === undefined ? {} : { message }) })
      return
    }
    this.restoreAttachments(record.attachmentIds)`);
    return replace(text, '  private notifySubmission(submission: MessageSubmission | undefined): void {', `  /** Normalize a synchronous local-admission refusal into the existing sink error path. */
  private callDefaultSink(
    text: string, attachmentIds: readonly DraftAttachmentId[], mode: InputSubmitMode, signal: AbortSignal,
  ): Promise<SubmitOutcome> {
    try { return this.deps.defaultSink(text, attachmentIds, mode, signal) }
    catch (error) { return Promise.reject(error) }
  }

  /** Retire only the accepted rail entries; attachments added while waiting survive. */
  private retireAcceptedAttachments(ids: readonly DraftAttachmentId[]): void {
    const submitted = new Set(ids)
    this.attachmentIds = this.attachmentIds.filter(id => !submitted.has(id))
    this.publish()
  }

  private notifySubmission(submission: MessageSubmission | undefined): void {`);
  });
}
