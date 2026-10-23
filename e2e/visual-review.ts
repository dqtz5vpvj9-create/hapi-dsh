import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

/** Fixed webshot command, with the same real app and explicit visual state.
 * This is a review artifact, not an automated judgement of visual quality. */
export async function visualReview(url: string, name: string, viewport: string, ready: string): Promise<string | undefined> {
  if (process.env.HAPI_DSH_VISUAL_REVIEW === 'off') {
    process.stdout.write(`Visual review not performed: ${name} ${viewport} (capture explicitly disabled).\n`)
    return undefined
  }
  const directory = process.env.HAPI_DSH_VISUAL_DIR ?? '/mnt/cache/data-cache/hapi-dsh-visual-review'
  await mkdir(directory, { recursive: true })
  const path = join(directory, `${name}-${viewport}.png`)
  try {
    await promisify(execFile)('webshot', ['--url', url, '--output', path, '--viewport', viewport,
      '--ready-js', ready, '--timeout-ms', '45000', '--quiet'], { timeout: 50_000 })
  } catch {
    // Capture a fresh opening for diagnostics. This separate context does not
    // preserve the failed interaction or make its readiness check pass.
    // Do not log admission URLs.
    await promisify(execFile)('webshot', ['--url', url, '--output', path.replace('.png', '-diagnostic.png'), '--viewport', viewport,
      '--ready-selector', '[data-hapi-workspace]', '--timeout-ms', '20000', '--quiet'], { timeout: 25_000 }).catch(() => {})
    throw new Error(`Visual state ${name} was not ready; inspect ${path.replace('.png', '-diagnostic.png')}`)
  }
  return path
}

/** Reopen the real fixture's saved conversation for a visual checkpoint. */
export function conversationReady(title: string, action = ''): string {
  return `(() => {
    const dialog = document.querySelector('[role="dialog"]');
    if (dialog) [...dialog.querySelectorAll('button')].find(b => /^(Continue|继续)$/.test(b.textContent.trim()))?.click();
    const pane = [...document.querySelectorAll('.hapi-pane')].find(p => p.getAttribute('aria-label') === ${JSON.stringify(`Pane: ${title}`)} && p.getBoundingClientRect().width);
    if (pane && document.querySelector('.hapi-mobile-session-layer')) {
      document.querySelector('.hapi-picker-back')?.click();
      return false;
    }
    if (!pane) {
      document.querySelector('.hapi-mobile-header-picker button')?.click();
      [...document.querySelectorAll('.hapi-session-open, .hapi-discovery-open')].find(b => b.textContent.includes(${JSON.stringify(title)}))?.click();
      return false;
    }
    const port = pane.querySelector('[data-conversation-scroll]');
    if (!port || !pane.querySelector('[data-composer-input]') || !pane.querySelector('[data-chat-node-key]')) return false;
    ${action}
    return true;
  })()`
}
