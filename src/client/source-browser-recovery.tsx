/** Explicit local export of old browser drafts. Never assigns them to the signed-in account. */
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from './workspace-ui.ts'

const prefixes = ['hapi-dsh:composer-draft:v1:', 'dsh.conversation.', 'hapi-dsh:workspace:v1:',
    'hapi.scratchlist.v1.', 'hapi-dsh:schedule:', 'hapi-dsh:note-draft:', 'hapi-dsh:title-draft:']
const databaseNames = new Set(['hapi-dsh-composer-attachments', 'hapi-dsh-source-document-drafts', 'hapi-dsh-draft-handoffs', 'hapi-dsh-composer-parking', 'hapi-dsh-initial-task', 'hapi-share-transfers'])
const selectedKey = (key: string) => prefixes.some(prefix => key.startsWith(prefix))
    || /^hapi-dsh:host:[^:]+:pane:[^:]+:dsh\.conversation\./u.test(key)
export interface BrowserRecoverySnapshot {
    version: 1; origin: string; createdAt: number
    localStorage: Array<{ key: string; value: string }>
    databases: Array<{ name: string; version: number; stores: Array<{ name: string; records: Array<{ key: unknown; value: unknown }> }> }>
}

function readDatabase(factory: IDBFactory, name: string): Promise<BrowserRecoverySnapshot['databases'][number]> {
    return new Promise((resolve, reject) => {
        let blocked = false
        const opening = factory.open(name)
        opening.onupgradeneeded = () => opening.transaction?.abort()
        opening.onerror = () => reject(opening.error ?? new Error('The saved browser data could not be opened.'))
        opening.onblocked = () => { blocked = true; reject(new Error('Another tab is updating the saved drafts. Close its update dialog and try again.')) }
        opening.onsuccess = () => {
            const db = opening.result, names = [...db.objectStoreNames]
            if (blocked) { db.close(); return }
            const result: BrowserRecoverySnapshot['databases'][number] = { name, version: db.version, stores: [] }
            if (!names.length) { db.close(); resolve(result); return }
            const transaction = db.transaction(names, 'readonly')
            transaction.onabort = () => { db.close(); reject(transaction.error ?? new Error('The browser export was interrupted.')) }
            transaction.oncomplete = () => { db.close(); resolve(result) }
            for (const name of names) {
                const records: Array<{ key: unknown; value: unknown }> = []
                result.stores.push({ name, records })
                const cursor = transaction.objectStore(name).openCursor()
                cursor.onsuccess = () => {
                    const row = cursor.result
                    if (row) { records.push({ key: row.key, value: row.value }); row.continue() }
                }
            }
        }
    })
}

/** Capture values while each database's readonly transaction is open; serialize blobs afterwards. */
export async function captureBrowserRecovery(storage: Storage, factory: IDBFactory, origin: string): Promise<BrowserRecoverySnapshot> {
    const values: BrowserRecoverySnapshot['localStorage'] = []
    for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i)
        if (key && selectedKey(key)) {
            const value = storage.getItem(key)
            if (value !== null) values.push({ key, value })
        }
    }
    if (typeof factory.databases !== 'function') throw new Error('This browser cannot enumerate saved drafts. Open this site in a browser that supports IndexedDB database discovery.')
    const names = (await factory.databases()).flatMap(value => value.name && databaseNames.has(value.name) ? [value.name] : [])
    return { version: 1, origin, createdAt: Date.now(), localStorage: values, databases: await Promise.all(names.map(name => readDatabase(factory, name))) }
}

function blobBytes(value: unknown): number {
    if (value instanceof Blob) return value.size
    if (Array.isArray(value)) return value.reduce<number>((sum, item) => sum + blobBytes(item), 0)
    if (value && typeof value === 'object') return Object.values(value).reduce<number>((sum, item) => sum + blobBytes(item), 0)
    return 0
}
export function browserRecoverySummary(snapshot: BrowserRecoverySnapshot): { records: number; bytes: number } {
    return { records: snapshot.localStorage.length + snapshot.databases.reduce((sum, db) => sum + db.stores.reduce((sum, store) => sum + store.records.length, 0), 0),
        bytes: new TextEncoder().encode(JSON.stringify(snapshot)).byteLength + blobBytes(snapshot) }
}

