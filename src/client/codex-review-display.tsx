import { useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { TurnTailOwnerProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import { sourceReviewDefinition, SOURCE_REVIEW_DATA } from './codex-review-conversation.ts'
import type { SourceReviewFinding } from '../hapi-agent/codex-review.ts'

function location(finding: SourceReviewFinding): string | null {
    if (!finding.filePath) return null
    return `${finding.filePath}${finding.lineStart === null ? '' : `:${finding.lineStart}${finding.lineEnd !== null && finding.lineEnd !== finding.lineStart ? `–${finding.lineEnd}` : ''}`}`
}
const percent = (value: number): string => `${Math.round(value * 100)}%`

/** A source review is a typed annotation of a final message. This additive
 * slot renders findings without replacing official assistant Markdown/Copy
 * or promising an upstream /review execution API that does not exist. */
export function installCodexReviewDisplay(ctx: Context): () => void {
    const Tail = (props: PropsRuntime<'conversation.chat.turnTail'> & TurnTailOwnerProps) => {
        const stream = props.turn.data.source(SOURCE_REVIEW_DATA), records = useSyncExternalStore(stream.subscribe, stream.getSnapshot)
        const language = useSyncExternalStore(listener => ctx.locale.subscribe(listener), () => ctx.locale.getSnapshot().active), zh = language.startsWith('zh')
        if (!records?.length) return null
        return <>{records.map(({ messageId, review }) => <section className="hapi-codex-review" data-hapi-codex-review={messageId}
            aria-label="Codex review" key={messageId}>
            <header><strong>{zh ? 'Codex 审查' : 'Codex review'}</strong>
                {review.overallCorrectness && <span className="hapi-review-badge">{review.overallCorrectness}</span>}
                {review.overallConfidenceScore !== null && <span className="hapi-review-badge">{zh ? '置信度' : 'Confidence'} {percent(review.overallConfidenceScore)}</span>}</header>
            {review.overallExplanation && <p>{review.overallExplanation}</p>}
            <p className="hapi-review-count">{review.findings.length} {zh ? '条发现' : 'findings'}</p>
            {review.findings.length > 0 && <ol>{review.findings.map((finding, index) => {
                const sourceLocation = location(finding)
                return <li key={`${index}:${finding.title}`}>
                    <div className="hapi-review-finding-title">{finding.priority !== null && <span className="hapi-review-badge" data-priority={finding.priority}>P{finding.priority}</span>}<strong>{finding.title}</strong></div>
                    <p>{finding.body}</p><footer>{sourceLocation
                        ? <button type="button" onClick={() => props.openFile(finding.filePath!)} aria-label={`${zh ? '打开源文件' : 'Open source file'} ${sourceLocation}`}>{sourceLocation}</button>
                        : <span>{zh ? '无位置' : 'No location'}</span>}
                        {finding.confidenceScore !== null && <span>{zh ? '置信度' : 'Confidence'} {percent(finding.confidenceScore)}</span>}</footer>
                </li>
            })}</ol>}
        </section>)}</>
    }
    const stopDefinition = ctx.uiConversation.events.register(sourceReviewDefinition)
    const stopSlot = ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
        name: 'conversation.chat.turnTail', id: 'hapi.codex-review', order: 20,
    }, Tail))
    const style = document.createElement('style'); style.textContent = styles; document.head.append(style)
    return () => { stopSlot(); stopDefinition(); style.remove() }
}

const styles = `.hapi-codex-review{margin:8px 0;border:1px solid var(--border-secondary,#8884);border-radius:8px;padding:12px;min-width:0;max-width:100%}.hapi-codex-review>header,.hapi-review-finding-title{display:flex;flex-wrap:wrap;align-items:start;gap:8px}.hapi-codex-review>header>strong{flex:1;font-size:14px}.hapi-review-badge{font-size:11px;border:1px solid var(--border-secondary,#8884);border-radius:4px;padding:2px 6px;white-space:nowrap}.hapi-review-badge[data-priority="0"],.hapi-review-badge[data-priority="1"]{color:var(--text-danger,#c44)}.hapi-review-badge[data-priority="2"]{color:var(--text-warning,#b80)}.hapi-codex-review p{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;line-height:1.5;margin:8px 0}.hapi-review-count,.hapi-codex-review footer{color:var(--text-secondary,#888);font-size:12px}.hapi-codex-review ol{list-style:none;padding:0;margin:0;display:grid;gap:8px}.hapi-codex-review li{padding:10px;border:1px solid var(--border-secondary,#8884);border-radius:6px}.hapi-review-finding-title strong{font-size:13px;min-width:0;overflow-wrap:anywhere}.hapi-codex-review footer{display:flex;flex-wrap:wrap;gap:12px}.hapi-codex-review footer button{padding:0;min-width:0;border:0;background:transparent;color:inherit;text-decoration:underline;overflow-wrap:anywhere;text-align:left;cursor:pointer}`
