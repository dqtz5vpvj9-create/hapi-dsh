import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { HapiRequestError } from '../codex/contracts.ts';
import { assertBinding, canonicalJson, nativeSessionId, record } from '../codex/native.ts';
import { writeDurableJson } from '../codex/durable-file.ts';
import { nativeThreadGoalSchema } from '../codex/observation-types.ts';
import {
    nativeAccountSchema, nativeConnectSchema, nativeDeviceLoginSchema, nativeHomeSchema, nativeImportSchema,
    nativeLibraryEntrySchema, nativeLibraryQuerySchema, nativeMachineOperationSchema, nativeOperationReceiptSchema,
    nativeSourceOperationSchema,
    sourceReadStatesSchema, sourceReadStateSchema, sourceReadStateWriteSchema, type SourceReadState, type SourceReadStateWrite,
    type NativeConnect, type NativeDeviceLogin, type NativeImport, type NativeLibrary as LibraryPage, type NativeLibraryQuery,
    type NativeMachineOperation, type NativeMachineState, type NativeOperationReceipt, type NativeSessionTools, type NativeSourceOperation,
} from '../native-library-types.ts';
import type { NativeControlAgent, NativeControlTransport } from './native-control.ts';

export interface NativeLibraryAgent extends NativeControlAgent {
    resolveRewindLocalId(messageId: string): string | undefined;
    resolveRewindLocalIdAtSeq(seq: number): string | undefined;
}
export interface NativeLibrarySessions {
    get(id: string): NativeLibraryAgent | undefined;
    /** Resolve a display seq, including a paged historical row. */
    resolveRewind?(sessionId: string, seq: number): string | undefined;
    resolveRewindMessage?(sessionId: string, messageId: string): string | undefined;
    reconcileSource(sourceId: string): Promise<NativeLibraryAgent | undefined>;
    refreshCatalog(): Promise<void>;
}
const entrySchema = z.object({ input: z.json(), receipt: nativeOperationReceiptSchema });
type JournalEntry = z.infer<typeof entrySchema>;
const journalSchema = z.object({ version: z.literal(1), entries: z.array(entrySchema) });
const publicSuccess = z.object({ success: z.boolean(), error: z.string().optional() });
const accountResponse = publicSuccess.extend({ account: nativeAccountSchema.optional(), applied: z.boolean().optional(), persisted: z.boolean().optional() });
const homesResponse = publicSuccess.extend({ homes: z.array(nativeHomeSchema).optional() });
const accountsResponse = publicSuccess.extend({ accounts: z.array(nativeAccountSchema).optional(), currentAccountId: z.string().nullable().optional() });
const loginResponse = publicSuccess.extend({ login: nativeDeviceLoginSchema.optional() });
const sessionIdResponse = z.object({ sessionId: z.string().min(1) });
const sourcePath = (id: string): string => `/api/sessions/${encodeURIComponent(id)}`;
const machinePath = (id: string): string => `/api/machines/${encodeURIComponent(id)}`;
const errorText = (error: unknown): string => error instanceof Error ? error.message : 'The original owner did not confirm the operation';
const json = (value: unknown): z.infer<ReturnType<typeof z.json>> => z.json().parse(JSON.parse(JSON.stringify(value)));

/**
 * Existing native threads, accounts and lifecycle remain owned by the original HAPI Runner.
 * Persist submission identity before each side effect. Re-reading a receipt never resubmits it.
 */
export class NativeLibrary {
    private readonly filename: string;
    private readonly entries = new Map<string, JournalEntry>();
    private readonly flights = new Map<string, Promise<NativeOperationReceipt>>();

    constructor(private readonly client: NativeControlTransport, private readonly sessions: NativeLibrarySessions, directory: string) {
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        this.filename = join(directory, `${nativeSessionId(client.hubId, 'native-library')}.json`);
        try {
            const journal = journalSchema.parse(JSON.parse(readFileSync(this.filename, 'utf8')));
            for (const entry of journal.entries) {
                if (entry.receipt.status === 'submitting') entry.receipt = { ...entry.receipt, status: 'indeterminate',
                    message: 'The observer restarted before the original owner response was recorded. Inspect source state before another submission.' };
                this.entries.set(entry.receipt.operationId, entry);
            }
        } catch (error) { if (record(error)?.code !== 'ENOENT') throw error; }
    }

