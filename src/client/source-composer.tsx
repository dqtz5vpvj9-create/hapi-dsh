import { createElement, useLayoutEffect, useRef, type ComponentType } from 'react';
import { isSourceSessionId } from '../remote/protocol.ts';
import type { Context } from '@deepseek-ai/cordis';
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots';
import type { ComposerAttachmentsProps, ComposerAttachment, InputActions } from '@deepseek-ai/dsh-client-ui-conversation/client';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import { inspectComposerAttachments, type ComposerEnterAttachments } from './composer-enter/attachments.ts';
import { cancelSourceUpload } from './source-upload-intent.ts';
import { ComposerUploadStatus } from './compact-composer.tsx';

/** Access the published attachment owner callbacks through their real mounted slot. */
export interface SourceComposerBridge extends ComposerEnterAttachments {
    addFiles(sessionId: SessionId, files: readonly File[], signal: AbortSignal, actions?: InputActions): Promise<() => void>;
    captureFiles(sessionId: SessionId, ids: readonly string[], actions?: InputActions): readonly ComposerAttachment[];
    removeFiles(sessionId: SessionId, captured: readonly { id: string; file: File }[], actions?: InputActions): void;
    /** A transfer starts only after its actual input saved the original and prepared bytes. */
    checkpointUpload(sessionId: string, data: object, signal: AbortSignal): Promise<void>;
    registerUploadCheckpoint(actions: InputActions, checkpoint: () => Promise<void>): () => void;
    dispose(): void;
}
export function installSourceComposerBridge(ctx: Context): SourceComposerBridge {
    const seats = new Map<SessionId, Set<{ props: ComposerAttachmentsProps; addFiles(files: readonly File[]): void; removeFile(id: ComposerAttachment['id']): void }>>();
    const uploadOwners = new WeakMap<object, { sessionId: SessionId; actions: InputActions }>();
    const checkpoints = new Map<InputActions, Set<() => Promise<void>>>(), listeners = new Set<() => void>();
    let disposed = false;
    const changed = () => { for (const listener of [...listeners]) listener(); };
    // StoredEntry is the registry's public erasure boundary. Forward the native
    // business injection unchanged so its drag/drop owner remains intact.
    const register = ctx.slots.register.bind(ctx.slots) as (options: {
        name: 'conversation.input.attachments'; priority: number; locale: 'conversation'; inject?: StoredEntry['inject']
    }, component: ComponentType<ComposerAttachmentsProps>) => () => void;
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
            if (!original || original.children || original.store) return;
            const Official = original.component as ComponentType<ComposerAttachmentsProps>;
            const AttachmentSeat = (props: ComposerAttachmentsProps) => {
                const addFiles = (files: readonly File[]) => {
                    if (props.sessionId && props.inputActions) for (const file of files) uploadOwners.set(file, { sessionId: props.sessionId, actions: props.inputActions });
                    props.onAddFiles(files);
                };
                const removeFile = (id: ComposerAttachment['id']) => {
                    const file = props.attachments.find(value => value.id === id)?.file;
                    if (file && props.sessionId) cancelSourceUpload(file, props.sessionId);
                    props.onRemoveAttachment(id);
                };
                useLayoutEffect(() => {
                    if (!props.sessionId) return;
                    const rows = seats.get(props.sessionId) ?? new Set(); const row = { props, addFiles, removeFile };
                    rows.add(row); seats.set(props.sessionId, rows); changed();
                    return () => { rows.delete(row); if (!rows.size) seats.delete(props.sessionId!); changed(); };
                }, [props]);
                if (!isSourceSessionId(props.sessionId ?? '')) return createElement(Official, props);
                const forwarded = { ...props, onAddFiles: addFiles };
                return <><CompactAttachmentButton ctx={ctx} props={forwarded}/>
                    <div className="hapi-composer-files" hidden={props.attachments.length === 0}>
                    <ComposerUploadStatus props={props} zh={ctx.locale.getSnapshot().active.startsWith('zh')}/>
                    <div className="hapi-composer-file-list">{createElement(Official, { ...props,
                        onAddFiles: addFiles,
                        onRemoveAttachment: removeFile,
                    })}</div></div></>;
            };
            component = AttachmentSeat;
            shadow = register({ name: 'conversation.input.attachments', priority: (original.options.priority ?? 0) - 1, locale: 'conversation', ...(original.inject ? { inject: original.inject } : {}) }, AttachmentSeat);
        } finally { changing = false; }
    };
    const stop = ctx.slots.subscribe('conversation.input.attachments', reconcile); reconcile();
    const bridge: SourceComposerBridge = {
        registerUploadCheckpoint(actions, checkpoint) {
            const rows = checkpoints.get(actions) ?? new Set(); rows.add(checkpoint); checkpoints.set(actions, rows); changed();
            return () => { rows.delete(checkpoint); if (!rows.size) checkpoints.delete(actions); changed(); };
        },
        async checkpointUpload(sessionId, data, signal) {
            let owner = uploadOwners.get(data);
            if (!owner) {
                // An already mounted official input can contain a restored File
                // before this provider graph starts. Its exact current callback
                // owner is sufficient; a matching session name alone is not.
                const matches = [...seats.entries()].flatMap(([id, rows]) => id === sessionId ? [...rows]
                    .filter(row => row.props.attachments.some(file => file.file === data) && row.props.inputActions)
                    .map(row => ({ sessionId: id, actions: row.props.inputActions! })) : []);
                if (new Set(matches.map(row => row.actions)).size === 1) owner = matches[0];
            }
            if (!owner || owner.sessionId !== sessionId) throw new Error('The original attachment input is unavailable. The file has been kept.');
            for (;;) {
                signal.throwIfAborted();
                const rows = [...seats.get(owner.sessionId) ?? []].filter(row => row.props.inputActions === owner.actions);
                if (disposed || !rows.length) throw new Error('The original attachment input was released. Its saved bytes are kept.');
                const checkpoint = checkpoints.get(owner.actions)?.values().next().value;
                if (!checkpoint) throw new Error('The attachment draft cannot be saved until its authenticated account is ready. The file has been kept.');
                if (rows.some(row => row.props.attachments.some(file => file.file === data))) { await checkpoint(); signal.throwIfAborted(); return; }
                // createDrafts starts uploads before the official input adds its
                // returned attachment IDs. Wait for that same input's commit.
                await new Promise<void>((resolve, reject) => {
                    const stop = () => { listeners.delete(onChange); signal.removeEventListener('abort', onAbort); };
                    const onChange = () => { stop(); resolve(); }, onAbort = () => { stop(); reject(signal.reason); };
                    listeners.add(onChange); signal.addEventListener('abort', onAbort, { once: true });
                    if (signal.aborted) onAbort();
                });
            }
        },
        inspectSubmission(sessionId, actions, ids) {
            const seat = [...seats.get(sessionId) ?? []].find(row => row.props.inputActions === actions
                && ids.every(id => row.props.attachments.some(attachment => attachment.id === id)));
            return inspectComposerAttachments(seat?.props, ids);
        },
        captureFiles(sessionId, ids, actions) {
            if (!ids.length) return [];
            for (const row of seats.get(sessionId) ?? []) {
                if (actions && row.props.inputActions !== actions) continue;
                const attachments = ids.map(id => row.props.attachments.find(file => file.id === id));
                if (attachments.every((file): file is ComposerAttachment => !!file)) return attachments;
            }
            throw new Error('Some original composer attachment bytes are unavailable. The draft has not been changed.');
        },
        removeFiles(sessionId, captured, actions) {
            for (const row of seats.get(sessionId) ?? []) for (const file of captured) {
                if ((!actions || row.props.inputActions === actions) && row.props.attachments.some(value => value.id === file.id && value.file === file.file)) row.removeFile(file.id as ComposerAttachment['id']);
            }
        },
        async addFiles(sessionId, files, signal, actions) {
            if (!files.length) return () => {};
            const seat = [...seats.get(sessionId) ?? []].find(row => row.props.canAcceptDrop && (!actions || row.props.inputActions === actions));
            if (!seat) throw new Error('The official composer is not ready to accept attachments.');
            const previous = new Set(seat.props.attachments.map(attachment => attachment.id));
            const undo = () => {
                for (const row of seats.get(sessionId) ?? []) for (const attachment of row.props.attachments) {
                    if (row.props.inputActions === seat.props.inputActions && !previous.has(attachment.id) && files.includes(attachment.file)) row.removeFile(attachment.id);
                }
            };
            signal.throwIfAborted(); seat.addFiles(files);
            try {
                for (let frame = 0; frame < 12; frame++) {
                    signal.throwIfAborted();
                    for (const row of seats.get(sessionId) ?? []) {
                        if (row.props.inputActions !== seat.props.inputActions) continue;
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
        dispose() { if (disposed) return; disposed = true; stop(); shadow?.(); seats.clear(); checkpoints.clear(); changed(); listeners.clear(); unprovide(); },
    };
    const unprovide = ctx.reflect.provide('sourceComposer', bridge);
    return bridge;
}

declare module '@deepseek-ai/cordis' { interface Context { sourceComposer: SourceComposerBridge } }

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
