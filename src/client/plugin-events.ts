/**
 * One public /plugins/events transport per Host. Every official Client graph
 * still owns its HMR plugin, parser, loader, and disposal; only identical wire
 * bytes are shared so HTTP/1 browsers do not spend one socket per pane.
 */
type EventConnection = { opening: Promise<Response>; abort: AbortController; failure?: unknown }

export class SharedPluginEvents {
    private readonly lifetime = new AbortController()
    private connection: EventConnection | undefined
    private readonly subscribers = new Map<ReadableStreamDefaultController<Uint8Array>, EventConnection>()
    private graph: Uint8Array | undefined
    private readonly rebuilt = new Map<string, Uint8Array>()
    private stopped = false
    private readonly encoder = new TextEncoder()
    constructor(private readonly fetch: typeof globalThis.fetch, private readonly url: string, signal?: AbortSignal) {
        if (signal?.aborted) this.stop(signal.reason)
        else signal?.addEventListener('abort', () => { this.stop(signal.reason) }, { once: true })
    }
    private start(): EventConnection {
        if (this.connection) return this.connection
        const connection: EventConnection = { opening: undefined as unknown as Promise<Response>, abort: new AbortController() }
        this.connection = connection; this.graph = undefined; this.rebuilt.clear()
        connection.opening = this.fetch(this.url, { method: 'GET', headers: { accept: 'text/event-stream' }, signal: AbortSignal.any([this.lifetime.signal, connection.abort.signal]) }).then(response => {
            if (!response.ok || !response.body) {
                void response.body?.cancel()
                throw new Error(`Official plugin events returned HTTP ${response.status}`)
            }
            void this.read(response.body, connection).catch(error => { this.fail(error, connection) })
            return response
        }).catch(error => { this.fail(error, connection); throw error })
        return connection
    }
    private async read(body: ReadableStream<Uint8Array>, connection: EventConnection): Promise<void> {
        const reader = body.getReader(), decoder = new TextDecoder()
        let buffer = ''
        try {
            for (;;) {
                const item = await reader.read()
                if (item.done) break
                buffer += decoder.decode(item.value, { stream: true })
                for (;;) {
                    const boundary = /\r?\n\r?\n/.exec(buffer)
                    if (!boundary) break
                    const end = boundary.index + boundary[0].length
                    this.frame(buffer.slice(0, end), connection); buffer = buffer.slice(end)
                }
                if (buffer.length > 4 * 1024 * 1024) throw new Error('Official plugin event exceeded the transport frame limit')
            }
            if (!this.stopped) throw new Error('Official plugin events closed; reopen this Host to restore plugin updates')
        } finally { reader.releaseLock() }
    }
    private frame(text: string, connection: EventConnection): void {
        if (this.connection !== connection || connection.failure !== undefined || this.stopped) return
        const bytes = this.encoder.encode(text)
        // This cache only retains opaque official envelopes for late readers.
        // The unchanged upstream HMR plugin still parses and applies them.
        const data = text.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n')
        try {
            const value: unknown = JSON.parse(data)
            if (value && typeof value === 'object') {
                const frame = value as Record<string, unknown>
                if (frame.type === 'graph' && frame.graph && typeof frame.graph === 'object') {
                    this.graph = bytes; this.rebuilt.clear()
                } else if (frame.type === 'rebuilt' && typeof frame.id === 'string' && typeof frame.rev === 'string') {
                    this.rebuilt.delete(frame.id); this.rebuilt.set(frame.id, bytes)
                }
            }
        } catch { /* Forward malformed frames unchanged; official HMR reports them. */ }
        for (const [subscriber, owner] of [...this.subscribers]) {
            if (owner !== connection) continue
            if ((subscriber.desiredSize ?? 0) < -4 * 1024 * 1024) {
                subscriber.error(new Error('This pane stopped consuming official plugin events'))
                this.subscribers.delete(subscriber)
            } else subscriber.enqueue(bytes.slice())
        }
    }
    private fail(error: unknown, connection: EventConnection): void {
        if (connection.failure !== undefined) return
        connection.failure = error
        if (this.connection === connection) { this.connection = undefined; this.graph = undefined; this.rebuilt.clear() }
        for (const [subscriber, owner] of this.subscribers) if (owner === connection) {
            subscriber.error(error); this.subscribers.delete(subscriber)
        }
        connection.abort.abort(error)
    }
    async response(signal?: AbortSignal | null): Promise<Response> {
        signal?.throwIfAborted(); this.lifetime.signal.throwIfAborted()
        const connection = this.start()
        const source = await connection.opening
        signal?.throwIfAborted(); this.lifetime.signal.throwIfAborted()
        if (connection.failure !== undefined) throw connection.failure
        let controller: ReadableStreamDefaultController<Uint8Array> | undefined
        const release = (): void => { if (controller) this.subscribers.delete(controller); signal?.removeEventListener('abort', abort) }
        const abort = (): void => { const current = controller; release(); current?.error(signal?.reason ?? new DOMException('Aborted', 'AbortError')) }
        const body = new ReadableStream<Uint8Array>({
            start: subscriber => {
                controller = subscriber; this.subscribers.set(subscriber, connection)
                if (this.graph) subscriber.enqueue(this.graph.slice())
                for (const event of this.rebuilt.values()) subscriber.enqueue(event.slice())
                signal?.addEventListener('abort', abort, { once: true })
                if (signal?.aborted) abort()
            },
            cancel: release,
        }, { highWaterMark: 64 * 1024, size: bytes => bytes.byteLength })
        return new Response(body, { status: source.status, headers: source.headers })
    }
    stop(reason: unknown = new DOMException('Host disposed', 'AbortError')): void {
        if (this.stopped) return
        this.stopped = true; this.lifetime.abort(reason)
        if (this.connection) this.fail(reason, this.connection)
        this.graph = undefined; this.rebuilt.clear()
    }
}

