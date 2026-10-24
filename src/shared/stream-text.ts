import { Buffer } from 'node:buffer'

/** A retained stream delta must not keep its entire cumulative source alive.
 * V8 can represent slice() as a view of the parent string; keeping all such
 * deltas then keeps every growing snapshot. Copy only the new UTF-16 units.
 * UTF-8 would replace unpaired surrogates, including a pair split over chunks. */
export function independentStreamDelta(text: string, previousLength: number): string {
  const delta = text.slice(previousLength)
  return delta ? Buffer.from(delta, 'utf16le').toString('utf16le') : ''
}
