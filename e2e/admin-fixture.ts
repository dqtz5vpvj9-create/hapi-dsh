/** Explicit HAPI administration wire fixture. No real database or Runner is changed. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HapiWireFixture } from './hapi-fixture.ts';
import type { HapiMachine } from '../src/hapi/schemas.ts';
import type { SourceDshBundles, SourceHubSettings } from '../src/source-admin-types.ts';

export class AdminWireFixture {
    settings: SourceHubSettings = { sessionSummaryContract: false, sessionSummaryInChat: false };
    readonly machines: HapiMachine[] = ['alpha', 'beta'].map(key => ({
        id: `machine-${key}`, active: true, activeAt: Date.now(), metadata: { host: key === 'alpha' ? 'Laptop' : 'Linux workstation',
            platform: 'linux', happyCliVersion: 'fixture-1.0', supervisedRestart: key === 'alpha',
            startedCliMtimeMs: 10, installedCliMtimeMs: 20, privateEnvironment: { TOKEN: 'fixture-never-expose' } },
        runnerState: { status: 'running', pid: key === 'alpha' ? 101 : 201, startedAt: 1_760_000_000_000 },
    }));
    readonly mutations: Array<{ path: string; body: unknown }> = [];
    readonly usageQueries: Array<{ range: string | null; timeZone: string | null }> = [];
    readonly bundles = new Map<string, SourceDshBundles>(this.machines.map(machine => [machine.id, {
        profile: 'source-profile', dshHome: '/fixture/source-dsh', bundles: ['foundation'], restartRequired: false,
        available: [{ name: 'foundation', description: 'Required source layer', enabled: true, switchable: false },
            { name: 'source-tools', description: 'Optional original Runner tools', enabled: false, switchable: true }],
    }]));
    dropNextRestartReply = false;
    backups = 0;
    readonly backupBytes = Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(128 * 1024, 7)]);
    handle(hapi: HapiWireFixture, url: URL, request: IncomingMessage, response: ServerResponse, body: Record<string, unknown>): boolean {
        const send = (value: unknown, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
        const path = url.pathname;
        if (path === '/api/machines' && request.method === 'GET') { send({ machines: this.machines }); return true; }
        if (path === '/api/hub-settings') {
            if (request.method === 'PUT') { this.mutations.push({ path, body }); Object.assign(this.settings, body); }
            send(this.settings); return true;
        }
        if (path === '/api/storage/sqlite') { send({ path: '/fixture/hapi.db', databaseBytes: 1_048_576, walBytes: 262_144, shmBytes: 32_768, totalBytes: 1_343_488 }); return true; }
        if (path === '/api/storage/sqlite/backup' && request.method === 'POST') {
            this.backups++; response.writeHead(200, { 'Content-Type': 'application/vnd.sqlite3', 'Content-Disposition': 'attachment; filename="fixture.db"' });
            response.write(this.backupBytes.subarray(0, 64 * 1024)); response.end(this.backupBytes.subarray(64 * 1024)); return true;
        }
        if (path === '/api/usage/summary') {
            this.usageQueries.push({ range: url.searchParams.get('range'), timeZone: url.searchParams.get('timeZone') });
            const metrics = { inputTokens: 1000, outputTokens: 400, cacheReadTokens: 600, cacheCreationTokens: 200, totalTokens: 1400, uncachedTokens: 800, requests: 3 };
            send({ range: { from: 1, to: Date.now() }, totals: { ...metrics, sessions: 2 }, daily: [{ key: '2026-10-20', ...metrics }],
                byAgent: [{ key: 'codex', ...metrics }], byModel: [{ key: 'fixture-model', ...metrics }], updatedAt: Date.now() }); return true;
        }
        const match = /^\/api\/machines\/([^/]+)(?:\/(restart-runner|dsh-bundles))?$/.exec(path);
        if (!match || request.method === 'GET' && !match[2]) return false;
        const machine = this.machines.find(row => row.id === decodeURIComponent(match[1]!)); if (!machine) { send({ error: 'not found' }, 404); return true; }
        if (match[2] === 'dsh-bundles') {
            const state = this.bundles.get(machine.id)!;
            if (request.method === 'POST') {
                this.mutations.push({ path, body }); const bundle = state.available.find(row => row.name === body.name);
                if (!bundle?.switchable) { send({ error: 'Required foundation' }, 400); return true; }
                bundle.enabled = body.enabled === true; state.bundles = state.available.filter(row => row.enabled).map(row => row.name); state.restartRequired = true;
            }
            send(state); return true;
        }
        if (request.method === 'PATCH') {
            this.mutations.push({ path, body }); machine.metadata!.displayName = String(body.displayName);
            hapi.emit({ type: 'machine-updated', machineId: machine.id }); send({ ok: true }); return true;
        }
        if (match[2] === 'restart-runner' && request.method === 'POST') {
            this.mutations.push({ path, body });
            if (machine.metadata!.supervisedRestart !== true) { send({ error: 'Restart requires a supervised Runner' }, 502); return true; }
            machine.runnerState = { status: 'running', pid: 102, startedAt: Date.now() };
            hapi.emit({ type: 'machine-updated', machineId: machine.id });
            if (this.dropNextRestartReply) { this.dropNextRestartReply = false; response.destroy(); } else send({ message: 'Runner stop requested; supervisor will relaunch' });
            return true;
        }
        return false;
    }
}
