import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { HapiRequestError } from '../codex/contracts.ts';
import { canonicalJson, nativeSessionId, record } from '../codex/native.ts';
import { writeDurableJson } from '../codex/durable-file.ts';
import type { HapiMachine } from './schemas.ts';
import { sourceMachineHealth } from './source-machines.ts';
import { cliBinaryUpdatedOnDisk } from '../source-runner-capabilities.ts';
import {
    sourceAdminMachineSchema, sourceAdminOperationSchema, sourceAdminReceiptSchema, sourceDshBundlesSchema,
    sourceHubSettingsSchema, sourceStorageSchema, sourceUsageSchema, sourceUsageRequestSchema,
    type SourceAdministration, type SourceAdminAction, type SourceAdminOperation, type SourceAdminReceipt,
    type SourceAdminMachine, type SourceDshBundles, type SourceUsageRequest,
} from '../source-admin-types.ts';

export interface SourceAdminTransport {
    readonly hubId: string;
    readonly isConnected?: boolean;
    listMachines(): Promise<HapiMachine[]>;
    request(path: string, options?: { method?: string; body?: unknown; timeoutMs?: number }): Promise<unknown>;
}
const entrySchema = z.object({ input: sourceAdminOperationSchema, receipt: sourceAdminReceiptSchema, dispatched: z.boolean(), before: sourceAdminMachineSchema.nullable() });
type Entry = z.infer<typeof entrySchema>;
const savedSchema = z.object({ version: z.literal(1), entries: z.array(entrySchema) });
const rejected = (message: string) => new HapiRequestError(message, 'rejected', 409, 'source_admin_unavailable');
const text = (value: unknown) => value instanceof Error ? value.message : 'The original Hub did not confirm this operation';
const pathFor = (machineId: string) => `/api/machines/${encodeURIComponent(machineId)}`;
const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const string = (value: unknown) => typeof value === 'string' ? value : '';

/** Explicit whitelist: runner environment, authentication and arbitrary metadata never leave the Host. */
export function adminMachine(machine: HapiMachine): SourceAdminMachine {
    const metadata = record(machine.metadata), runner = record(machine.runnerState);
    return { id: machine.id, displayName: string(metadata?.displayName), host: string(metadata?.host), platform: string(metadata?.platform),
        version: string(metadata?.happyCliVersion), online: machine.active, lastSeenAt: machine.activeAt, health: sourceMachineHealth(machine.health),
        homeDir: string(metadata?.homeDir) || null, workspaceRoots: Array.isArray(metadata?.workspaceRoots) ? metadata.workspaceRoots.filter((v): v is string => typeof v === 'string') : [],
        capabilities: Array.isArray(metadata?.capabilities) ? metadata.capabilities.filter((v): v is string => typeof v === 'string') : [],
        restartRecommended: cliBinaryUpdatedOnDisk(metadata), supervisedRestart: metadata?.supervisedRestart === true,
        runner: runner ? { status: string(runner.status), pid: finite(runner.pid), startedAt: finite(runner.startedAt) } : null };
}
function overlaps(a: SourceAdminAction, b: SourceAdminAction): boolean {
    if (a.kind !== b.kind) return false;
    if (a.kind === 'settings' && b.kind === 'settings') return Object.keys(a.values).some(key => key in b.values);
    if (a.kind === 'settings' || b.kind === 'settings' || a.machineId !== b.machineId) return false;
    return a.kind !== 'dsh-bundle' || b.kind !== 'dsh-bundle' || a.name === b.name;
}
const pending = (entry: Entry) => entry.receipt.status === 'submitting' || entry.receipt.status === 'indeterminate';

