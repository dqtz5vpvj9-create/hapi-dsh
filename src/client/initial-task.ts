import { randomId } from './random-id.ts';
import { remoteValue, type HapiRemoteApi, type SourceInitialTask, type SourceInitialTaskReceipt } from '../client-api.ts'
import { errorMessage } from './controller.ts'

export type InitialFileUpload = (sessionId: string, file: File, signal?: AbortSignal) => Promise<{ receiptId: string }>
export interface InitialTaskFile { id: string; name: string; mediaType: string; lastModified: number; blob: Blob; receiptId?: string }
export interface InitialTaskDraft {
    version: 1; operationId: string; text: string; files: InitialTaskFile[];
    creationRequestId: string | null; sessionId: string | null; request: SourceInitialTask | null;
    submitted: boolean; receipt: SourceInitialTaskReceipt | null;
}
export interface InitialTaskStore {
    read(key: string): Promise<InitialTaskDraft | null>;
    write(key: string, draft: InitialTaskDraft | null): Promise<void>;
}

/** Immutable Blobs survive reload without putting attachment bytes into localStorage or layout sync. */
export class BrowserInitialTaskStore implements InitialTaskStore {
    private opening: Promise<IDBDatabase> | undefined
    private open(): Promise<IDBDatabase> {
        return this.opening ??= new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open('hapi-dsh-initial-task', 1)
            request.onupgradeneeded = () => { request.result.createObjectStore('drafts') }
            request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result) }
            request.onerror = () => reject(request.error ?? new Error('The browser could not open task draft storage'))
            request.onblocked = () => reject(new Error('Close the other pending draft upgrade before continuing'))
        }).catch(reason => { this.opening = undefined; throw reason })
    }
    async read(key: string): Promise<InitialTaskDraft | null> {
        const db = await this.open()
        return new Promise((resolve, reject) => {
            const transaction = db.transaction('drafts', 'readonly'); const request = transaction.objectStore('drafts').get(key)
            request.onsuccess = () => {
                const value = request.result as InitialTaskDraft | undefined
                if (value && (value.version !== 1 || typeof value.operationId !== 'string' || !Array.isArray(value.files) || value.files.some(file => !(file.blob instanceof Blob)))) {
                    reject(new Error('The saved task draft could not be decoded. It has been retained.')); return
                }
                resolve(value ?? null)
            }
            request.onerror = () => reject(request.error)
        })
    }
    async write(key: string, draft: InitialTaskDraft | null): Promise<void> {
        const db = await this.open()
        await new Promise<void>((resolve, reject) => {
            const transaction = db.transaction('drafts', 'readwrite')
            if (draft) transaction.objectStore('drafts').put(draft, key); else transaction.objectStore('drafts').delete(key)
            transaction.oncomplete = () => resolve()
            transaction.onabort = transaction.onerror = () => reject(transaction.error ?? new Error('The browser could not save this task draft'))
        })
    }
}
const browserStore = new BrowserInitialTaskStore()
type Api = Pick<HapiRemoteApi, 'sourceInitialTask' | 'sourceInitialTaskRead' | 'sourceInitialTaskRetry' | 'sourceInitialTasks'>
type State = { loaded: boolean; busy: boolean; draft: InitialTaskDraft; error: string | null }
const empty = (): InitialTaskDraft => ({ version: 1, operationId: randomId(), text: '', files: [], creationRequestId: null, sessionId: null, request: null, submitted: false, receipt: null })
const imageTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
async function base64(blob: Blob): Promise<string> {
    const bytes = new Uint8Array(await blob.arrayBuffer()); let binary = ''
    for (let start = 0; start < bytes.length; start += 32768) binary += String.fromCharCode(...bytes.subarray(start, start + 32768))
    return btoa(binary)
}

