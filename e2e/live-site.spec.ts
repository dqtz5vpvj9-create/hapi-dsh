import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import type { HapiCatalog } from '../src/client-api.ts';

const liveFile = process.env.HAPI_DSH_LIVE_URL_FILE;
const sourceSessionId = process.env.HAPI_DSH_LIVE_SOURCE_SESSION_ID;

// Live pages can contain private source content and the admission URL. Keep
// recording off unless the operator explicitly captures an approved artifact.
test.use({ trace: 'off', screenshot: 'off', video: 'off' });

test.skip(liveFile === undefined, 'HAPI_DSH_LIVE_URL_FILE is not configured');

async function openLive(page: Page): Promise<void> {
  if (liveFile === undefined) throw new Error('HAPI_DSH_LIVE_URL_FILE is not configured');
  let launch: URL;
  try { launch = new URL(readFileSync(liveFile, 'utf8').trim()); }
  catch { throw new Error('The configured live login URL could not be read or parsed'); }
  if (!['http:', 'https:'].includes(launch.protocol)) throw new Error('The configured live site must use HTTP or HTTPS');
  // Playwright timeout output must not echo an admission-bearing URL.
  await page.goto(launch.origin, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.evaluate(value => { setTimeout(() => location.replace(value), 0); }, launch.href);
  await expect(page.locator('[data-hapi-workspace]')).toBeVisible({ timeout: 120_000 });
  const notice = page.getByRole('dialog', { name: /^(Preview Notice|预览版说明)$/ });
  // This is an existing Host, whose acknowledgement may already be saved.
  await page.addLocatorHandler(notice, async dialog => { await dialog.getByRole('button', { name: /^(Continue|继续)$/ }).click(); });
}

async function readCatalog(page: Page): Promise<HapiCatalog | undefined> {
  return page.evaluate(async () => {
    const response = await fetch('/api/hapi/catalog', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: `live-${String(Date.now())}`, method: 'hapi/catalog', payload: { args: {} } }),
    });
    const wire = await response.json() as { result?: { ok?: boolean; value?: HapiCatalog } };
    return wire.result?.ok ? wire.result.value : undefined;
  });
}

test('live availability smoke authenticates, loads the official UI, and reaches the source catalog', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await openLive(page);

  const body = await page.locator('body').innerText();
  expect(body).not.toContain('Failed to load plugins');
  // An existing workspace deliberately sets the browser title to its focused
  // conversation. A healthy live page need not retain the initial app title.
  expect(await page.locator('button').count()).toBeGreaterThan(0);
  expect(pageErrors).toEqual([]);

  await expect.poll(async () => {
    const catalog = await readCatalog(page);
    return Boolean(catalog?.connected && catalog.sessions.length && catalog.machines.length && catalog.hosts.some(host => host.online));
  }, { timeout: 120_000 }).toBe(true);
  expect(pageErrors).toEqual([]);
});

test('a configured live source chat shows actual original messages before and after reload', async ({ page }) => {
  test.skip(!sourceSessionId, 'Set HAPI_DSH_LIVE_SOURCE_SESSION_ID to a nonempty original HAPI chat; availability alone is not conversation acceptance');
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await openLive(page);
  let source: HapiCatalog['sessions'][number] | undefined;
  await expect.poll(async () => {
    source = (await readCatalog(page))?.sessions.find(row => row.hapiSessionId === sourceSessionId);
    return Boolean(source);
  }, { timeout: 120_000 }).toBe(true);
  // Only navigate to the already-existing source. No message, resume, approval,
  // file write, shell input or model operation is sent by this test.
  const search = page.locator('.hapi-session-sidebar input[type="search"]');
  if (!(await search.isVisible())) await page.locator('.hapi-session-sidebar').getByRole('button', { name: /^(Search conversations|搜索会话)/ }).click();
  await search.fill(source!.title);
  const escapedId = await page.evaluate(id => CSS.escape(id), source!.id);
  await page.locator(`[data-session-row="${escapedId}"] .hapi-session-open`).click();
  const pane = page.locator(`.hapi-pane[data-session-id="${escapedId}"]:not([aria-hidden="true"])`).first();
  const flow = pane.locator('[data-chat-flow]:not([data-step-process-content])');
  const messages = flow.locator('[data-chat-flow-kind="user"], [data-chat-flow-kind="assistant-step"]').filter({ visible: true });
  for (let pass = 0; pass < 2; pass++) {
    if (pass) await page.reload();
    await expect(messages.first()).toBeVisible({ timeout: 90_000 });
    expect((await flow.innerText()).trim().length).toBeGreaterThan(0);
    expect((await pane.locator('[data-conversation-content]').boundingBox())!.height).toBeGreaterThan(150);
  }
  expect(errors).toEqual([]);
});
