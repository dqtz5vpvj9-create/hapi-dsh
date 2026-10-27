import { useWorkspacePane } from './surface/pane-context.tsx'
import { randomId } from './random-id.ts'
/** Durable bytes around the published official composer attachment owner. */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { composerDraftKey } from './composer-autosave.ts';
import { DraftOwnership } from './draft-ownership.ts';
import type { Context } from '@deepseek-ai/cordis';
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { InboxState } from '@deepseek-ai/dsh-agent/types';
import type { SourceComposerBridge } from './source-composer.tsx';
import type {} from './workspace-ui.ts';

interface SavedFile { name: string; type: string; lastModified: number; blob: Blob }
interface SavedCopy { text: string; files: SavedFile[]; savedAt: number; requestIds?: string[] }
interface SavedAttachments extends SavedCopy { version: 1; mode: 'draft' | 'pending'; previous?: SavedCopy[] }
interface AttachmentEntry { version: 1; revision: string; value: SavedAttachments | null }
function decodeEntry(raw: unknown): AttachmentEntry | null {
    if (raw == null) return null;
    const entry = raw as Partial<AttachmentEntry>, value = entry.value;
    const validCopy = (copy: SavedCopy) => copy && typeof copy.text === 'string' && Number.isFinite(copy.savedAt) && Array.isArray(copy.files)
        && (copy.requestIds === undefined || Array.isArray(copy.requestIds) && copy.requestIds.every(id => typeof id === 'string'))
        && copy.files.every(file => file && typeof file.name === 'string' && typeof file.type === 'string' && Number.isFinite(file.lastModified) && file.blob instanceof Blob);
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

export function installComposerAttachmentRecovery(ctx: Context, bridge: SourceComposerBridge): () => void {
    const style = document.createElement('style');
    style.textContent = '.hapi-attachment-recovery{font-size:12px;padding:8px 12px;border:1px solid var(--border-secondary,#8885);border-radius:8px;overflow-wrap:anywhere}.hapi-attachment-recovery p{margin:4px 0 8px}.hapi-attachment-recovery button{font:inherit;border:1px solid var(--border-secondary,#8885);background:var(--bg-secondary,Canvas);color:inherit;border-radius:5px;padding:4px 8px;margin:2px;cursor:pointer}.hapi-attachment-recovery button:disabled{opacity:.5;cursor:default}.hapi-attachment-recovery pre{white-space:pre-wrap;max-height:120px;overflow:auto}.hapi-attachment-recovery [role=alert]{color:var(--text-error,#d45d62)}';
    document.head.append(style);
    const scope = ctx.inject(['hapiWorkspaceUi', 'sessions'], owner => {
        const Recovery = ({ props, identity, legacyIdentity }: { props: InputProps; identity: string; legacyIdentity: string }) => {
            const state = props.useInput(value => value), pending = props.useSession(value => value.pendingSubmissions), current = useRef(props); current.current = props;
            const [backup, setBackup] = useState<SavedAttachments | null>(null), [error, setError] = useState<string | null>(null);
            const [loading, setLoading] = useState(true), [review, setReview] = useState(false);
            const lifecycle = useMemo(() => new AbortController(), [identity]);
            const saved = useRef<SavedAttachments | null>(null), ready = useRef(false), blocked = useRef(false), restoring = useRef(false);
            const latest = useRef<SavedAttachments | null>(null);
            const writes = useRef(pendingWrites.get(identity) ?? Promise.resolve()), persistenceError = useRef<Error | null>(null), revision = useRef(0);
            const storedRevision = useRef<string | null>(null), prepared = useRef<string | null>(null);
            const tr = (en: string, zh: string) => owner.locale.getSnapshot().active.startsWith('zh') ? zh : en;
            const live = () => {
                const binding = owner.sessions.binding(props.sessionId);
                if (!binding) throw new Error('The original composer is no longer open.');
                return owner.conversation.input.for(binding.ctx).state.getSnapshot();
            };
            const pendingNow = () => owner.sessions.binding(props.sessionId)?.session.getSnapshot().pendingSubmissions ?? [];
            const admitted = (): ReadonlySet<string> => {
                const binding = owner.sessions.binding(props.sessionId), result = new Set<string>();
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
            const fingerprint = () => { const input = live(); return JSON.stringify([input.draftRev, input.phase, input.attachmentIds, pendingNow().map(value => value.requestId)]); };
            const persist = async () => {
                if (!ready.current || blocked.current || restoring.current) throw new Error('The original attachment draft needs review before this page can update.');
                const input = live();
                current.current.inputActions.persistDraft();
                const files = bridge.captureFiles(props.sessionId, input.attachmentIds);
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
                    mode: ['submitting', 'adjudicating'].includes(input.phase) ? 'pending' : 'draft', savedAt: Date.now(),
                    files: files.map(({ file }) => ({ name: file.name, type: file.type, lastModified: file.lastModified, blob: file })), previous }
                    : (detached || unresolved) && base?.files.length ? { ...base, mode: 'pending', previous,
                        requestIds: [...new Set([...(base.requestIds ?? []), ...flights.map(value => value.requestId)])] }
                    : previous.length ? { version: 1, text: input.draft, files: [], mode: 'draft', previous, savedAt: Date.now() } : null;
                latest.current = value;
                const expected = ++revision.current;
                writes.current = writes.current.then(async () => {
                    try { const stored = await attachmentStore.write(identity, storedRevision.current, value); storedRevision.current = stored.revision; saved.current = value; persistenceError.current = null;
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
                    blocked.current = true; setReview(true); return;
                }
                restoring.current = true; setLoading(true); setError(null);
                try {
                    const files = value.files.map(file => new File([file.blob], file.name, { type: file.type, lastModified: file.lastModified }));
                    const undo = await bridge.addFiles(props.sessionId, files, lifecycle.signal);
                    const after = live();
                    if (after.draftRev !== before.draftRev || ['adjudicating', 'submitting'].includes(after.phase)) { undo(); throw new Error('The composer changed while restoring files. The original bytes are retained for review.'); }
                    latest.current = { ...value, mode: 'draft', text: after.draft, files: files.map(file => ({ name: file.name, type: file.type, lastModified: file.lastModified, blob: file })) };
                    blocked.current = false; setReview(false);
                } catch (reason) { blocked.current = true; setReview(true); setError(message(reason)); }
                finally { restoring.current = false; if (!lifecycle.signal.aborted) setLoading(false); }
            };
            useEffect(() => {
                void writes.current.then(async () => {
                    const entry = await attachmentStore.read(identity);
                    if (entry) return entry;
                    const legacy = await attachmentStore.read(legacyIdentity);
                    return legacy?.value ? attachmentStore.write(identity, null, legacy.value) : null;
                }).then(async entry => {
                    if (lifecycle.signal.aborted) return;
                    const value = entry?.value ?? null; storedRevision.current = entry?.revision ?? null;
                    saved.current = latest.current = value; setBackup(value); ready.current = true;
                    if (value?.files.length && !(value.mode === 'pending' && confirmed(value, admitted()))) await restore(value, false);
                }).catch(reason => { blocked.current = true; setError(message(reason)); }).finally(() => { if (!lifecycle.signal.aborted) setLoading(false); });
                const stop = owner.hapiWorkspaceUi.updates.register('Conversation draft and attachments', async () => {
                    prepared.current = null;
                    if (['adjudicating', 'submitting'].includes(live().phase) || pendingNow().length) throw new Error('Wait for the current submission to settle.');
                    await persist();
                    for (;;) { const pending = writes.current; await pending; if (pending === writes.current) break; }
                    if (persistenceError.current) throw persistenceError.current;
                    prepared.current = fingerprint();
                });
                const verify = owner.hapiWorkspaceUi.updates.register('Conversation draft and attachments', () => {
                    if (prepared.current !== fingerprint()) throw new Error('The conversation changed while saving. Review it and try the update again.');
                }, 'verify');
                return () => { lifecycle.abort(); stop(); verify(); };
            }, [identity]);
            useEffect(() => {
                if (!ready.current || blocked.current || restoring.current || loading) return;
                void persist().catch(reason => { if (!lifecycle.signal.aborted) setError(message(reason)); });
            }, [identity, state.draftRev, state.phase, state.attachmentIds, pending, loading]);
            const download = (file: SavedFile) => {
                const url = URL.createObjectURL(file.blob), anchor = document.createElement('a'); anchor.href = url; anchor.download = file.name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 30_000);
            };
            if (!error && !review && !backup?.previous?.length) return null;
            return <div className="hapi-attachment-recovery" role="status">
                {error && <p role="alert">{error}</p>}
                {error && <button type="button" disabled={loading} onClick={() => {
                    setLoading(true); void writes.current.then(() => attachmentStore.read(identity)).then(entry => {
                        storedRevision.current = entry?.revision ?? null; saved.current = latest.current = entry?.value ?? null; ready.current = true;
                        setBackup(saved.current); blocked.current = Boolean(saved.current); setReview(blocked.current); persistenceError.current = null; setError(null);
                    }).catch(reason => setError(message(reason))).finally(() => setLoading(false));
                }}>{tr('Review latest saved copy', '检查最新保存副本')}</button>}
                {review && <><p>{tr('Saved attachment bytes are available. Review the current draft and source history before restoring them; no message will be sent.', '已保留附件原始内容。请核对当前草稿和源历史后恢复，不会自动发送消息。')}</p>
                    {backup?.files.map((file, index) => <button type="button" key={index} onClick={() => download(file)}>{tr('Save original', '保存原件')} · {file.name}</button>)}
                    <button type="button" disabled={loading || state.attachmentIds.length > 0} onClick={() => { if (saved.current) void restore(saved.current, true); }}>{tr('Restore saved attachments', '恢复已保存附件')}</button>
                    <button type="button" disabled={loading} onClick={() => {
                        if (!window.confirm(tr('Discard this saved attachment copy? Current composer files are kept.', '丢弃这份保存的附件副本？当前输入框附件会保留。'))) return;
                        setLoading(true); void writes.current.then(() => {
                            const value: SavedAttachments | null = latest.current?.previous?.length ? { version: 1, text: live().draft, files: [], mode: 'draft', previous: latest.current.previous, savedAt: Date.now() } : null;
                            return attachmentStore.write(identity, storedRevision.current, value);
                        }).then(entry => {
                            storedRevision.current = entry.revision; saved.current = latest.current = entry.value; blocked.current = false; persistenceError.current = null; setBackup(entry.value); setReview(false); setError(null);
                        }).catch(reason => setError(message(reason))).finally(() => setLoading(false));
                    }}>{tr('Discard saved copy', '丢弃保存副本')}</button></>}
                {!!backup?.previous?.length && <details><summary>{tr('Earlier attachment submissions need review', '较早提交的附件需要核对')} · {backup.previous.length}</summary>
                    <p>{tr('These bytes remain until their exact request is observed in source history or you discard the saved copies. Nothing is resent automatically.', '原始内容会保留，直到在源历史中确认对应请求，或你明确丢弃副本。不会自动重发。')}</p>
                    {backup.previous.map((copy, index) => <div key={index}><pre>{copy.text}</pre>{copy.files.map((file, fileIndex) => <button type="button" key={fileIndex} onClick={() => download(file)}>{tr('Save original', '保存原件')} · {file.name}</button>)}</div>)}
                    <button type="button" disabled={loading} onClick={() => {
                        if (!window.confirm(tr('Discard earlier saved attachment copies? Check source history first. Current draft attachments are kept.', '丢弃较早保存的附件副本？请先核对源历史，当前草稿附件会保留。'))) return;
                        setLoading(true); void writes.current.then(async () => {
                            const value = latest.current ? { ...latest.current, previous: [] } : null;
                            const entry = await attachmentStore.write(identity, storedRevision.current, value);
                            storedRevision.current = entry.revision; saved.current = latest.current = value; setBackup(value);
                        }).catch(reason => setError(message(reason))).finally(() => setLoading(false));
                    }}>{tr('Discard earlier saved copies', '丢弃较早的保存副本')}</button>
                </details>}
            </div>;
        };
        const Seat = (props: InputProps) => {
            const pane = useWorkspacePane(owner), native = props.useProjection('hapi'), observed = props.useProjection('hapiObserved'), source = native ?? observed;
            const eligible = pane && !observed?.sidechain && (source || !/^(?:hapi-codex-|hapi-observed-)/u.test(props.sessionId));
            const identity = eligible ? composerDraftKey(pane.hostId, props.sessionId, source ?? undefined) : '';
            const token = useMemo(() => ({}), [identity]);
            useEffect(() => identity ? ownership.retain(identity, token) : undefined, [identity, token]);
            const currentOwner = useSyncExternalStore(ownership.subscribe, () => ownership.owner(identity));
            if (!eligible || currentOwner !== token) return null;
            const legacyIdentity = JSON.stringify([pane.hostId, pane.paneId, source?.hubId ?? 'dsh', source?.hapiSessionId ?? props.sessionId]);
            return <Recovery key={identity} props={props} identity={identity} legacyIdentity={legacyIdentity}/>;
        };
        return owner.slots.inject('conversation.input.dock', () => owner.slots.register({ name: 'conversation.input.dock', id: 'hapi.attachment-recovery', order: -90 }, Seat));
    });
    return () => { style.remove(); void scope.dispose(); };
}
