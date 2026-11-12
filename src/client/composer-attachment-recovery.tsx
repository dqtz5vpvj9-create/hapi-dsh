import { useWorkspacePane } from './surface/pane-context.tsx'
import { randomId } from './random-id.ts'
/** Durable bytes around the published official composer attachment owner. */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type {} from './composer-picker/slots.ts';
import { accountComposerDraftKey, composerDraftSnapshot, copySourceRouteDraft, type ComposerAuthenticatedIdentity } from './composer-autosave.ts';
import { useComposerIdentity, type ComposerIdentity } from './composer-identity.ts';
import { DraftOwnership } from './draft-ownership.ts';
import type { Context } from '@deepseek-ai/cordis';
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { InboxState } from '@deepseek-ai/dsh-agent/types';
import type { SourceComposerBridge } from './source-composer.tsx';
import type {} from './workspace-ui.ts';
import { captureSourceUploadIntents, restoreSourceUploadIntents, validSourceUploadIntents, type SavedSourceUploadIntents } from './source-upload-intent.ts';

interface SavedFile { name: string; type: string; lastModified: number; blob: Blob; uploads?: SavedSourceUploadIntents }
interface SavedCopy { text: string; files: SavedFile[]; savedAt: number; requestIds?: string[] }
interface SavedAttachments extends SavedCopy { version: 1; mode: 'draft' | 'pending'; previous?: SavedCopy[] }
interface AttachmentEntry { version: 1; revision: string; value: SavedAttachments | null }
const sameIds = (left: readonly string[] = [], right: readonly string[] = []) => left.length === right.length && left.every((id, index) => id === right[index]);
function sameCopy(left: SavedCopy, right: SavedCopy): boolean {
    return left.text === right.text && sameIds(left.requestIds, right.requestIds) && left.files.length === right.files.length
        && left.files.every((file, index) => {
            const next = right.files[index]!;
            return file.blob === next.blob && file.name === next.name && file.type === next.type && file.lastModified === next.lastModified
                && (file.uploads?.length ?? 0) === (next.uploads?.length ?? 0) && (file.uploads ?? []).every(([id, intent], uploadIndex) => {
                    const other = next.uploads![uploadIndex]!;
                    return id === other[0] && intent.operationId === other[1].operationId && intent.prepared === other[1].prepared && intent.removed === other[1].removed;
                });
        });
}
function sameAttachments(left: SavedAttachments | null, right: SavedAttachments | null): boolean {
    return left === right || !!left && !!right && left.mode === right.mode && sameCopy(left, right)
        && (left.previous?.length ?? 0) === (right.previous?.length ?? 0)
        && (left.previous ?? []).every((copy, index) => sameCopy(copy, right.previous![index]!));
}
function decodeEntry(raw: unknown): AttachmentEntry | null {
    if (raw == null) return null;
    const entry = raw as Partial<AttachmentEntry>, value = entry.value;
    const validCopy = (copy: SavedCopy) => copy && typeof copy.text === 'string' && Number.isFinite(copy.savedAt) && Array.isArray(copy.files)
        && (copy.requestIds === undefined || Array.isArray(copy.requestIds) && copy.requestIds.every(id => typeof id === 'string'))
        && copy.files.every(file => file && typeof file.name === 'string' && typeof file.type === 'string' && Number.isFinite(file.lastModified) && file.blob instanceof Blob && validSourceUploadIntents(file.uploads));
    if (entry.version !== 1 || typeof entry.revision !== 'string' || value === undefined || value !== null && (value.version !== 1 || !validCopy(value)
        || !['draft', 'pending'].includes(value.mode) || value.previous !== undefined && (!Array.isArray(value.previous) || !value.previous.every(validCopy)))) {
        throw new Error('The saved attachment draft cannot be decoded; its bytes have been retained.');
    }
    return entry as AttachmentEntry;
}
class AttachmentStore {
    private opening: Promise<IDBDatabase> | undefined;
    private open() {
        return this.opening ??= new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open('hapi-dsh-composer-attachments', 1);
            request.onupgradeneeded = () => request.result.createObjectStore('drafts');
            request.onsuccess = () => { request.result.onversionchange = () => { request.result.close(); this.opening = undefined; }; resolve(request.result); };
            request.onerror = () => reject(request.error ?? new Error('Composer attachment storage is unavailable.'));
            request.onblocked = () => reject(new Error('A composer attachment upgrade is waiting for another window.'));
        }).catch(error => { this.opening = undefined; throw error; });
    }
    async read(key: string): Promise<AttachmentEntry | null> {
        const database = await this.open();
        return new Promise((resolve, reject) => {
            const request = database.transaction('drafts').objectStore('drafts').get(key);
            request.onsuccess = () => {
                try { resolve(decodeEntry(request.result)); } catch (error) { reject(error); }
            };
            request.onerror = () => reject(request.error ?? new Error('The saved composer attachments could not be read.'));
        });
    }
    async write(key: string, expectedRevision: string | null, value: SavedAttachments | null): Promise<AttachmentEntry> {
        const database = await this.open();
        const entry: AttachmentEntry = { version: 1, revision: randomId(), value };
        await new Promise<void>((resolve, reject) => {
            const transaction = database.transaction('drafts', 'readwrite', { durability: 'strict' }), store = transaction.objectStore('drafts');
            let reason: Error | undefined;
            const previous = store.get(key);
            previous.onsuccess = () => {
                try {
                    if ((decodeEntry(previous.result)?.revision ?? null) !== expectedRevision) throw new Error('Another window saved a newer attachment draft. Current files are untouched; review the latest saved copy before replacing it.');
                    // Keep a revision tombstone so an older tab cannot resurrect a discarded draft.
                    store.put(entry, key);
                } catch (error) { reason = error instanceof Error ? error : new Error(String(error)); transaction.abort(); }
            };
            transaction.oncomplete = () => resolve();
            transaction.onerror = transaction.onabort = () => reject(reason ?? transaction.error ?? new Error('The original attachment bytes could not be saved.'));
        });
        return entry;
    }
}
const attachmentStore = new AttachmentStore();
const ownership = new DraftOwnership();
const pendingWrites = new Map<string, Promise<void>>();
type InputProps = PropsRuntime<'conversation.input.dock'>;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export function installComposerAttachmentRecovery(ctx: Context, bridge: SourceComposerBridge,
    authenticatedIdentity?: ComposerAuthenticatedIdentity): () => void {
    const style = document.createElement('style');
    style.textContent = '.hapi-attachment-recovery{font-size:12px;padding:8px 12px;border:1px solid var(--border-secondary,#8885);border-radius:8px;overflow-wrap:anywhere}.hapi-attachment-recovery p{margin:4px 0 8px}.hapi-attachment-recovery button{font:inherit;border:1px solid var(--border-secondary,#8885);background:var(--bg-secondary,Canvas);color:inherit;border-radius:5px;padding:4px 8px;margin:2px;cursor:pointer}.hapi-attachment-recovery button:disabled{opacity:.5;cursor:default}.hapi-attachment-recovery pre{white-space:pre-wrap;max-height:120px;overflow:auto}.hapi-attachment-recovery [role=alert]{color:var(--text-error,#d45d62)}';
    document.head.append(style);
    const inputAccounts = new WeakMap<InputProps['inputActions'], string>();
    const scope = ctx.inject(['hapiWorkspaceUi', 'sessions'], owner => {
        const Recovery = ({ props, identity, credential }: { props: InputProps; identity: string; credential: ComposerIdentity }) => {
            const pane = useWorkspacePane(owner);
            const state = props.useInput(value => value), pending = props.useSession(value => value.pendingSubmissions);
            const [backup, setBackup] = useState<SavedAttachments | null>(null), [error, setError] = useState<string | null>(null);
            const [loading, setLoading] = useState(true), [review, setReview] = useState(false);
            const lifecycle = useMemo(() => new AbortController(), [identity, credential.signal, props.sessionBinding]);
            const initialization = useRef<Promise<void>>(Promise.resolve());
            const restoration = useRef<Promise<void> | undefined>(undefined);
            const saved = useRef<SavedAttachments | null>(null), ready = useRef(false), blocked = useRef(false), restoring = useRef(false);
            const latest = useRef<SavedAttachments | null>(null);
            const queued = useRef<SavedAttachments | null>(null);
            const writes = useRef(pendingWrites.get(identity) ?? Promise.resolve()), persistenceError = useRef<Error | null>(null), revision = useRef(0);
            const storedRevision = useRef<string | null>(null);
            const detailView = useMemo(() => ({ value: null as ReactNode, listeners: new Set<() => void>() }), []);
            const tr = (en: string, zh: string) => owner.locale.getSnapshot().active.startsWith('zh') ? zh : en;
            const assertIdentity = () => {
                credential.signal.throwIfAborted(); lifecycle.signal.throwIfAborted();
                if (!credential.current()) throw new Error('The authenticated draft account changed. Its saved bytes are retained.');
                const previous = inputAccounts.get(props.inputActions);
                if (previous !== undefined && previous !== identity) throw new Error('This attachment input belongs to an earlier account. Reopen the conversation; its saved files are retained.');
                inputAccounts.set(props.inputActions, identity);
            };
            const live = () => {
                assertIdentity();
                const binding = (props.sessionBinding ?? owner.sessions.binding(props.sessionId));
                if (!binding || owner.sessions.ownsBinding?.(binding) === false) throw new Error('The original composer is no longer open.');
                return owner.conversation.input.for(binding.ctx).state.getSnapshot();
            };
            const pendingNow = () => (props.sessionBinding ?? owner.sessions.binding(props.sessionId))?.session.getSnapshot().pendingSubmissions ?? [];
            const admitted = (): ReadonlySet<string> => {
                const binding = (props.sessionBinding ?? owner.sessions.binding(props.sessionId)), result = new Set<string>();
                if (!binding) return result;
                for (const entry of binding.eventSource.getSnapshot().entries) {
                    if (entry.type !== 'event' || entry.event.type !== 'user/message') continue;
                    const source = entry.event.data.source;
                    if (source.kind === 'user' && 'rpcId' in source) result.add(source.rpcId);
                }
                const inbox = binding.session.projections.faceOf('inbox').getSnapshot() as InboxState | undefined;
                for (const item of [...inbox?.['next-turn'] ?? [], ...inbox?.['next-step'] ?? []]) {
                    if (item.source.kind === 'user' && 'rpcId' in item.source) result.add(item.source.rpcId);
                }
                return result;
            };
            const confirmed = (copy: SavedCopy, ids: ReadonlySet<string>) => Boolean(copy.requestIds?.length && copy.requestIds.every(id => ids.has(id)));
            const fingerprint = () => { const input = live(); return JSON.stringify([input.draftRev, input.phase, input.attachmentIds, pendingNow().map(value => value.requestId),
                bridge.captureFiles(props.sessionId, input.attachmentIds, props.inputActions).map(({ file }) =>
                    captureSourceUploadIntents(file, props.sessionId).map(([id, intent]) => [id, intent.operationId, intent.prepared?.size, intent.prepared?.type]))]); };
            const persist = async () => {
                if (!ready.current || blocked.current || restoring.current) throw new Error('The original attachment draft needs review before this page can update.');
                const input = live();
                props.inputActions.persistDraft();
                const files = bridge.captureFiles(props.sessionId, input.attachmentIds, props.inputActions);
                const base = latest.current;
                if (!files.length && !base?.files.length && !base?.previous?.length) return;
                const flights = pendingNow(), detached = flights.length > 0, admittedIds = admitted();
                const previous = (base?.previous ?? []).filter(copy => !confirmed(copy, admittedIds));
                // A normal official Send detaches its input immediately. Empty
                // attachmentIds therefore do not prove a user deleted the bytes.
                const unresolved = base?.mode === 'pending' && base.files.length > 0 && !confirmed(base, admittedIds);
                const sameFiles = base?.files.length === files.length && files.every(({ file }, index) => file === base.files[index]!.blob);
                if (files.length && unresolved && !sameFiles) previous.push({ text: base.text, files: base.files, savedAt: base.savedAt, ...(base.requestIds ? { requestIds: base.requestIds } : {}) });
                const value: SavedAttachments | null = files.length ? { version: 1, text: input.draft,
                    mode: detached || ['submitting', 'adjudicating'].includes(input.phase) ? 'pending' : 'draft', savedAt: Date.now(),
                    ...(flights.length ? { requestIds: flights.map(value => value.requestId) } : {}),
                    files: files.map(({ file }) => ({ name: file.name, type: file.type, lastModified: file.lastModified, blob: file, uploads: captureSourceUploadIntents(file, props.sessionId) })), previous }
                    : (detached || unresolved) && base?.files.length ? { ...base, mode: 'pending', previous,
                        requestIds: [...new Set([...(base.requestIds ?? []), ...flights.map(value => value.requestId)])] }
                    : previous.length ? { version: 1, text: input.draft, files: [], mode: 'draft', previous, savedAt: Date.now() } : null;
                // Session and history streams also publish unrelated progress.
                // Wait for a matching durable write instead of queueing the
                // same original/prepared Blobs again for every such update.
                if (!persistenceError.current && sameAttachments(queued.current, value)) {
                    await writes.current;
                    if (persistenceError.current) throw persistenceError.current;
                    return;
                }
                latest.current = queued.current = value;
                const expected = ++revision.current;
                writes.current = writes.current.then(async () => {
                    try { assertIdentity(); const stored = await attachmentStore.write(identity, storedRevision.current, value); storedRevision.current = stored.revision; saved.current = value; persistenceError.current = null;
                        if (!lifecycle.signal.aborted && expected === revision.current) { setBackup(value); setError(null); }
                    } catch (reason) { persistenceError.current = new Error(message(reason)); if (!lifecycle.signal.aborted) setError(message(reason)); }
                });
                pendingWrites.set(identity, writes.current);
                const currentWrite = writes.current;
                void currentWrite.finally(() => { if (pendingWrites.get(identity) === currentWrite) pendingWrites.delete(identity); });
                await writes.current;
                if (persistenceError.current) throw persistenceError.current;
            };
            const restore = async (value: SavedAttachments, explicit: boolean) => {
                if (restoring.current || lifecycle.signal.aborted) return;
                const before = live();
                if (['adjudicating', 'submitting'].includes(before.phase) || before.attachmentIds.length || !explicit && (value.mode !== 'draft' || value.text !== before.draft)) {
                    if (!explicit) {
                        const previous = [...value.previous ?? [], { text: value.text, files: value.files, savedAt: value.savedAt,
                            ...(value.requestIds ? { requestIds: value.requestIds } : {}) }];
                        latest.current = { version: 1, mode: 'draft', text: before.draft, files: [], previous, savedAt: Date.now() };
                        setBackup(latest.current); blocked.current = false; setReview(false);
                    } else setReview(true);
                    return;
                }
                restoring.current = true; setLoading(true); setError(null);
                const restored = Promise.withResolvers<void>(); restoration.current = restored.promise;
                try {
                    const files = value.files.map(file => {
                        const restored = new File([file.blob], file.name, { type: file.type, lastModified: file.lastModified });
                        restoreSourceUploadIntents(restored, file.uploads); return restored;
                    });
                    const undo = await bridge.addFiles(props.sessionId, files, lifecycle.signal, props.inputActions);
                    const after = live();
                    if (after.draftRev !== before.draftRev || ['adjudicating', 'submitting'].includes(after.phase)) { undo(); throw new Error('The composer changed while restoring files. The original bytes are retained for review.'); }
                    // Explicit recovery restores the accompanying text only into
                    // an empty draft. Never replace text written since sending.
                    if (explicit && !after.draft && value.text) {
                        const binding = props.sessionBinding ?? owner.sessions.binding(props.sessionId);
                        owner.conversation.input.for(binding!.ctx).setDraft(value.text);
                    }
                    latest.current = { ...value, mode: 'draft', text: live().draft, files: files.map(file => ({ name: file.name, type: file.type, lastModified: file.lastModified, blob: file, uploads: captureSourceUploadIntents(file, props.sessionId) })) };
                    blocked.current = false; setReview(false);
                } catch (reason) { blocked.current = true; setReview(true); setError(message(reason)); }
                finally { restoring.current = false; restoration.current = undefined; restored.resolve(); if (!lifecycle.signal.aborted) setLoading(false); }
            };
            useEffect(() => {
                initialization.current = writes.current.then(async () => {
                    assertIdentity(); return attachmentStore.read(identity);
                }).then(async entry => {
                    if (lifecycle.signal.aborted) return;
                    const value = entry?.value ?? null; storedRevision.current = entry?.revision ?? null;
                    saved.current = latest.current = queued.current = value; setBackup(value); ready.current = true;
                    if (value?.files.length && value.mode === 'draft') await restore(value, false);
                }).catch(reason => { blocked.current = true; setError(message(reason)); }).finally(() => { if (!lifecycle.signal.aborted) setLoading(false); });
                const stop = owner.hapiWorkspaceUi.updates.registerCheckpoint({ kind: 'attachment', label: 'Conversation draft and attachments',
                    revision: fingerprint,
                    current: () => {
                        const binding = props.sessionBinding ?? owner.sessions.binding(props.sessionId);
                        return !lifecycle.signal.aborted && credential.current() && !!binding && owner.sessions.ownsBinding?.(binding) !== false;
                    },
                    async save(signal) {
                        signal.throwIfAborted();
                        if (['adjudicating', 'submitting'].includes(live().phase) || pendingNow().length) throw new Error('Wait for the current submission to settle.');
                        await initialization.current; await restoration.current; await persist();
                        for (;;) { const pending = writes.current; await pending; if (pending === writes.current) break; }
                        signal.throwIfAborted(); assertIdentity();
                        if (persistenceError.current) throw persistenceError.current;
                    },
                });
                return () => { lifecycle.abort(); stop(); };
            }, [identity, lifecycle]);
            // Wait for this exact input's durable attachment restoration before moving its Host route.
            useEffect(() => pane?.registerSourceRouteCheckpoint?.({ sessionId: props.sessionId, transfer(target) {
                if (loading || !ready.current || blocked.current || restoring.current || persistenceError.current || !credential.current()) return false;
                const input = live(), backup = latest.current;
                if (input.phase !== 'plain' || input.attachmentIds.length || input.queue.length || pendingNow().length
                    || backup?.files.length || backup?.previous?.length) return false;
                props.inputActions.persistDraft();
                return copySourceRouteDraft(window.localStorage, identity,
                    accountComposerDraftKey(target.scope, target.hostId, props.sessionId), composerDraftSnapshot(input));
            } }), [pane, identity, credential, loading, props.sessionId, props.inputActions, lifecycle]);
            useEffect(() => bridge.registerUploadCheckpoint(props.inputActions, async () => {
                await initialization.current; await restoration.current; assertIdentity(); await persist();
            }), [identity, lifecycle, props.inputActions]);
            useEffect(() => {
                if (!ready.current || blocked.current || restoring.current || loading) return;
                void persist().catch(reason => { if (!lifecycle.signal.aborted) setError(message(reason)); });
            }, [identity, state.draftRev, state.phase, state.attachmentIds, pending, loading, lifecycle]);
            // Observe admission at the owner boundary, before React can combine
            // a fast pending→observed transition into one render. History alone
            // retires saved copies; a receipt or an empty editor does not.
            useEffect(() => {
                const binding = props.sessionBinding ?? owner.sessions.binding(props.sessionId);
                const changed = () => {
                    if (!ready.current || blocked.current || restoring.current || lifecycle.signal.aborted) return;
                    void persist().catch(reason => { if (!lifecycle.signal.aborted) setError(message(reason)); });
                };
                const stops = [binding?.session.subscribe?.(changed), binding?.eventSource.subscribe?.(changed)];
                return () => { for (const stop of stops) stop?.(); };
            }, [identity, lifecycle, props.sessionBinding]);
            useEffect(() => owner.slots.register({ name: 'hapi.source.composer-details', id: `attachments:${identity}`, order: 20 }, detailProps => {
                const view = useSyncExternalStore(listener => { detailView.listeners.add(listener); return () => { detailView.listeners.delete(listener); }; }, () => detailView.value);
                return detailProps.inputActions === props.inputActions ? view : null;
            }), [identity, props.inputActions, detailView]);
            useEffect(() => { for (const listener of detailView.listeners) listener(); });
            const download = (file: SavedFile) => {
                const url = URL.createObjectURL(file.blob), anchor = document.createElement('a'); anchor.href = url; anchor.download = file.name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 30_000);
            };
            detailView.value = !error && !review && !backup?.previous?.length && backup?.mode !== 'pending' ? null : <div className="hapi-attachment-recovery">
                {error && <p role="alert">{error}</p>}
                {error && <button type="button" disabled={loading} onClick={() => {
                    setLoading(true); void writes.current.then(() => attachmentStore.read(identity)).then(entry => {
                        storedRevision.current = entry?.revision ?? null; saved.current = latest.current = queued.current = entry?.value ?? null; ready.current = true;
                        setBackup(saved.current); blocked.current = Boolean(saved.current); setReview(blocked.current); persistenceError.current = null; setError(null);
                    }).catch(reason => setError(message(reason))).finally(() => setLoading(false));
                }}>{tr('Review latest saved copy', '检查最新保存副本')}</button>}
                {(review || backup?.mode === 'pending') && <><p>{tr('Saved attachments', '已保存的附件')}</p>
                    {backup?.files.map((file, index) => <button type="button" key={index} onClick={() => download(file)}>{tr('Save original', '保存原件')} · {file.name}</button>)}
                    <button type="button" disabled={loading || state.attachmentIds.length > 0} onClick={() => { if (saved.current) void restore(saved.current, true); }}>{tr('Restore saved attachments', '恢复已保存附件')}</button>
                    <button type="button" disabled={loading} onClick={() => {
                        if (!window.confirm(tr('Discard this saved attachment copy? Current composer files are kept.', '丢弃这份保存的附件副本？当前输入框附件会保留。'))) return;
                        setLoading(true); void writes.current.then(() => {
                            const value: SavedAttachments | null = latest.current?.previous?.length ? { version: 1, text: live().draft, files: [], mode: 'draft', previous: latest.current.previous, savedAt: Date.now() } : null;
                            return attachmentStore.write(identity, storedRevision.current, value);
                        }).then(entry => {
                            storedRevision.current = entry.revision; saved.current = latest.current = queued.current = entry.value; blocked.current = false; persistenceError.current = null; setBackup(entry.value); setReview(false); setError(null);
                        }).catch(reason => setError(message(reason))).finally(() => setLoading(false));
                    }}>{tr('Discard saved copy', '丢弃保存副本')}</button></>}
                {!!backup?.previous?.length && <details><summary>{tr('Saved attachments', '已保存的附件')} · {backup.previous.length}</summary>
                    {backup.previous.map((copy, index) => <div key={index}><pre>{copy.text}</pre>{copy.files.map((file, fileIndex) => <button type="button" key={fileIndex} onClick={() => download(file)}>{tr('Save original', '保存原件')} · {file.name}</button>)}</div>)}
                    <button type="button" disabled={loading} onClick={() => {
                        if (!window.confirm(tr('Discard earlier saved attachment copies? Check source history first. Current draft attachments are kept.', '丢弃较早保存的附件副本？请先核对源历史，当前草稿附件会保留。'))) return;
                        setLoading(true); void writes.current.then(async () => {
                            const value = latest.current ? { ...latest.current, previous: [] } : null;
                            const entry = await attachmentStore.write(identity, storedRevision.current, value);
                            storedRevision.current = entry.revision; saved.current = latest.current = queued.current = value; setBackup(value);
                        }).catch(reason => setError(message(reason))).finally(() => setLoading(false));
                    }}>{tr('Discard earlier saved copies', '丢弃较早的保存副本')}</button>
                </details>}
            </div>;
            // Normal confirmation and retained backup bytes are internal state.
            // Recovery remains available in More without taking transcript space.
            return null;
        };
        const Seat = (props: InputProps) => {
            const pane = useWorkspacePane(owner);
            const credential = useComposerIdentity(owner, props.sessionId, authenticatedIdentity);
            const identity = pane && credential && !credential.signal.aborted ? accountComposerDraftKey(credential.scope, pane.hostId, props.sessionId) : '';
            const token = useMemo(() => ({}), [identity]);
            useEffect(() => identity ? ownership.retain(identity, token) : undefined, [identity, token]);
            const currentOwner = useSyncExternalStore(ownership.subscribe, () => ownership.owner(identity));
            if (!identity || !credential || currentOwner !== token) return null;
            return <Recovery key={identity} props={props} identity={identity} credential={credential}/>;
        };
        return owner.slots.inject('conversation.input.dock', () => owner.slots.register({ name: 'conversation.input.dock', id: 'hapi.attachment-recovery', order: -90 }, Seat));
    });
    return () => { style.remove(); void scope.dispose(); };
}
