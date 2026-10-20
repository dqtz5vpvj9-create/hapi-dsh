import { defineConfig } from '@playwright/test';
export default defineConfig({
    testDir: './e2e', testMatch: '**/*.spec.ts', fullyParallel: false, workers: 1,
    timeout: 120_000, expect: { timeout: 20_000 }, reporter: 'list',
    use: { browserName: 'chromium', viewport: { width: 1536, height: 1000 }, locale: 'en-US',
        actionTimeout: 20_000, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
