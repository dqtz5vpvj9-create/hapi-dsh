/** A live official composer endpoint; neither editor nor submission is replaced. */
import { randomId } from './random-id.ts';
import { useEffect, useMemo, useRef } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { InputState, ReferenceInsert } from '@deepseek-ai/dsh-client-ui-conversation/client';
import type {} from '@deepseek-ai/dsh-client-ui-input-trigger/client';
import type { SourceComposerBridge } from './source-composer.tsx';
import { handoffDraftMatches, type HandoffDraft, type HandoffEndpoint, type HandoffReference } from './draft-handoff.ts';
import type {} from './workspace-ui.ts';
import type {} from './pane-navigation.ts';

/** InputState publishes clipboard coordinates; public mutation spans use one cell per chip. */
export function handoffDetectEnd(state: Pick<InputState, 'draft' | 'occurrences' | 'claim'>): number {
    return state.draft.length - state.occurrences.reduce((sum, ref) => sum + ref.length - 1, 0)
        - (state.claim ? state.claim.token.trimEnd().length - 1 : 0);
}
function references(state: InputState): HandoffReference[] {
    return state.occurrences.map(({ occurrenceId: _id, appearance, invalid, ...reference }) => ({ ...reference,
        ...(appearance === undefined ? {} : { appearance }), ...(invalid === undefined ? {} : { invalid }) }));
}
type Props = PropsRuntime<'conversation.input.dock'>;

