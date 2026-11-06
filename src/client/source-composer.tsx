import { createElement, useLayoutEffect, useRef, type ComponentType } from 'react';
import { isSourceSessionId } from '../remote/protocol.ts';
import type { Context } from '@deepseek-ai/cordis';
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots';
import type { ComposerAttachmentsProps, ComposerAttachment } from '@deepseek-ai/dsh-client-ui-conversation/client';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import { inspectComposerAttachments, type ComposerEnterAttachments } from './composer-enter/attachments.ts';

/** Access the published attachment owner callbacks through their real mounted slot. */
export interface SourceComposerBridge extends ComposerEnterAttachments {
    addFiles(sessionId: SessionId, files: readonly File[], signal: AbortSignal): Promise<() => void>;
    captureFiles(sessionId: SessionId, ids: readonly string[]): readonly ComposerAttachment[];
    removeFiles(sessionId: SessionId, captured: readonly { id: string; file: File }[]): void;
    dispose(): void;
}
export function installSourceComposerBridge(ctx: Context): SourceComposerBridge {
    const seats = new Map<SessionId, Set<{ props: ComposerAttachmentsProps }>>();
    let wrapped: StoredEntry | undefined; let shadow: (() => void) | undefined;
    let component: ComponentType<ComposerAttachmentsProps> | undefined; let changing = false;
    const reconcile = () => {
        if (changing) return;
        const original = ctx.slots.entries('conversation.input.attachments').find(entry => entry.component !== component);
        if (wrapped === original) return;
        changing = true;
        try {
            shadow?.(); shadow = undefined; wrapped = original;
            // Additional plugin-owned subtree/state needs its own public
            // adapter. Never fabricate an attachment provider's inject props.
            if (!original || original.children || original.inject || original.store) return;
            const Official = original.component as ComponentType<ComposerAttachmentsProps>;
            const AttachmentSeat = (props: ComposerAttachmentsProps) => {
                useLayoutEffect(() => {
                    if (!props.sessionId) return;
                    const rows = seats.get(props.sessionId) ?? new Set(); const row = { props };
                    rows.add(row); seats.set(props.sessionId, rows);
                    return () => { rows.delete(row); if (!rows.size) seats.delete(props.sessionId!); };
                }, [props]);
                if (!isSourceSessionId(props.sessionId ?? '')) return createElement(Official, props);
                return <><CompactAttachmentButton ctx={ctx} props={props}/>
                    <div className="hapi-composer-files" hidden={props.attachments.length === 0}>{createElement(Official, props)}</div></>;
            };
            component = AttachmentSeat;
            shadow = ctx.slots.register({ name: 'conversation.input.attachments', priority: (original.options.priority ?? 0) - 1, locale: 'conversation' }, AttachmentSeat);
        } finally { changing = false; }
    };
    const stop = ctx.slots.subscribe('conversation.input.attachments', reconcile); reconcile();
    return {
        inspectSubmission(sessionId, actions, ids) {
            const seat = [...seats.get(sessionId) ?? []].find(row => row.props.inputActions === actions
                && ids.every(id => row.props.attachments.some(attachment => attachment.id === id)));
            return inspectComposerAttachments(seat?.props, ids);
        },
        captureFiles(sessionId, ids) {
            if (!ids.length) return [];
            for (const row of seats.get(sessionId) ?? []) {
                const attachments = ids.map(id => row.props.attachments.find(file => file.id === id));
                if (attachments.every((file): file is ComposerAttachment => !!file)) return attachments;
            }
            throw new Error('Some original composer attachment bytes are unavailable. The draft has not been changed.');
        },
        removeFiles(sessionId, captured) {
            for (const row of seats.get(sessionId) ?? []) for (const file of captured) {
                if (row.props.attachments.some(value => value.id === file.id && value.file === file.file)) row.props.onRemoveAttachment(file.id as ComposerAttachment['id']);
            }
        },
        async addFiles(sessionId, files, signal) {
            if (!files.length) return () => {};
            const seat = [...seats.get(sessionId) ?? []].find(row => row.props.canAcceptDrop);
            if (!seat) throw new Error('The official composer is not ready to accept attachments.');
            const previous = new Set(seat.props.attachments.map(attachment => attachment.id));
            const undo = () => {
                for (const row of seats.get(sessionId) ?? []) for (const attachment of row.props.attachments) {
                    if (!previous.has(attachment.id) && files.includes(attachment.file)) row.props.onRemoveAttachment(attachment.id);
                }
            };
            signal.throwIfAborted(); seat.props.onAddFiles(files);
            try {
                for (let frame = 0; frame < 12; frame++) {
                    signal.throwIfAborted();
                    for (const row of seats.get(sessionId) ?? []) {
                        const added = row.props.attachments.filter(attachment => !previous.has(attachment.id) && files.includes(attachment.file));
                        if (added.length === files.length) return undo;
                    }
                    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
                }
                throw new Error('The official composer did not accept every note attachment. The original note is retained.');
            } catch (error) {
                undo(); throw error;
            }
        },
        dispose() { stop(); shadow?.(); seats.clear(); },
    };
}

/** The file chooser belongs to this mounted attachment owner, including independent Panes. */
export function CompactAttachmentButton({ ctx, props }: { ctx: Context; props: ComposerAttachmentsProps }) {
    const picker = useRef<HTMLInputElement>(null);
    const current = useRef(props); current.current = props;
    const pickedOwner = useRef(props.inputActions);
    const zh = ctx.locale.getSnapshot().active.startsWith('zh');
    return <>
        <button type="button" className="hapi-compact-attach" aria-label={zh ? '添加附件' : 'Attach files'} disabled={!props.canAcceptDrop}
            onMouseDown={event => event.preventDefault()} onClick={() => { pickedOwner.current = props.inputActions; picker.current?.click(); }}>
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="m8 13 7-7a3 3 0 0 1 4 4l-9 9a5 5 0 0 1-7-7l10-10m-7 13 8-8"/></svg>
        </button>
        <input ref={picker} type="file" multiple hidden onChange={event => {
            const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = '';
            const owner = current.current;
            if (pickedOwner.current !== owner.inputActions || !owner.canAcceptDrop || !files.length) return;
            owner.onAddFiles(files);
            if (owner.sessionBinding) ctx.conversation.input.for(owner.sessionBinding.ctx).focus();
        }}/>
    </>;
}
