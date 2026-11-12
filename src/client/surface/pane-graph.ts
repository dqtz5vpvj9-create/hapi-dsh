/**
 * Pane graph policy: which official client rows a pane boots, and how the
 * Host's shared `/plugins/events` stream is projected onto that subset.
 *
 * Upstream has no body-only Conversation entry: `ctx.slots.renderSlot` renders
 * only `root` (ui-renderer `renderSlot` guard), and the `main.conversation`
 * render authority belongs to ui-conversation's private ConversationPanel, which
 * only renders under the AppFrame that ui-layout declares. A pane therefore
 * boots the official graph and mounts its root; the structural work is to boot
 * only the rows a conversation surface actually needs and to leave the
 * window-level chrome to the primary graph.
 *
 * Every excluded row is a plugin the official loader would otherwise evaluate
 * and activate in every pane. The list is deliberately data-driven: it contains
 * settings subpages, inspectors, analytics, and the HAPI client bundle itself;
 * nothing that renders the conversation, its composer, its header, the right
 * column (Files/Document/Terminal), official tool renderers, or the
 * workspace/plugin infrastructure they depend on. `ui-deliverables` is retained
 * for exactly that reason: it owns the `present` tool renderer and the
 * changes-review right-column tab, so it is a conversation/rightbar surface, not
 * window chrome.
 */
import type { WebBootGraph } from '@deepseek-ai/dsh-client-modules/client'
import type { PaneGraphPolicy } from './contracts.ts'

/**
 * Rows a pane does not evaluate.
 *
 * `hapi-dsh` is excluded because the primary graph installs the pane-only HAPI
 * surfaces on the pane Context (`installPaneNative`): one evaluation of the
 * ~4 MB client bundle per page instead of one per pane.
 *
 * The remaining rows are official surfaces that only make sense once per
 * window: settings subpages, the plugin inventory/market, trajectory and
 * schedule inspectors, message feedback, and product analytics. A pane that
 * loses one of those pages still renders chat.
 */
export const PANE_GRAPH_EXCLUDE: ReadonlySet<string> = new Set([
    'hapi-dsh',
    '@deepseek-ai/dsh-client-ui-settings-account',
    '@deepseek-ai/dsh-cordis-client-runner',
    '@deepseek-ai/dsh-client-ui-trajectory',
    '@deepseek-ai/dsh-client-ui-schedule',
    '@deepseek-ai/dsh-client-ui-settings-models',
    '@deepseek-ai/dsh-client-ui-agent-preset',
    '@deepseek-ai/dsh-client-ui-cordis',
    '@deepseek-ai/dsh-client-ui-settings-plugin-inventory',
    '@deepseek-ai/dsh-client-ui-settings-subagent',
    '@deepseek-ai/dsh-client-ui-message-feedback',
    '@deepseek-ai/dsh-client-ui-settings-web-search',
    '@deepseek-ai/dsh-client-ui-settings-plugins',
    '@deepseek-ai/dsh-client-ui-settings-shell',
    '@deepseek-ai/dsh-client-ui-settings-session-log',
    '@deepseek-ai/dsh-client-ui-settings-agent-loop',
    '@deepseek-ai/dsh-client-product-analytics',
])

/**
 * Project the unchanged Host graph onto the pane subset.
 *
 * A Host initial batch is one combo script: executing it registers every module
 * it contains, including excluded ones. Each retained row therefore gets its own
 * single-resource batch, so a filtered pane never evaluates excluded code. The
 * row URL is the module loader's documented single-resource fallback, and the
 * bootstrap/application phase of the original batch is preserved.
 */
function transformPanes(graph: WebBootGraph): WebBootGraph {
    const entries = graph.entries.filter(row => !PANE_GRAPH_EXCLUDE.has(row.id))
    const phase = new Map<string, WebBootGraph['batches'][number]['phase']>()
    for (const batch of graph.batches) for (const id of batch.entries) phase.set(id, batch.phase)
    const batches: WebBootGraph['batches'] = entries.map(row => ({
        phase: phase.get(row.id) ?? 'application',
        url: row.url,
        rev: row.rev,
        entries: [row.id],
    }))
    return { ...graph, entries, batches }
}

/** The single data-driven pane graph policy used by federation. */
export const PANE_GRAPH_POLICY: PaneGraphPolicy = { exclude: PANE_GRAPH_EXCLUDE, transform: transformPanes }

/** Row ids a pane graph boots, in Host graph order. */
export function paneRows(graph: WebBootGraph): string[] {
    return transformPanes(graph).entries.map(row => row.id)
}

/**
 * Project one `/plugins/events` payload onto the pane subset. Returns the
 * original data string when no projection applies, `undefined` to drop the
 * frame (a rebuild of an excluded row), and a rewritten JSON string for a graph
 * sync so a pane never re-syncs the excluded rows through HMR.
 */
export function filterPluginEventData(data: string): string | undefined {
    let value: unknown
    try { value = JSON.parse(data) } catch { return data }
    if (!value || typeof value !== 'object') return data
    const frame = value as Record<string, unknown>
    if (frame.type === 'graph' && frame.graph && typeof frame.graph === 'object') {
        const graph = frame.graph as WebBootGraph
        if (!Array.isArray(graph.entries) || !Array.isArray(graph.batches)) return data
        try { return JSON.stringify({ ...frame, graph: transformPanes(graph) }) } catch { return data }
    }
    if (frame.type === 'rebuilt' && typeof frame.id === 'string' && PANE_GRAPH_EXCLUDE.has(frame.id)) return undefined
    return data
}

/**
 * Rewrite an SSE body of the official plugin-event channel in place: frames are
 * preserved byte-for-byte unless they are graph snapshots or rebuilds of
 * excluded rows. Cancellation and errors propagate through the stream.
 *
 * The decoder, buffer, and line boundary scanner are per projection instance
 * (one official event stream per pane graph): a stream that pauses mid-frame or
 * mid-UTF-8 sequence must never leak partial state into another pane's stream.
 */
export function filterPluginEventBody(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder()
    const decoder = new TextDecoder()
    let buffer = ''
    return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
            buffer += decoder.decode(chunk, { stream: true })
            for (;;) {
                const boundary = /\r?\n\r?\n/.exec(buffer)
                if (!boundary) break
                const end = boundary.index + boundary[0].length
                const frame = buffer.slice(0, end)
                buffer = buffer.slice(end)
                const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:'))
                    .map(line => line.slice(5).replace(/^ /, '')).join('\n')
                if (data === '') { controller.enqueue(encoder.encode(frame)); continue }
                let next: string | undefined
                try { next = filterPluginEventData(data) } catch { next = data }
                if (next === undefined) continue
                controller.enqueue(encoder.encode(next === data ? frame : `data: ${next}\n\n`))
            }
            // The shared transport caps a frame at 4 MB; keep the same bound while projecting.
            if (buffer.length > 4 * 1024 * 1024) throw new Error('Official plugin event exceeded the transport frame limit')
        },
        flush(controller) {
            buffer += decoder.decode()
            if (buffer !== '') controller.enqueue(encoder.encode(buffer))
        },
    }))
}

/** Wrap a shared plugin-event response with the pane projection. */
export function projectPluginEvents(response: Response): Response {
    if (!response.body) return response
    return new Response(filterPluginEventBody(response.body), {
        status: response.status, statusText: response.statusText, headers: response.headers,
    })
}
