import type { HapiMessage, HapiTransport } from './contracts.js'
import { compareNativeMessages } from './native.js'

/**
 * Read native history through HAPI's epoch-aware bounded page contract. A
 * changing epoch restarts the read; no mixed-epoch snapshot is published.
 */
export async function readNativeHistory(transport: HapiTransport, sessionId: string): Promise<HapiMessage[]> {
  for (let attempt = 0; attempt < 4; attempt++) {
    let page = await transport.readMessages(sessionId, { limit: 200, bounded: true })
    const epoch = page.page.epoch
    const rows: HapiMessage[] = [...page.messages]
    const cursors = new Set<string>()
    let restart = false
    while (page.page.hasMore) {
      const at = page.page.nextBeforeAt
      const seq = page.page.nextBeforeSeq
      if (at === null || seq === null) throw new Error('HAPI history advertised an incomplete page without a before cursor')
      const key = `${at}:${seq}`
      if (cursors.has(key)) throw new Error('HAPI history returned a repeated before cursor')
      cursors.add(key)
      page = await transport.readMessages(sessionId, { limit: 200, beforeAt: at, beforeSeq: seq, epoch, bounded: true })
      if (page.page.reset || page.page.epoch !== epoch) { restart = true; break }
      rows.push(...page.messages)
    }
    if (!restart) return rows.sort(compareNativeMessages)
  }
  throw new Error('Native history changed repeatedly during pagination; refresh when the source snapshot is available')
}