/** One launch → one original session → one message identity, including attachment-only tasks. */
export class InitialTaskController {
    private state: State = { loaded: false, busy: false, draft: empty(), error: null }
    private listeners = new Set<() => void>()
    private writes: Promise<void> = Promise.resolve()
    private loading: Promise<void> | undefined
    private running: Promise<boolean> | undefined
    private reading: Promise<void> | undefined
    constructor(private readonly api: Api, private readonly upload: InitialFileUpload, private readonly key: string, private readonly store: InitialTaskStore = browserStore) {}
    getSnapshot = (): State => this.state
    subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
    private publish(patch: Partial<State>): void { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener() }
    private save(draft: InitialTaskDraft): Promise<void> {
        this.publish({ draft })
        const write = this.writes.catch(() => {}).then(() => this.store.write(this.key, draft))
        this.writes = write
        void write.catch(reason => this.publish({ error: errorMessage(reason) }))
        return write
    }
    load(): Promise<void> {
        return this.loading ??= (async () => {
            try { const saved = await this.store.read(this.key); this.publish({ loaded: true, ...(saved ? { draft: saved } : {}) }); if (saved?.sessionId) await this.refresh() }
            catch (reason) { this.publish({ error: errorMessage(reason) }) }
        })()
    }
    hasTask(): boolean { return Boolean(this.state.draft.text.trim() || this.state.draft.files.length) }
    setText(text: string): void {
        if (!this.state.loaded || this.state.draft.creationRequestId || this.state.busy) return
        void this.save({ ...this.state.draft, text }).catch(() => {})
    }
    async addFiles(files: readonly File[]): Promise<void> {
        if (!this.state.loaded || this.state.draft.creationRequestId || this.state.busy) return
        const existing = this.state.draft.files
        if (existing.length + files.length > 32 || files.some(file => file.size > 32 * 1024 * 1024)
            || [...existing.map(file => file.blob), ...files].reduce((sum, file) => sum + file.size, 0) > 128 * 1024 * 1024) {
            this.publish({ error: 'Use at most 32 attachments, 32 MiB each and 128 MiB in total.' }); return
        }
        try {
            await this.save({ ...this.state.draft, files: [...existing, ...files.map(file => ({ id: randomId(), name: file.name, mediaType: file.type, lastModified: file.lastModified, blob: file }))] })
        } catch { /* Persisted error remains visible. */ }
    }
    removeFile(id: string): void {
        if (this.state.draft.creationRequestId || this.state.busy) return
        void this.save({ ...this.state.draft, files: this.state.draft.files.filter(file => file.id !== id) }).catch(() => {})
    }
    /** Persist association before the first spawn request can be sent. */
    async prepare(creationRequestId: string): Promise<void> {
        await this.load(); await this.writes.catch(() => this.save(this.state.draft))
        if (!this.state.loaded) throw new Error(this.state.error ?? 'Task draft storage is unavailable')
        const draft = this.state.draft
        if (draft.creationRequestId && draft.creationRequestId !== creationRequestId) throw new Error('Finish the existing first task before creating another session')
        if (this.hasTask()) await this.save({ ...draft, creationRequestId })
    }
    async releaseRejectedCreation(): Promise<void> {
        if (!this.state.draft.sessionId && !this.state.draft.submitted) await this.save({ ...this.state.draft, creationRequestId: null })
    }
    /** A recovered submission is only observed. Upload/admission retries require an explicit action. */
    ready(sessionId: string, creationRequestId: string, explicitRetry = false): Promise<boolean> {
        if (this.running) return this.running
        this.running = (async () => {
            await this.load(); await this.writes.catch(() => this.save(this.state.draft))
            if (!this.hasTask()) return true
            if (this.state.draft.creationRequestId !== creationRequestId) throw new Error('This draft belongs to a different launch request')
            if (this.state.draft.receipt?.sourceConfirmed) return true
            this.publish({ busy: true, error: null })
            const previouslyBound = this.state.draft.sessionId !== null
            if (this.state.draft.sessionId && this.state.draft.sessionId !== sessionId) throw new Error('The source display changed; inspect its original delivery before continuing')
            await this.save({ ...this.state.draft, sessionId })
            if (previouslyBound && !explicitRetry) { await this.refresh(); return this.state.draft.receipt?.sourceConfirmed ?? false }
            if (this.state.draft.submitted) {
                await this.refresh()
                const receipt = this.state.draft.receipt
                if (!explicitRetry || receipt && !receipt.canRetry) return receipt?.sourceConfirmed ?? false
                if (receipt) {
                    const result = remoteValue(await this.api.sourceInitialTaskRetry({ operationId: this.state.draft.operationId }))
                    await this.save({ ...this.state.draft, receipt: result }); return result.sourceConfirmed
                }
                // The Host may never have received the request. Only an explicit
                // retry resends its already frozen operation/payload; it cannot spawn.
            }
            if (!this.state.draft.request) {
                const attachments: SourceInitialTask['attachments'] = []
                for (const file of this.state.draft.files) {
                    if (imageTypes.has(file.mediaType)) attachments.push({ type: 'image', mediaType: file.mediaType as 'image/png', data: await base64(file.blob), name: file.name })
                    else {
                        let receiptId = file.receiptId
                        if (!receiptId) {
                            const admittedId = (await this.upload(sessionId, new File([file.blob], file.name, { type: file.mediaType, lastModified: file.lastModified }))).receiptId
                            receiptId = admittedId
                            await this.save({ ...this.state.draft, files: this.state.draft.files.map(current => current.id === file.id ? { ...current, receiptId: admittedId } : current) })
                        }
                        attachments.push({ type: 'file', receiptId })
                    }
                }
                const draft = this.state.draft
                await this.save({ ...draft, request: { sessionId, creationRequestId, operationId: draft.operationId, text: draft.text, attachments } })
            }
            await this.save({ ...this.state.draft, submitted: true })
            const receipt = remoteValue(await this.api.sourceInitialTask(this.state.draft.request!))
            await this.save({ ...this.state.draft, receipt })
            return receipt.sourceConfirmed
        })().catch(reason => { this.publish({ error: errorMessage(reason) }); return false }).finally(() => { this.running = undefined; this.publish({ busy: false }) })
        return this.running
    }
    refresh(): Promise<void> {
        if (this.reading) return this.reading
        if (!this.state.draft.sessionId || !this.state.draft.submitted) return Promise.resolve()
        this.reading = (async () => {
            try {
                const receipt = remoteValue(await this.api.sourceInitialTaskRead({ operationId: this.state.draft.operationId }))
                if (receipt) await this.save({ ...this.state.draft, receipt })
            } catch (reason) { this.publish({ error: errorMessage(reason) }) }
            finally { this.reading = undefined }
        })()
        return this.reading
    }
    async completed(): Promise<void> {
        if (this.hasTask() && !this.state.draft.receipt?.sourceConfirmed) throw new Error('The first task is not confirmed by the source')
        await this.writes; await this.store.write(this.key, null)
    }
}