    private agent(id: string): NativeLibraryAgent {
        const agent = this.sessions.get(id);
        if (!agent || agent.binding.hubId !== this.client.hubId) throw new HapiRequestError('This native session is unavailable on the connected Hub', 'rejected', 404);
        assertBinding(agent.binding, agent.sourceSession);
        return agent;
    }
    private requireSuccess<T extends { success: boolean; error?: string | undefined }>(result: T): T {
        if (!result.success) throw new HapiRequestError(result.error ?? 'The original owner rejected this operation', 'rejected', 400);
        return result;
    }
    private persist(): void { writeDurableJson(this.filename, { version: 1, entries: [...this.entries.values()] }); }
    private receipts(scope: string, binding?: NativeLibraryAgent['binding']): NativeOperationReceipt[] {
        return structuredClone([...this.entries.values()].filter(entry => entry.receipt.scope === scope
            && (!binding || canonicalJson(record(entry.input)?.binding) === canonicalJson(binding)))
            .map(entry => entry.receipt).sort((left, right) => right.createdAt - left.createdAt).slice(0, 100));
    }
    operation(operationId: string): NativeOperationReceipt {
        const entry = this.entries.get(operationId);
        if (!entry) throw new HapiRequestError('Native operation receipt not found', 'rejected', 404);
        return structuredClone(entry.receipt);
    }
    private async execute(operationId: string, scope: string, action: string, input: unknown, run: () => Promise<unknown>): Promise<NativeOperationReceipt> {
        const intent = json(input);
        const previous = this.entries.get(operationId);
        if (previous) {
            if (previous.receipt.scope !== scope || previous.receipt.action !== action || canonicalJson(previous.input) !== canonicalJson(intent)) {
                throw new HapiRequestError('An operation identity cannot be reused for different native input', 'rejected');
            }
            return this.flights.get(operationId) ?? structuredClone(previous.receipt);
        }
        const entry: JournalEntry = { input: intent, receipt: { operationId, scope, action, status: 'submitting',
            createdAt: Date.now(), updatedAt: Date.now(), message: null, result: null } };
        this.entries.set(operationId, entry);
        try { this.persist(); } catch (error) { this.entries.delete(operationId); throw error; }
        const work = (async () => {
            try {
                entry.receipt = { ...entry.receipt, status: 'confirmed', result: json(await run()), updatedAt: Date.now(), message: null };
            } catch (error) {
                // Source 409/5xx may occur after native dispatch. They are never a no-dispatch proof.
                const rejected = error instanceof HapiRequestError && error.outcome === 'rejected'
                    && [400, 403, 404, 422].includes(error.status ?? 0);
                entry.receipt = { ...entry.receipt, status: rejected ? 'rejected' : 'indeterminate', updatedAt: Date.now(), message: errorText(error) };
            }
            this.persist();
            return structuredClone(entry.receipt);
        })();
        this.flights.set(operationId, work);
        try { return await work; } finally { this.flights.delete(operationId); }
    }

