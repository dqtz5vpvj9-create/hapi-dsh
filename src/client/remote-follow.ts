/** Resume HHPI updates through the official Connection-owned stream lifecycle. */
import { RemoteStreamCarrierError, type RemoteStreamFactory } from '@deepseek-ai/dsh-api-gateway/client'
import type { SourceChanges, SourceChangesRequest } from '../remote/protocol.ts'

export async function* followSourceChanges(remote: RemoteStreamFactory,
  open: (request: SourceChangesRequest, signal: AbortSignal) => AsyncIterable<SourceChanges>,
  request: SourceChangesRequest, signal?: AbortSignal): AsyncIterable<SourceChanges> {
  let cursor = request
  const stream = remote.$stream<SourceChanges>({
    name: 'HHPI source updates',
    open: generation => open(cursor, generation),
    // This subscription has no successful terminal result. An idle close is
    // a lost carrier, not a failed read of the accepted conversation window.
    ended: () => new RemoteStreamCarrierError('HHPI source updates ended unexpectedly'),
  })
  const stop = (): void => { void stream.dispose() }
  signal?.addEventListener('abort', stop, { once: true })
  try {
    signal?.throwIfAborted()
    for await (const item of stream) {
      signal?.throwIfAborted()
      yield item.value
      // The caller validates and accepts each frame before asking for the
      // next one. Reconnect from that accepted cursor, never the opening one.
      if (item.value.epoch !== cursor.epoch || item.value.version > cursor.version) {
        cursor = { sessionId: request.sessionId, epoch: item.value.epoch, version: item.value.version }
      }
      item.accept()
    }
  } finally {
    signal?.removeEventListener('abort', stop)
    await stream.dispose()
  }
}
