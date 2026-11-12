/** Adapted from HAPI 0f8ef697 web/src/hooks/realtimeTranscription.ts. AGPL-3.0-only; see ../../../voice/UPSTREAM.md. */
import {
    getBrowserLocalSpeechSupport,
    type LocalSpeechRecognition,
    type LocalSpeechRecognitionAvailability,
    type LocalSpeechRecognitionConstructor,
    type LocalSpeechRecognitionEvent
} from './browser-local.ts'

export interface RealtimeTranscriptionCallbacks {
    onConnected: () => void
    onPartial: (text: string) => void
    onFinal: (text: string) => void
    /** An interrupted recognizer retains words already shown, for explicit review/insertion. */
    onError: (error: Error, transcript?: string) => void
}

export interface RealtimeTranscriptionSession {
    stop: () => Promise<void>
    cancel: () => void
}

function joinTranscriptParts(...parts: string[]): string {
    return parts.map((part) => part.trim()).filter(Boolean).join(' ')
}

export const BROWSER_LOCAL_AVAILABILITY_TIMEOUT_MS = 10_000

interface BrowserLocalAvailabilityProbe {
    readonly available: LocalSpeechRecognitionAvailability
    readonly constructor: LocalSpeechRecognitionConstructor
    readonly language: string
    readonly subscribers: Set<BrowserLocalAvailabilitySubscriber>
}

interface BrowserLocalAvailabilitySubscriber {
    resolve: (status: string) => void
    reject: (error: unknown) => void
}

const browserLocalAvailabilityProbes = new WeakMap<LocalSpeechRecognitionConstructor, Map<string, BrowserLocalAvailabilityProbe>>()

function browserLocalProbeMap(constructor: LocalSpeechRecognitionConstructor): Map<string, BrowserLocalAvailabilityProbe> {
    let probes = browserLocalAvailabilityProbes.get(constructor)
    if (!probes) {
        probes = new Map()
        browserLocalAvailabilityProbes.set(constructor, probes)
    }
    return probes
}

function getBrowserLocalAvailabilityProbe(options: {
    available: LocalSpeechRecognitionAvailability
    constructor: LocalSpeechRecognitionConstructor
    language: string
}): BrowserLocalAvailabilityProbe {
    const probes = browserLocalProbeMap(options.constructor)
    const existing = probes.get(options.language)
    if (existing) return existing

    const probe: BrowserLocalAvailabilityProbe = {
        ...options,
        subscribers: new Set()
    }
    probes.set(options.language, probe)
    queueMicrotask(() => {
        if (probe.subscribers.size === 0) {
            probes.delete(options.language)
            return
        }
        Promise.resolve()
            .then(() => probe.available.call(probe.constructor, { langs: [probe.language], processLocally: true }))
            .then(
                (status) => settleBrowserLocalAvailabilityProbe(probes, probe, (subscriber) => subscriber.resolve(status)),
                (error) => settleBrowserLocalAvailabilityProbe(probes, probe, (subscriber) => subscriber.reject(error))
            )
    })
    return probe
}

function settleBrowserLocalAvailabilityProbe(
    probes: Map<string, BrowserLocalAvailabilityProbe>,
    probe: BrowserLocalAvailabilityProbe,
    notify: (subscriber: BrowserLocalAvailabilitySubscriber) => void
): void {
    if (probes.get(probe.language) !== probe) return
    probes.delete(probe.language)
    const subscribers = Array.from(probe.subscribers)
    probe.subscribers.clear()
    subscribers.forEach(notify)
}

export function getBrowserLocalAvailabilityProbeSubscriberCountForTesting(
    constructor: object,
    language: string
): number {
    return browserLocalAvailabilityProbes
        .get(constructor as LocalSpeechRecognitionConstructor)
        ?.get(language)
        ?.subscribers.size ?? 0
}

function abortError(signal: AbortSignal): unknown {
    return signal.reason ?? new Error('On-device speech recognition availability check was aborted')
}

