/** Browser-owned on-device recognition. It has no remote transport or cloud fallback. */
import { useCallback, useEffect, useRef, useState } from 'react'
import { hasBrowserLocalSpeechSupport } from './browser-local.ts'
import { startBrowserLocalTranscription, type RealtimeTranscriptionSession } from './realtime-transcription.ts'
import type { VoicePreferences } from './preferences.ts'

export type DictationStatus = 'idle' | 'connecting' | 'listening' | 'processing' | 'error'
interface Run { abort: AbortController; session?: RealtimeTranscriptionSession; stopping: boolean; transcript: string }
export function supportsDictation(): boolean { return hasBrowserLocalSpeechSupport() }
export function useSourceDictation(onFinal: (text: string, interrupted: boolean, lifecycle: boolean, detached: boolean) => void, onSettled: () => void, signal?: AbortSignal) {
    const [status, setStatus] = useState<DictationStatus>('idle'), [partial, setPartial] = useState('')
    const active = useRef<Run | null>(null), mounted = useRef(true)
    const callbacks = useRef({ onFinal, onSettled }); callbacks.current = { onFinal, onSettled }
    const cleanup = useCallback((run: Run) => { run.abort.abort(); run.session?.cancel() }, [])
    const cancel = useCallback(() => {
        const run = active.current; active.current = null
        if (run) { cleanup(run); callbacks.current.onSettled() }
        if (mounted.current) { setStatus('idle'); setPartial('') }
    }, [cleanup])
    const settle = useCallback((run: Run, text?: string, interrupted = false, lifecycle = false) => {
        if (active.current !== run) return
        active.current = null; cleanup(run)
        if (mounted.current) {
            setStatus(!lifecycle && (text === undefined || interrupted) ? 'error' : 'idle'); setPartial('')
        }
        if (text !== undefined) callbacks.current.onFinal(text.trim(), interrupted, lifecycle, !mounted.current)
        callbacks.current.onSettled()
    }, [cleanup])
    const interrupt = useCallback(() => {
        const run = active.current
        if (run) settle(run, run.transcript, true, true)
    }, [settle])
    const start = useCallback(async (preferences: VoicePreferences) => {
        signal?.throwIfAborted()
        if (active.current) return
        if (!supportsDictation()) throw new Error('Local dictation is unavailable')
        const run: Run = { abort: new AbortController(), stopping: false, transcript: '' }
        active.current = run; setStatus('connecting'); setPartial('')
        const current = () => active.current === run && !run.abort.signal.aborted
        try {
            const session = await startBrowserLocalTranscription({
                ...(preferences.language ? { language: preferences.language } : {}), signal: run.abort.signal,
                callbacks: {
                    onConnected: () => { if (current()) setStatus('listening') },
                    onPartial: text => { if (current()) { run.transcript = text; setPartial(text) } },
                    onFinal: text => settle(run, text),
                    onError: (_error, text) => settle(run, text, true),
                },
            })
            if (current()) run.session = session; else session.cancel()
        } catch { if (current()) settle(run) }
    }, [settle, signal])
    const stop = useCallback(async () => {
        const run = active.current
        if (!run || run.stopping) return
        run.stopping = true; setStatus('processing')
        if (!run.session) { cancel(); return }
        try { await run.session.stop() } catch { settle(run, run.transcript, true) }
    }, [cancel, settle])
    useEffect(() => {
        if (signal?.aborted) interrupt()
        signal?.addEventListener('abort', interrupt, { once: true })
        return () => signal?.removeEventListener('abort', interrupt)
    }, [interrupt, signal])
    useEffect(() => {
        mounted.current = true
        return () => { mounted.current = false; interrupt() }
    }, [interrupt])
    return { status, partial, start, stop, cancel, interrupt }
}