export async function encodeBrowserRecovery(value: unknown): Promise<unknown> {
    if (value instanceof Blob) {
        const bytes = new Uint8Array(await value.arrayBuffer())
        let binary = ''
        for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768))
        return { $hhpiBlob: 1, type: value.type, ...(typeof File !== 'undefined' && value instanceof File ? { name: value.name, lastModified: value.lastModified } : {}), data: btoa(binary) }
    }
    if (Array.isArray(value)) return Promise.all(value.map(encodeBrowserRecovery))
    if (value && typeof value === 'object') {
        if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error('A saved draft contains an unsupported browser value. The original data has been kept.')
        return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await encodeBrowserRecovery(item)])))
    }
    return value
}

export function installBrowserRecovery(ctx: Context): () => void {
    const Settings = () => {
        const language = useSyncExternalStore(listener => ctx.locale.subscribe(listener), () => ctx.locale.getSnapshot().active)
        const identity = useSyncExternalStore(ctx.hapiWorkspaceUi.application.subscribe, ctx.hapiWorkspaceUi.application.getSnapshot)
        const tr = (en: string, zh: string) => language.startsWith('zh') ? zh : en
        const [summary, setSummary] = useState<{ records: number; bytes: number }>(), [error, setError] = useState(''), [busy, setBusy] = useState(false)
        useEffect(() => { setSummary(undefined); setError('') }, [identity])
        const run = async (download: boolean) => {
            if (!identity || busy) return
            setBusy(true); setError('')
            try {
                const snapshot = await captureBrowserRecovery(localStorage, indexedDB, location.origin)
                identity.signal.throwIfAborted()
                setSummary(browserRecoverySummary(snapshot))
                if (download) {
                    const data = await encodeBrowserRecovery(snapshot)
                    identity.signal.throwIfAborted()
                    const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }))
                    const link = document.createElement('a'); link.href = url; link.download = 'hhpi-browser-recovery.json'
                    document.body.append(link); link.click(); link.remove()
                    setTimeout(() => URL.revokeObjectURL(url), 1000)
                }
            } catch (cause) { if (!identity.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)) }
            finally { setBusy(false) }
        }
        return <section className="hapi-notification-settings" aria-label={tr('Saved browser data', '浏览器中的旧数据')}>
            <h2>{tr('Saved browser data', '浏览器中的旧数据')}</h2>
            <p>{tr('Old drafts may not identify their account or original machine. Download a local recovery file to retain their text, attachments and workspace layout for recovery.',
                '旧版草稿可能没有记录所属账号或机器。可下载本地恢复文件，保留文字、附件和工作区布局，供恢复使用。')}</p>
            <p>{tr('This export stays on this device. Existing data is kept and no message is sent.', '文件只保存到本机；原有数据保留，不会发送消息。')}</p>
            {summary && <p role="status">{tr(`${summary.records} saved records · approximately ${(summary.bytes / 1024).toFixed(1)} KiB`, `${summary.records} 条记录，约 ${(summary.bytes / 1024).toFixed(1)} KiB`)}</p>}
            {error && <p role="alert" className="hapi-notification-error">{error}</p>}
            <div className="hapi-notification-actions"><button type="button" disabled={!identity || busy} onClick={() => { void run(false) }}>{tr('Check saved data', '检查旧数据')}</button>
                <button type="button" disabled={!identity || busy} onClick={() => { void run(true) }}>{busy ? tr('Preparing…', '正在准备…') : tr('Download recovery file', '下载恢复文件')}</button></div>
        </section>
    }
    return ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'hhpi-browser-recovery', order: 36,
        label: () => ctx.locale.getSnapshot().active.startsWith('zh') ? '浏览器中的旧数据' : 'Saved browser data' }, Settings))
}