export function installDraftHandoffReceiver(ctx: Context, bridge: SourceComposerBridge): () => void {
    const scope = ctx.inject(['hapiWorkspaceUi'], owner => {
        const handoffs = owner.hapiWorkspaceUi.handoffs;
        const Receiver = (props: Props) => {
            const native = props.useProjection('hapi'), observed = props.useProjection('hapiObserved'), projection = native ?? observed;
            const input = props.useInput(value => value), pane = owner.get('hapiWorkspacePane');
            const latest = useRef({ props, projection, observed }); latest.current = { props, projection, observed };
            const source = useMemo(() => projection && !observed?.sidechain && pane ? {
                hubId: projection.hubId, sessionId: projection.hapiSessionId, displayId: props.sessionId, hostId: pane.hostId,
            } : null, [projection?.hubId, projection?.hapiSessionId, observed?.sidechain, props.sessionId, pane]);
            useEffect(() => {
                if (!source || !pane) return;
                let generation: ReturnType<typeof owner.sessions.binding>, bindingId = randomId();
                const live = () => {
                    const current = latest.current, binding = owner.sessions.binding(props.sessionId);
                    if (!binding || current.observed?.sidechain || current.projection?.hubId !== source.hubId
                        || current.projection?.hapiSessionId !== source.sessionId) throw new Error('The original source composer binding changed. Both drafts are retained.');
                    if (generation !== binding) { generation = binding; bindingId = randomId(); }
                    return { binding, facade: owner.conversation.input.for(binding.ctx) };
                };
                const capture = (): HandoffDraft => {
                    const { facade } = live(), state = facade.state.getSnapshot();
                    if (state.phase === 'adjudicating' || state.phase === 'submitting') throw new Error('Wait for the original composer submission to finish before transferring its draft.');
                    return { bindingId, paneId: pane.paneId, revision: state.draftRev, text: state.draft,
                        references: references(state), attachmentIds: [...state.attachmentIds],
                        ...(state.claim ? { command: state.claim.token } : {}),
                        files: bridge.captureFiles(props.sessionId, state.attachmentIds).map(file => ({ id: file.id, file: file.file })) };
                };
                const writable = (): boolean => {
                    try {
                        const state = live().facade.state.getSnapshot(), view = pane.state.getSnapshot();
                        return !latest.current.projection?.readOnly && view.visible && view.focused && !['adjudicating', 'submitting'].includes(state.phase);
                    } catch { return false; }
                };
                const endpoint: HandoffEndpoint = {
                    address: source, paneId: pane.paneId, retain: pane.retainForDraftTransfer, capture, writable,
                    async insert(draft, expected, signal) {
                        const initial = live();
                        if (!writable() || !handoffDraftMatches(capture(), expected)) throw new Error('The target composer changed before the transfer started.');
                        if (draft.references.some(reference => reference.invalid)) throw new Error('The original draft has an unresolved reference. Review it in the original composer before transferring.');
                        // Claim resolution is a read-only public catalog action.
                        // It never executes a slash command or submits text.
                        const claim = draft.command ? await owner.get('inputTriggers')?.sessionOf(initial.binding.ctx).resolveClaim(draft.command.trimEnd(), signal) : undefined;
                        if (draft.command && !claim) throw new Error('The target cannot restore the original command chip. The original draft has not been cleared.');
                        signal.throwIfAborted();
                        if (live().binding !== initial.binding || !writable() || !handoffDraftMatches(capture(), expected)) throw new Error('The target changed while restoring its command catalog.');
                        const files = draft.files.map(item => item.file);
                        const undoFiles = await bridge.addFiles(props.sessionId, files, signal);
                        let textChanged = false;
                        try {
                            signal.throwIfAborted();
                            const current = capture(), before = initial.facade.state.getSnapshot();
                            const originalFiles = current.files.filter(file => expected.attachmentIds.includes(file.id));
                            const addedFiles = current.files.filter(file => !expected.attachmentIds.includes(file.id));
                            if (!writable() || live().binding !== initial.binding || current.bindingId !== expected.bindingId || current.revision !== expected.revision
                                || current.text !== expected.text || JSON.stringify(current.references) !== JSON.stringify(expected.references)
                                || originalFiles.length !== expected.files.length || originalFiles.some((item, index) => item.id !== expected.files[index]?.id || item.file !== expected.files[index]?.file)
                                || addedFiles.length !== files.length || addedFiles.some((item, index) => item.file !== files[index])) {
                                throw new Error('The target draft or attachments changed while the original files were being accepted. Both drafts are retained.');
                            }
                            const separator = expected.text && draft.text ? '\n\n' : '', suffix = separator + draft.text;
                            const offset = handoffDetectEnd(before) + separator.length;
                            if (suffix) {
                                const end = handoffDetectEnd(before);
                                if (!latest.current.props.inputActions.insertText(suffix, { start: end, end, draftRev: before.draftRev })) throw new Error('The official target editor refused this changed draft.');
                                textChanged = true;
                            }
                            // Replace rightmost reference spans first. Earlier
                            // clipboard offsets remain exact; private Lexical
                            // nodes and other plugins' stores are never read.
                            for (const reference of [...draft.references].reverse()) {
                                const state = initial.facade.state.getSnapshot(), start = offset + reference.offset;
                                const ref: ReferenceInsert = { source: reference.source, ref: reference.ref, label: reference.label,
                                    clipboardText: reference.clipboardText, ...(reference.appearance ? { appearance: reference.appearance } : {}) };
                                const nextCharacter = draft.text.slice(reference.offset + reference.length, reference.offset + reference.length + 1);
                                if (!initial.facade.insertReference(ref, { start, end: start + reference.length, draftRev: state.draftRev })) throw new Error('The target could not restore every semantic reference. The original draft is retained.');
                                // Public insertion supplies a separating space.
                                // Remove only that known inserted character when
                                // the captured original did not contain it.
                                if (nextCharacter !== ' ' && !latest.current.props.inputActions.insertText('', {
                                    start: start + 1, end: start + 2, draftRev: initial.facade.state.getSnapshot().draftRev,
                                })) throw new Error('The target reference separator changed during transfer.');
                            }
                            if (claim) {
                                const state = initial.facade.state.getSnapshot(), end = draft.command!.trimEnd().length;
                                if (!initial.facade.beginCommand(claim, { start: 0, end, draftRev: state.draftRev })) throw new Error('The target could not restore the command chip. The original draft is retained.');
                            }
                            const result = capture();
                            if (live().binding !== initial.binding || result.text !== expected.text + suffix) throw new Error('The target editor did not preserve the captured text exactly. Inspect both drafts before continuing.');
                            latest.current.props.inputActions.persistDraft(); return result;
                        } catch (error) { if (!textChanged) undoFiles(); throw error; }
                    },
                    clear(expected) {
                        try {
                            if (!handoffDraftMatches(capture(), expected)) return false;
                            latest.current.props.inputActions.setDraft(''); bridge.removeFiles(props.sessionId, expected.files);
                            latest.current.props.inputActions.persistDraft();
                            const after = capture(); return after.text === '' && !after.attachmentIds.length;
                        } catch { return false; }
                    },
                    focus() { pane.revealConversation(); live().facade.focus(); },
                };
                const unregister = handoffs.register(endpoint), stop = pane.state.subscribe(handoffs.changed);
                return () => { stop(); unregister(); };
            }, [handoffs, source, pane, props.sessionId]);
            useEffect(handoffs.changed, [handoffs, input, projection]);
            return null;
        };
        return owner.slots.inject('conversation.input.dock', () => owner.slots.register({ name: 'conversation.input.dock', id: 'hapi.draft-handoff', order: -81 }, Receiver));
    });
    return () => { void scope.dispose(); };
}
