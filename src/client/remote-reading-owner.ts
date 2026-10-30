/** DOM occurrence lookup for gesture callbacks; no canonical Session fallback is permitted. */
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { RemotePaneSession } from './remote-reading-session.ts'
const owners = new WeakMap<HTMLElement, { reference: SessionReference; session: RemotePaneSession }>()
const marker = 'data-hhpi-reading-owner'

export function bindRemoteReadingOwner(root: HTMLElement, reference: SessionReference): () => void {
  const owner = { reference, session: reference.binding.session as RemotePaneSession }
  if (!owner.session.readingView) throw new Error('A gesture owner requires its official reading window.')
  if (owners.has(root)) throw new Error('This element already owns a source reading occurrence.')
  owners.set(root, owner); root.setAttribute(marker, '')
  return () => { if (owners.get(root) === owner) { owners.delete(root); root.removeAttribute(marker) } }
}

export function remoteReadingOwner(element: HTMLElement): RemotePaneSession | undefined {
  const root = element.closest<HTMLElement>(`[${marker}]`) ?? element.querySelector<HTMLElement>(`[${marker}]`)
  const owner = root ? owners.get(root) : undefined
  if (!owner) return undefined
  try { return owner.reference.binding.session === owner.session ? owner.session : undefined }
  catch { return undefined }
}
