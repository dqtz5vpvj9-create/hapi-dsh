import { useWorkspacePane } from './surface/pane-context.tsx'
/** A view-local hand-off into the actual official composer, preserving semantic chips. */
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import { installSourceComposerBridge, type SourceComposerBridge } from './source-composer.tsx';
import { shareSeedText, shareTargetKey, type ShareTarget } from './share-transfer.ts';
import type { ShareReceiver } from './share-inbox-state.ts';
import type {} from './pane-navigation.ts';
import type {} from './workspace-ui.ts';
import { installComposerAttachmentRecovery } from './composer-attachment-recovery.tsx';
import { handoffDetectEnd, installDraftHandoffReceiver } from './draft-handoff-receiver.tsx';
import { installComposerEnter } from './composer-enter/index.tsx';
import { installComposerAutosave } from './composer-autosave-seat.tsx';
import { installComposerPersistence } from './composer-persistence-seat.tsx';

export function installShareReceiver(ctx: Context, existingBridge?: SourceComposerBridge): () => void {
    const scope = ctx.inject(['slots', 'sessions', 'conversation', 'locale', 'hapiWorkspaceUi'], owner => {
        const inbox = owner.hapiWorkspaceUi.shareInbox, bridge = existingBridge ?? installSourceComposerBridge(owner);
        const enter = installComposerEnter(owner, bridge);
        const autosave = installComposerAutosave(owner);
        const persistence = installComposerPersistence(owner);
        const recovery = installComposerAttachmentRecovery(owner, bridge);
        const handoffs = owner.hapiWorkspaceUi.handoffs, handoffReceiver = installDraftHandoffReceiver(owner, bridge);
        const handoffChanges = handoffs.subscribe(inbox.wake);
        const Receiver = (props: PropsRuntime<'conversation.input.dock'>) => {
            const native = props.useProjection('hapi'), observed = props.useProjection('hapiObserved'), source = native ?? observed;
            const current = useRef({ props, source, observed }); current.current = { props, source, observed };
            const input = props.useInput(value => value), pane = useWorkspacePane(owner);
            const state = useSyncExternalStore(inbox.subscribe, inbox.getSnapshot);
            const language = useSyncExternalStore(listener => owner.locale.subscribe(listener), () => owner.locale.getSnapshot().active);
            const tr = (en: string, zh: string) => language.startsWith('zh') ? zh : en;
            const targets = useMemo(() => {
                const result: ShareTarget[] = [{ kind: 'dsh', hostId: pane?.hostId ?? 'local', sessionId: props.sessionId }];
                if (source?.hubId && !observed?.sidechain) result.push({ kind: 'hapi', hubId: source.hubId, sessionId: source.hapiSessionId });
                return result;
            }, [pane?.hostId, props.sessionId, source?.hubId, source?.hapiSessionId, observed?.sidechain]);
            useEffect(() => {
                const ready = () => {
                    const latest = current.current, binding = owner.sessions.binding(props.sessionId);
                    if (!binding || !pane || !pane.state.getSnapshot().visible || !pane.state.getSnapshot().focused || latest.observed?.sidechain || latest.source?.readOnly) return false;
                    if (!latest.source && /^(?:hapi-codex-|hapi-observed-)/u.test(props.sessionId)) return false;
                    if (latest.source && handoffs.blocksSource({ hubId: latest.source.hubId, sessionId: latest.source.hapiSessionId })) return false;
                    return !['adjudicating', 'submitting'].includes(owner.conversation.input.for(binding.ctx).state.getSnapshot().phase);
                };
                const receiver: ShareReceiver = { ready, async insert(payload, signal) {
                    const binding = owner.sessions.binding(props.sessionId); if (!binding || !ready()) throw new Error('The original composer is not ready.');
                    const facade = owner.conversation.input.for(binding.ctx), before = facade.state.getSnapshot();
                    const seed = shareSeedText(payload), suffix = seed ? `${before.draft ? '\n\n' : ''}${seed}` : '';
                    const files = payload.files.map(file => new File([file.blob], file.name, { type: file.type }));
                    const undo = await bridge.addFiles(props.sessionId, files, signal);
                    try {
                        signal.throwIfAborted();
                        if (!ready() || owner.sessions.binding(props.sessionId) !== binding || facade.state.getSnapshot().draftRev !== before.draftRev) throw new Error('The composer changed while preparing the shared files. The original share is retained.');
                        const end = handoffDetectEnd(before);
                        if (suffix && !current.current.props.inputActions.insertText(suffix, { start: end, end, draftRev: before.draftRev })) throw new Error('The composer changed before the shared text could be inserted.');
                        current.current.props.inputActions.persistDraft(); pane?.revealConversation(); facade.focus();
                        return { afterText: facade.state.getSnapshot().draft };
                    } catch (error) { undo(); throw error; }
                } };
                const stops = targets.map(target => inbox.register(target, receiver));
                stops.push(pane?.state.subscribe(inbox.wake) ?? (() => {}));
                return () => { for (const stop of stops) stop(); };
            }, [inbox, handoffs, props.sessionId, pane, targets]);
            useEffect(inbox.wake, [inbox, source, input.phase, input.draftRev]);
            const target = state.record?.hapiDshDelivery?.target;
            if (!target || !targets.some(value => shareTargetKey(value) === shareTargetKey(target))) return null;
            if (state.phase === 'idle' || state.phase === 'pick') return null;
            return <div className="hapi-incoming-share-status" data-share-delivery={state.phase}>
                <span>{state.phase === 'inserted' ? tr('Shared content is in this draft. Review it before sending.', '分享内容已放入当前草稿，请检查后发送。')
                    : state.phase === 'waiting' ? tr('Shared content is waiting for this conversation to be ready.', '分享内容正在等待当前会话就绪。')
                    : state.phase === 'inserting' ? tr('Adding shared content…', '正在加入分享内容…')
                    : tr('The original share is retained for review.', '原始分享内容仍保留，可检查恢复。')}</span>
                <button type="button" onClick={inbox.show}>{tr('Review share', '检查分享')}</button>
            </div>;
        };
        const stop = owner.slots.inject('conversation.input.dock', () => owner.slots.register({ name: 'conversation.input.dock', id: 'hapi.share-receiver', order: -80 }, Receiver));
        return () => { enter(); autosave(); persistence(); handoffChanges(); handoffReceiver(); recovery(); stop(); if (!existingBridge) bridge.dispose(); };
    });
    return () => { void scope.dispose(); };
}