export function isPluginEventsRequest(input: RequestInfo | URL, init?: RequestInit, origin = 'http://host.invalid'): boolean {
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    if (method.toUpperCase() !== 'GET') return false
    const value = input instanceof Request ? input.url : String(input)
    const url = new URL(value, `${origin}/`)
    if (url.origin !== origin || url.search || url.hash) return false
    const path = url.pathname
    return path === '/plugins/events' || path.endsWith('/plugins/events') && path.startsWith('/hapi-dsh/machine/')
}

/** Public shell fetch carrier; the authenticated Hub sends exact upstream bytes. */
export function pluginEventsOverWebSocket(url: string | URL, signal?: AbortSignal | null,
    createSocket: (url: string | URL) => WebSocket = value => new WebSocket(value)): Promise<Response> {
    signal?.throwIfAborted()
    return new Promise<Response>((resolve, reject) => {
        const socket = createSocket(url)
        socket.binaryType = 'arraybuffer'
        let head = false, ended = false
        let stream: ReadableStreamDefaultController<Uint8Array> | undefined
        const remove = (): void => { signal?.removeEventListener('abort', abort) }
        const fail = (reason: unknown): void => {
            if (ended) return
            ended = true; remove()
            if (head) stream?.error(reason)
            else reject(reason)
            socket.close()
        }
        const abort = (): void => { fail(signal?.reason ?? new DOMException('Aborted', 'AbortError')) }
        socket.addEventListener('error', () => { fail(new Error('Official plugin event transport could not connect')) })
        socket.addEventListener('close', () => { fail(new Error('Official plugin event transport closed before its source ended')) })
        socket.addEventListener('message', event => {
            if (ended) return
            try {
                if (typeof event.data !== 'string') {
                    if (!head || !stream || !(event.data instanceof ArrayBuffer)) throw new Error('Invalid official plugin event body frame')
                    if ((stream.desiredSize ?? 0) < -4 * 1024 * 1024) throw new Error('Official plugin event transport exceeded its reader buffer')
                    stream.enqueue(new Uint8Array(event.data)); return
                }
                const value: unknown = JSON.parse(event.data)
                if (!value || typeof value !== 'object') throw new Error('Invalid official plugin event transport frame')
                const frame = value as Record<string, unknown>
                if (frame.type === 'head') {
                    if (head || !Number.isSafeInteger(frame.status) || (frame.status as number) < 200 || (frame.status as number) > 599
                        || !Array.isArray(frame.headers) || frame.headers.some(item => !Array.isArray(item) || item.length !== 2 || item.some(value => typeof value !== 'string'))) throw new Error('Invalid official plugin event headers')
                    const body = new ReadableStream<Uint8Array>({
                        start(controller) { stream = controller },
                        cancel() { ended = true; remove(); socket.close() },
                    }, { highWaterMark: 64 * 1024, size: bytes => bytes.byteLength })
                    const response = new Response(body, { status: frame.status as number, headers: frame.headers as Array<[string, string]> })
                    head = true; resolve(response)
                } else if (frame.type === 'end') {
                    if (!head) throw new Error('Official plugin event transport ended without response headers')
                    ended = true; remove(); stream?.close(); socket.close()
                } else if (frame.type === 'error') {
                    fail(new Error(typeof frame.message === 'string' ? frame.message : 'The source plugin event stream was interrupted'))
                } else throw new Error('Unknown official plugin event transport frame')
            } catch (error) { fail(error) }
        })
        signal?.addEventListener('abort', abort, { once: true })
        if (signal?.aborted) abort()
    })
}