    async library(input: NativeLibraryQuery): Promise<LibraryPage> {
        const request = nativeLibraryQuerySchema.parse(input);
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(request)) if (value !== undefined && value !== '') params.set(key, String(value));
        const value = publicSuccess.extend({ sessions: z.array(nativeLibraryEntrySchema).default([]),
            machineId: z.string().optional(), nextCursor: z.number().int().nonnegative().nullable().optional(),
        }).parse(await this.client.request(`/api/codex/sessions${params.size ? `?${params}` : ''}`, { timeoutMs: 45_000 }));
        this.requireSuccess(value);
        if (request.machineId && value.machineId && request.machineId !== value.machineId) throw new HapiRequestError('The thread catalog came from another machine', 'indeterminate');
        return { sessions: value.sessions, machineId: value.machineId ?? request.machineId ?? null, nextCursor: value.nextCursor ?? null };
    }

    async connect(input: NativeConnect): Promise<NativeOperationReceipt> {
        const request = nativeConnectSchema.parse(input);
        return this.execute(request.operationId, `machine:${request.machineId ?? 'hub'}`, 'connect', request, async () => {
            const value = z.object({ sessionId: z.string().min(1), threadId: z.string().min(1), connectionState: z.enum(['attached', 'history']) })
                .parse(await this.client.request('/api/codex/connect-session', { method: 'POST',
                    body: { threadId: request.threadId, ...(request.machineId ? { machineId: request.machineId } : {}) }, timeoutMs: 75_000 }));
            if (value.threadId !== request.threadId) throw new HapiRequestError('The owner returned a different native thread', 'indeterminate');
            let display: NativeLibraryAgent | undefined;
            try { display = await this.sessions.reconcileSource(value.sessionId); } catch { /* Native success survives a temporary display synchronization error. */ }
            if (display && (display.binding.threadId !== value.threadId || request.machineId && display.binding.machineId !== request.machineId)) {
                throw new HapiRequestError('The imported display identity does not match the source machine and thread', 'indeterminate');
            }
            return { sourceSessionId: value.sessionId, sessionId: display?.id ?? null, threadId: value.threadId, connectionState: value.connectionState };
        });
    }

    async import(input: NativeImport): Promise<NativeOperationReceipt> {
        const request = nativeImportSchema.parse(input);
        return this.execute(request.operationId, `machine:${request.machineId ?? 'hub'}`, 'import', request, async () => {
            const value = publicSuccess.extend({ message: z.string().optional(), syncedCount: z.number().optional(),
                sessionIds: z.array(z.string()).optional(), hapiSessionIds: z.array(z.string()).optional(),
            }).parse(await this.client.request('/api/codex/sync-session', { method: 'POST', body: { sessionIds: request.threadIds,
                ...(request.machineId ? { machineId: request.machineId } : {}), ...(request.cwd ? { cwd: request.cwd } : {}) }, timeoutMs: 180_000 }));
            this.requireSuccess(value);
            try { await this.sessions.refreshCatalog(); } catch { /* Source import is already committed. */ }
            return value;
        });
    }

    async sessionTools(sessionId: string): Promise<NativeSessionTools> {
        const agent = this.agent(sessionId);
        await agent.refresh();
        const source = agent.sourceSession;
        const capabilities = record(source.metadata?.capabilities);
        const history = record(capabilities?.conversationHistory);
        const goal = nativeThreadGoalSchema.safeParse(source.agentState?.threadGoal);
        const pin = source.globalPinned ? 'global' : source.pinned ? 'project' : 'none';
        return { sessionId: agent.id, sourceSessionId: agent.binding.hapiSessionId, active: source.active, readOnly: agent.projection.readOnly,
            canRewind: history?.rewindToMessage === true && !source.thinking && !agent.projection.readOnly,
            canClear: capabilities?.concurrentClients === true,
            goal: goal.success && goal.data.threadId === agent.binding.threadId ? goal.data : null,
            summary: source.metadata?.summary?.text ?? '', pinMode: pin,
            operations: this.receipts(`session:${agent.binding.hapiSessionId}`, agent.binding) };
    }

    async sourceOperation(input: NativeSourceOperation): Promise<NativeOperationReceipt> {
        const request = nativeSourceOperationSchema.parse(input);
        const agent = this.agent(request.sessionId);
        if (agent.id !== request.sessionId) throw new HapiRequestError('This display was replaced; refresh before changing its original conversation', 'rejected', 409);
        const sourceId = agent.binding.hapiSessionId;
        const path = sourcePath(sourceId);
        // Store the authoritative binding so a display rotation cannot reuse an old operation on a new native thread.
        const intent = { action: request.action, binding: agent.binding };
        let rewindLocalId: string | undefined;
        if (request.action.kind === 'rewind') {
            const displaySeq = request.action.displayMessageSeq;
            rewindLocalId = request.action.displayMessageId === undefined
                ? this.sessions.resolveRewind?.(agent.id, displaySeq!) ?? agent.resolveRewindLocalIdAtSeq(displaySeq!)
                : this.sessions.resolveRewindMessage?.(agent.id, request.action.displayMessageId) ?? agent.resolveRewindLocalId(request.action.displayMessageId);
            if (!rewindLocalId) throw new HapiRequestError('Only a committed native user message can be a rewind boundary', 'rejected', 400);
        }
        return this.execute(request.operationId, `session:${sourceId}`, request.action.kind, intent, async () => {
            await agent.refresh();
            assertBinding(agent.binding, agent.sourceSession);
            const action = request.action;
            if ((action.kind === 'goal' || action.kind === 'rewind') && agent.projection.readOnly) {
                throw new HapiRequestError('Reconnect the original native owner before changing this conversation', 'rejected', 400);
            }
            let result: unknown;
            if (action.kind === 'goal') {
                const value = z.object({ goal: nativeThreadGoalSchema.nullable() }).parse(await this.client.request(`${path}/codex/goal`,
                    { method: 'POST', body: action.command, timeoutMs: 75_000 }));
                if (value.goal && value.goal.threadId !== agent.binding.threadId) throw new HapiRequestError('The goal belongs to a different native thread', 'indeterminate');
                result = value;
            } else if (action.kind === 'rewind') {
                if (record(record(agent.sourceSession.metadata?.capabilities)?.conversationHistory)?.rewindToMessage !== true || agent.sourceSession.thinking) {
                    throw new HapiRequestError('The native owner does not permit rewind while this session is running', 'rejected', 400);
                }
                result = z.object({ success: z.literal(true) }).parse(await this.client.request(`${path}/rewind`,
                    { method: 'POST', body: { messageLocalId: rewindLocalId }, timeoutMs: 120_000 }));
            } else if (action.kind === 'pin') {
                result = z.object({ ok: z.literal(true) }).parse(await this.client.request(`${path}/pin`, { method: 'PUT', body: { mode: action.mode } }));
            } else if (action.kind === 'summary') {
                result = z.object({ ok: z.literal(true) }).parse(await this.client.request(`${path}/summary`, { method: 'PATCH', body: { text: action.text } }));
            } else if (action.kind === 'switch-account') {
                result = this.requireSuccess(accountResponse.parse(await this.client.request(`${path}/codex-account`,
                    { method: 'POST', body: { accountId: action.accountId }, timeoutMs: 90_000 })));
            } else if (action.kind === 'delete') {
                result = z.object({ ok: z.literal(true) }).parse(await this.client.request(path, { method: 'DELETE' }));
            } else {
                result = await this.client.request(`${path}/${action.kind}`, { method: 'POST', body: {}, timeoutMs: 120_000 });
                if (action.kind === 'clear' || action.kind === 'reopen' || action.kind === 'resume') {
                    const value = sessionIdResponse.parse(result);
                    let display: NativeLibraryAgent | undefined;
                    try { display = await this.sessions.reconcileSource(value.sessionId); } catch { /* Confirmed source transition, display may settle later. */ }
                    result = { sourceSessionId: value.sessionId, sessionId: display?.id ?? null };
                } else result = z.object({ ok: z.literal(true), alreadyArchived: z.boolean().optional() }).parse(result);
            }
            if (action.kind !== 'delete' && action.kind !== 'clear' && action.kind !== 'reopen' && action.kind !== 'resume') {
                try {
                    const display = await this.sessions.reconcileSource(sourceId);
                    if (action.kind === 'rewind') result = { ...record(result), sourceSessionId: sourceId, sessionId: display?.id ?? null };
                } catch { /* Do not reinterpret a confirmed mutation as a failed request. */ }
            }
            return result ?? { ok: true };
        });
    }

    async machineState(machineId: string): Promise<NativeMachineState> {
        const path = machinePath(machineId);
        const results = await Promise.allSettled([
            this.client.request(`${path}/codex-homes`).then(value => this.requireSuccess(homesResponse.parse(value))),
            this.client.request(`${path}/codex-accounts`).then(value => this.requireSuccess(accountsResponse.parse(value))),
        ]);
        const homes = results[0]!; const accounts = results[1]!;
        return { machineId,
            homes: homes.status === 'fulfilled' && 'homes' in homes.value ? homes.value.homes ?? [] : [],
            accounts: accounts.status === 'fulfilled' && 'accounts' in accounts.value ? accounts.value.accounts ?? [] : [],
            currentAccountId: accounts.status === 'fulfilled' && 'currentAccountId' in accounts.value ? accounts.value.currentAccountId ?? null : null,
            warnings: results.flatMap(result => result.status === 'rejected' ? [errorText(result.reason)] : []),
            operations: this.receipts(`machine:${machineId}`) };
    }

    async readStates(): Promise<Record<string, SourceReadState>> {
        return z.object({ readStates: sourceReadStatesSchema }).parse(await this.client.request('/api/sessions')).readStates;
    }
    async writeReadState(input: SourceReadStateWrite): Promise<{ applied: boolean; state: SourceReadState }> {
        const request = sourceReadStateWriteSchema.parse(input);
        return z.object({ applied: z.boolean(), state: sourceReadStateSchema }).parse(await this.client.request(`${sourcePath(request.sourceSessionId)}/read-state`, {
            method: 'PUT', body: { expectedVersion: request.expectedVersion, seenAt: request.seenAt, manualUnreadAt: request.manualUnreadAt },
        }));
    }

    async machineOperation(input: NativeMachineOperation): Promise<NativeOperationReceipt> {
        const request = nativeMachineOperationSchema.parse(input);
        const path = machinePath(request.machineId);
        return this.execute(request.operationId, `machine:${request.machineId}`, request.action.kind, request.action, async () => {
            const action = request.action;
            if (action.kind === 'save-home') {
                return this.requireSuccess(homesResponse.parse(await this.client.request(`${path}/codex-homes`, { method: 'POST',
                    body: { label: action.label, path: action.path, ...(action.id ? { id: action.id } : {}) } })));
            }
            if (action.kind === 'delete-home') return this.requireSuccess(homesResponse.parse(await this.client.request(`${path}/codex-homes/${encodeURIComponent(action.id)}`, { method: 'DELETE' })));
            if (action.kind === 'device-login') return this.requireSuccess(loginResponse.parse(await this.client.request(`${path}/codex-device-login`, {
                method: 'POST', body: { action: action.action, ...(action.id ? { id: action.id } : {}), ...(action.label ? { label: action.label } : {}) }, timeoutMs: 75_000,
            })));
            if (action.kind === 'import-account') return this.requireSuccess(accountResponse.parse(await this.client.request(`${path}/codex-accounts/import-current`,
                { method: 'POST', body: action.label ? { label: action.label } : {} })));
            if (action.kind === 'rename-account') return this.requireSuccess(accountResponse.parse(await this.client.request(`${path}/codex-accounts/${encodeURIComponent(action.id)}`,
                { method: 'PATCH', body: { label: action.label } })));
            if (action.kind === 'delete-account') return this.requireSuccess(publicSuccess.parse(await this.client.request(`${path}/codex-accounts/${encodeURIComponent(action.id)}`, { method: 'DELETE' })));
            return this.requireSuccess(accountResponse.parse(await this.client.request(`${path}/codex-account`, { method: 'POST', body: { accountId: action.id }, timeoutMs: 90_000 })));
        });
    }

    async deviceLogin(machineId: string, loginId: string): Promise<NativeDeviceLogin> {
        const value = this.requireSuccess(loginResponse.parse(await this.client.request(`${machinePath(machineId)}/codex-device-login`,
            { method: 'POST', body: { action: 'get', id: loginId } })));
        if (!value.login || value.login.id !== loginId) throw new HapiRequestError('The source device login identity changed', 'indeterminate');
        return value.login;
    }
    async settled(): Promise<void> { await Promise.allSettled([...this.flights.values()]); }
}