async function checkBrowserLocalSpeechAvailability(options: {
    available: LocalSpeechRecognitionAvailability
    constructor: LocalSpeechRecognitionConstructor
    language: string
    signal?: AbortSignal
}): Promise<string> {
    options.signal?.throwIfAborted()
    const probe = getBrowserLocalAvailabilityProbe(options)

    return await new Promise<string>((resolve, reject) => {
        let settled = false
        const subscriber: BrowserLocalAvailabilitySubscriber = { resolve, reject }
        const detach = () => probe.subscribers.delete(subscriber)
        const finish = (callback: () => void) => {
            if (settled) return
            settled = true
            clearTimeout(timeout)
            options.signal?.removeEventListener('abort', onAbort)
            detach()
            callback()
        }
        const timeout = setTimeout(() => {
            finish(() => reject(new Error('On-device speech recognition availability check timed out')))
        }, BROWSER_LOCAL_AVAILABILITY_TIMEOUT_MS)
        const onAbort = () => finish(() => reject(abortError(options.signal!)))
        if (options.signal?.aborted) {
            onAbort()
            return
        }
        probe.subscribers.add(subscriber)
        options.signal?.addEventListener('abort', onAbort, { once: true })
        subscriber.resolve = (status) => finish(() => resolve(status))
        subscriber.reject = (error) => finish(() => reject(error))
    })
}

export async function startBrowserLocalTranscription(options: {
    language?: string
    signal?: AbortSignal
    callbacks: RealtimeTranscriptionCallbacks
}): Promise<RealtimeTranscriptionSession> {
    options.signal?.throwIfAborted()
    const support = getBrowserLocalSpeechSupport()
    if (!support) throw new Error('On-device speech recognition is not supported by this browser')
    const language = options.language || navigator.language
    // `available()` is deferred to a microtask so an abort between start and
    // native invocation detaches its only consumer before touching the API.
    options.signal?.throwIfAborted()
    if (await checkBrowserLocalSpeechAvailability({ ...support, language, ...(options.signal ? { signal: options.signal } : {}) }) !== 'available') {
        throw new Error(`On-device speech recognition is not installed for ${language}`)
    }
    options.signal?.throwIfAborted()

    const recognition = new support.constructor()
    recognition.continuous = true
    recognition.interimResults = true
    recognition.lang = language
    recognition.processLocally = true
    let current = ''
    let finished = false
    let stopping = false

    const cancel = () => {
        if (finished) return
        finished = true
        releaseRecognition()
    }
    const releaseRecognition = () => {
        options.signal?.removeEventListener('abort', cancel)
        recognition.onresult = null
        recognition.onerror = null
        recognition.onend = null
        try { recognition.abort() } catch { /* Already ended recognition has no microphone to retain. */ }
    }

    const finish = () => {
        if (finished) return
        finished = true
        releaseRecognition()
        options.callbacks.onFinal(current)
    }
    recognition.onresult = (event) => {
        if (finished) return
        const finalParts: string[] = []
        const interimParts: string[] = []
        for (let index = 0; index < event.results.length; index += 1) {
            const result = event.results[index]
            const transcript = result?.[0]?.transcript ?? ''
            if (result?.isFinal) finalParts.push(transcript)
            else interimParts.push(transcript)
        }
        current = joinTranscriptParts(...finalParts, ...interimParts)
        if (current.length > 2 * 1024 * 1024) {
            finished = true; releaseRecognition(); options.callbacks.onError(new Error('On-device transcript exceeded its limit'), current); return
        }
        options.callbacks.onPartial(current)
    }
    recognition.onerror = (event) => {
        if (event.error === 'aborted' && stopping) return
        finished = true
        releaseRecognition()
        options.callbacks.onError(new Error(event.error ? `On-device transcription failed: ${event.error}` : 'On-device transcription failed'), current)
    }
    recognition.onend = () => {
        if (stopping) finish()
        else if (!finished) {
            finished = true
            releaseRecognition()
            options.callbacks.onError(new Error('On-device transcription stopped'), current)
        }
    }
    options.signal?.addEventListener('abort', cancel, { once: true })
    if (options.signal?.aborted) { cancel(); options.signal.throwIfAborted() }
    try { recognition.start() } catch (error) { cancel(); throw error }
    if (!finished) options.callbacks.onConnected()

    return {
        stop: async () => {
            if (finished || stopping) return
            stopping = true
            recognition.stop()
            await new Promise<void>((resolve) => {
                const timeout = setTimeout(() => {
                    clearInterval(check)
                    finish()
                    resolve()
                }, 2_500)
                const check = setInterval(() => {
                    if (!finished) return
                    clearInterval(check)
                    clearTimeout(timeout)
                    resolve()
                }, 25)
            })
        },
        cancel
    }
}