/** Calls existing administration routes; durable receipt recovery never repeats a Runner restart. */
export class SourceAdministrationService {
    private readonly entries = new Map<string, Entry>();
    private readonly flights = new Map<string, Promise<SourceAdminReceipt>>();
    private readonly filename: string;
    constructor(private readonly client: SourceAdminTransport, directory: string) {
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        this.filename = join(directory, `${nativeSessionId(client.hubId, 'administration')}.json`);
        try {
            const saved = savedSchema.parse(JSON.parse(readFileSync(this.filename, 'utf8')));
            for (const entry of saved.entries) {
                if (entry.receipt.hubId !== client.hubId || entry.input.operationId !== entry.receipt.operationId
                    || canonicalJson(entry.input.action) !== canonicalJson(entry.receipt.action)) throw new Error('The administration journal belongs to another immutable operation');
                if (entry.receipt.status === 'submitting') {
                    entry.receipt.status = entry.dispatched ? 'indeterminate' : 'rejected';
                    entry.receipt.message = entry.dispatched ? 'The Host restarted before the source reply. Read this operation; it will not be sent again.' : 'The Host stopped before dispatching this operation.';
                }
                this.entries.set(entry.input.operationId, entry);
            }
        } catch (error) { if (record(error)?.code !== 'ENOENT') throw error; }
    }
    private persist(): void { writeDurableJson(this.filename, { version: 1, entries: [...this.entries.values()] }); }
    private save(entry: Entry): void { entry.receipt.updatedAt = Date.now(); this.persist(); }
    private async machine(id: string): Promise<SourceAdminMachine> {
        const machine = (await this.client.listMachines()).find(value => value.id === id);
        if (!machine) throw rejected('The original Hub no longer lists this machine');
        return adminMachine(machine);
    }
    async overview(): Promise<SourceAdministration> {
        const [machines, settings] = await Promise.allSettled([this.client.listMachines(), this.settings()]);
        if (machines.status === 'rejected') throw machines.reason;
        return { hubId: this.client.hubId, connected: this.client.isConnected !== false, machines: machines.value.map(adminMachine),
            settings: settings.status === 'fulfilled' ? settings.value : null, settingsError: settings.status === 'rejected' ? text(settings.reason) : null,
            operations: [...this.entries.values()].map(entry => structuredClone(entry.receipt)).sort((a, b) => b.createdAt - a.createdAt) };
    }
    private async settings() { return sourceHubSettingsSchema.parse(await this.client.request('/api/hub-settings')); }
    async summarySettings() { const settings = await this.settings(); return { hubId: this.client.hubId, sessionSummaryInChat: settings.sessionSummaryInChat }; }
    async storage() { return sourceStorageSchema.parse(await this.client.request('/api/storage/sqlite')); }
    async usage(input: SourceUsageRequest) {
        const request = sourceUsageRequestSchema.parse(input);
        try { new Intl.DateTimeFormat('en-US', { timeZone: request.timeZone }); } catch { throw rejected('Choose a valid IANA time zone'); }
        return sourceUsageSchema.parse(await this.client.request(`/api/usage/summary?${new URLSearchParams(request)}`));
    }
    async bundles(machineId: string): Promise<SourceDshBundles> {
        await this.machine(machineId);
        return sourceDshBundlesSchema.parse(await this.client.request(`${pathFor(machineId)}/dsh-bundles`));
    }
    operation(input: SourceAdminOperation): Promise<SourceAdminReceipt> {
        const request = sourceAdminOperationSchema.parse(input), existing = this.entries.get(request.operationId);
        if (existing) {
            if (canonicalJson(existing.input) !== canonicalJson(request)) return Promise.reject(rejected('This administration operation ID belongs to different input'));
            return this.read(request.operationId).then(value => { if (!value) throw rejected('The original receipt is unavailable'); return value; });
        }
        const blocking = [...this.entries.values()].find(entry => pending(entry) && overlaps(entry.input.action, request.action));
        if (blocking) return Promise.reject(rejected(`Read unresolved operation ${blocking.input.operationId} before changing the same source setting again`));
        const now = Date.now();
        const entry: Entry = { input: request, dispatched: false, before: null,
            receipt: { operationId: request.operationId, hubId: this.client.hubId, action: request.action, status: 'submitting',
                createdAt: now, updatedAt: now, message: null, settings: null, bundles: null, machine: null } };
        this.entries.set(request.operationId, entry);
        try { this.persist(); } catch (error) { this.entries.delete(request.operationId); return Promise.reject(error); }
        const work = Promise.resolve().then(async () => {
            try { await this.dispatch(entry); }
            catch (error) {
                entry.receipt.status = !entry.dispatched || error instanceof HapiRequestError && error.outcome === 'rejected' ? 'rejected' : 'indeterminate';
                entry.receipt.message = text(error);
            }
            this.save(entry); return structuredClone(entry.receipt);
        });
        this.flights.set(request.operationId, work);
        void work.finally(() => this.flights.delete(request.operationId)).catch(() => {});
        return work;
    }
    private async dispatch(entry: Entry): Promise<void> {
        const action = entry.input.action;
        if (action.kind !== 'settings') {
            entry.before = await this.machine(action.machineId);
            if ((action.kind === 'restart-runner' || action.kind === 'dsh-bundle') && !entry.before.online) throw rejected('This original Runner is offline');
            if (action.kind === 'restart-runner' && !entry.before.supervisedRestart) throw rejected('This Runner has no supervisor configured to relaunch it after stopping');
            if (action.kind === 'dsh-bundle') {
                const state = await this.bundles(action.machineId), bundle = state.available.find(value => value.name === action.name);
                if (!bundle || !bundle.switchable) throw rejected('This Runner does not allow changing that bundle');
            }
        }
        entry.dispatched = true;
        try { this.save(entry); } catch (error) { entry.dispatched = false; throw error; }
        if (action.kind === 'settings') {
            entry.receipt.settings = sourceHubSettingsSchema.parse(await this.client.request('/api/hub-settings', { method: 'PUT', body: action.values }));
            if (!Object.entries(action.values).every(([key, value]) => entry.receipt.settings?.[key as keyof typeof action.values] === value)) throw new HapiRequestError('The original Hub returned different setting values', 'indeterminate');
        }
        else if (action.kind === 'machine-name') {
            z.object({ ok: z.literal(true) }).parse(await this.client.request(pathFor(action.machineId), { method: 'PATCH', body: { displayName: action.displayName } }));
        } else if (action.kind === 'restart-runner') {
            const response = z.object({ message: z.string() }).parse(await this.client.request(`${pathFor(action.machineId)}/restart-runner`, { method: 'POST', body: {}, timeoutMs: 120_000 }));
            entry.receipt.message = response.message;
        } else {
            entry.receipt.bundles = sourceDshBundlesSchema.parse(await this.client.request(`${pathFor(action.machineId)}/dsh-bundles`, { method: 'POST', body: { name: action.name, enabled: action.enabled }, timeoutMs: 120_000 }));
            if (!entry.receipt.bundles.available.some(row => row.name === action.name && row.enabled === action.enabled)) throw new HapiRequestError('The original Runner returned a different bundle state', 'indeterminate');
        }
        entry.receipt.status = 'confirmed';
        if (action.kind !== 'settings') {
            try { entry.receipt.machine = await this.machine(action.machineId); } catch { /* The accepted restart can temporarily disconnect its owner. */ }
        }
    }
    async read(operationId: string): Promise<SourceAdminReceipt | null> {
        const flight = this.flights.get(operationId); if (flight) return flight;
        const entry = this.entries.get(operationId); if (!entry) return null;
        if (entry.receipt.status !== 'indeterminate') return structuredClone(entry.receipt);
        const action = entry.input.action;
        try {
            let observed = false;
            if (action.kind === 'settings') {
                entry.receipt.settings = await this.settings();
                observed = Object.entries(action.values).every(([key, value]) => entry.receipt.settings?.[key as keyof typeof action.values] === value);
            } else {
                const current = await this.machine(action.machineId); entry.receipt.machine = current;
                if (action.kind === 'machine-name') observed = current.displayName === action.displayName;
                else if (action.kind === 'restart-runner') observed = current.online && current.runner?.startedAt != null && entry.before?.runner?.startedAt != null
                    && current.runner.startedAt > entry.before.runner.startedAt;
                else {
                    entry.receipt.bundles = await this.bundles(action.machineId);
                    observed = entry.receipt.bundles.available.some(row => row.name === action.name && row.enabled === action.enabled);
                }
            }
            if (observed) {
                entry.receipt.status = 'observed';
                entry.receipt.message = 'The requested source state is now visible. The original response remains unknown; the operation was not sent again.';
            }
        } catch (error) { entry.receipt.message = `The original result remains unknown: ${text(error)}`; }
        this.save(entry); return structuredClone(entry.receipt);
    }
    async settled(): Promise<void> { await Promise.allSettled([...this.flights.values()]); }
}
