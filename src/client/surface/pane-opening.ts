import { recordDiagnostic, type DiagnosticIdentity, type DiagnosticInput } from '../diagnostics/index.ts'

type OpeningStage = 'reference' | 'content' | 'composer'
let openingSequence = 0

/** Cumulative Host startup timings, including the work before a pane can mount. */
export class HostOpeningTiming {
    private readonly started: number
    private readonly requestId = `host-open-${Date.now()}-${++openingSequence}`
    private readonly seen = new Set<string>()
    constructor(private readonly hostId: string,
        private readonly emit: (entry: DiagnosticInput) => void = recordDiagnostic,
        private readonly now: () => number = () => performance.now()) { this.started = now() }
    mark(stage: 'resources' | 'graph' | 'ui' | 'catalog' | 'failed'): void {
        if (this.seen.has(stage)) return
        this.seen.add(stage)
        this.emit({ source: 'performance', event: 'pane.opening', method: `host.${stage}`,
            durationMs: this.now() - this.started, outcome: stage === 'failed' ? 'error' : 'ready',
            identity: { hostId: this.hostId }, requestId: this.requestId })
    }
}

/** DOM mount timings, not paint or interaction readiness. No conversation text is read. */
export class PaneOpeningTiming {
    private readonly requestId = `pane-open-${Date.now()}-${++openingSequence}`
    private readonly started: number
    private readonly seen = new Set<OpeningStage>()
    private closed = false
    private blank = false
    constructor(private readonly identity: DiagnosticIdentity, private readonly warm: boolean,
        private readonly emit: (entry: DiagnosticInput) => void = recordDiagnostic,
        private readonly now: () => number = () => performance.now()) { this.started = now() }
    get complete(): boolean { return this.seen.has('reference') && this.seen.has('composer') && (this.blank || this.seen.has('content')) }
    referenceReady(blank: boolean): void { this.blank = blank; this.mark('reference') }
    mark(stage: OpeningStage): void {
        if (this.closed || this.seen.has(stage)) return
        this.seen.add(stage)
        this.emit({ source: 'performance', event: 'pane.opening', method: `pane.${stage}.${stage === 'reference' ? 'ready' : 'mounted'}`,
            durationMs: this.now() - this.started, outcome: this.warm ? 'warm' : 'cold', identity: this.identity, requestId: this.requestId })
    }
    stop(outcome: 'closed' | 'hidden' | 'error' | 'timeout' = 'closed'): void {
        if (this.closed) return
        this.closed = true
        if (!this.complete) this.emit({ source: 'performance', event: 'pane.opening', method: 'pane.incomplete',
            durationMs: this.now() - this.started, outcome, identity: this.identity, requestId: this.requestId })
    }
}

/** Observe only the initial mount. Disconnect on completion, retirement or 30 s. */
export function observePaneOpening(target: HTMLElement, identity: DiagnosticIdentity, warm: boolean): {
    referenceReady(blank: boolean): void
    stop(outcome?: 'closed' | 'hidden' | 'error' | 'timeout'): void
} {
    const timing = new PaneOpeningTiming(identity, warm)
    let stopped = false, contentMounted = false, composerMounted = false
    const stop = (outcome?: 'closed' | 'hidden' | 'error' | 'timeout'): void => {
        if (stopped) return
        stopped = true; observer.disconnect(); clearTimeout(timeout); timing.stop(outcome)
    }
    const sample = (): void => {
        if (stopped) return
        if (!contentMounted && target.querySelector('[data-chat-node-key]')) { contentMounted = true; timing.mark('content') }
        if (!composerMounted && target.querySelector('[data-composer-input]')) { composerMounted = true; timing.mark('composer') }
        if (timing.complete) stop()
    }
    const observer = new MutationObserver(sample)
    const timeout = setTimeout(() => stop('timeout'), 30_000)
    observer.observe(target, { childList: true, subtree: true })
    sample()
    return { referenceReady(blank) { if (!stopped) { timing.referenceReady(blank); sample() } }, stop }
}
