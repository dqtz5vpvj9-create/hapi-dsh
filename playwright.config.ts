import { defineConfig } from '@playwright/test';
export default defineConfig({
    testDir: './e2e', testMatch: '**/*.spec.ts', fullyParallel: false,
    // One environment per spec file is heavy; pass HAPI_DSH_E2E_WORKERS for local
    // parallel validation after the profile template cache is warm.
    workers: Number(process.env.HAPI_DSH_E2E_WORKERS ?? 1),
    timeout: 120_000, expect: { timeout: 20_000 }, reporter: 'list',
    use: { browserName: 'chromium', viewport: { width: 1536, height: 1000 }, locale: 'en-US',
        launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {},
        actionTimeout: 20_000, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
