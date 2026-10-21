import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const liveFile = process.env.HAPI_DSH_LIVE_URL_FILE;

test.skip(liveFile === undefined, 'HAPI_DSH_LIVE_URL_FILE is not configured');

test('live hapi-dsh site authenticates, loads the official UI, and reaches the source catalog', async ({ page }) => {
  if (liveFile === undefined) throw new Error('HAPI_DSH_LIVE_URL_FILE is not configured');
  const launch = readFileSync(liveFile, 'utf8').trim();
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));

  await page.goto(launch, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.waitForFunction(() => !document.body.innerText.includes('Loading plugins'), undefined, { timeout: 120_000 });

  const body = await page.locator('body').innerText();
  expect(body).not.toContain('Failed to load plugins');
  expect(await page.title()).toBe('DeepSeek Harness');
  expect(await page.locator('button').count()).toBeGreaterThan(0);
  expect(pageErrors).toEqual([]);

  const wire = await page.evaluate(async () => {
    const response = await fetch('/api/hapi/catalog', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: `live-${String(Date.now())}`,
        method: 'hapi/catalog',
        payload: { args: {} },
      }),
    });
    return response.json() as Promise<{ result?: { ok?: boolean; value?: { connected?: boolean; sessions?: unknown[]; machines?: unknown[]; hosts?: Array<{ id: string; online: boolean }> } } }>;
  });
  expect(wire.result?.ok).toBe(true);
  const catalog = wire.result!.value!;
  expect(catalog.connected).toBe(true);
  expect(catalog.sessions?.length ?? 0).toBeGreaterThan(0);
  expect(catalog.machines?.length ?? 0).toBeGreaterThan(0);
  expect(catalog.hosts?.some(host => host.online)).toBe(true);

  await test.info().attach('live-site', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
});
