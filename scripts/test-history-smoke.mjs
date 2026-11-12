#!/usr/bin/env node
/** The release history entry point uses the current native HHPI reader. */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { main } from './test-hhpi-smoke.mjs';
if (!process.argv.includes('--help') && !process.argv.includes('--session-id')) {
    const target = process.env.HHPI_SMOKE_SESSION_ID ?? (await readFile(join(homedir(), '.config/hapi-dsh/smoke-session-id'), 'utf8').catch(() => '')).trim();
    if (target) process.argv.push('--session-id', target);
}
await main();
