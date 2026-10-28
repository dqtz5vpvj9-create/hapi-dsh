/** Real HTTP/Socket.IO carrier with simulated source files and PTYs; no shell is executed. */
import { createHash } from 'node:crypto';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { posix } from 'node:path';
import { Server as SocketServer, type Socket } from 'socket.io';
import type { HapiSession } from '../../src/codex/contracts.ts';
import { LegacyTerminalWireFixture } from './legacy-terminal-fixture.ts';

// Fixture protocol deliberately stands alone from the provider implementation.
type Dimensions = { cols: number; rows: number };
type MachineTerminalInfo = Dimensions & { terminalId: string; title: string; cwd: string; pid: number | null; createdAt: number; endedAt: number | null;
    status: 'starting' | 'running' | 'closing' | 'exited' | 'lost'; exitCode: number | null; seq: number; controllerId: string | null; controlVersion: number };
type MachineTerminalCommand = { type: 'list' }
    | ({ type: 'create'; terminalId: string; cwd: string; title: string } & Dimensions)
    | { type: 'attach'; terminalId: string; afterSeq?: number }
    | { type: 'detach' | 'terminate'; terminalId: string }
    | { type: 'claim'; terminalId: string; controllerId: string; takeover: boolean }
    | { type: 'release'; terminalId: string; controllerId: string; controlVersion: number }
    | { type: 'input'; terminalId: string; controllerId: string; controlVersion: number; data: string }
    | ({ type: 'resize'; terminalId: string; controllerId: string; controlVersion: number } & Dimensions)
    | { type: 'rename'; terminalId: string; title: string };
type MachineTerminalEvent = { type: 'output'; terminalId: string; seq: number; data: string }
    | { type: 'state'; terminal: MachineTerminalInfo }
    | { type: 'disconnected'; error: string };

type FileEntry = { bytes: Buffer; modified: number; mediaType?: string };
type Terminal = { machineId: string; info: MachineTerminalInfo; screen: string };
type Viewer = { socket: Socket; subscriptions: Set<string>; controllers: Set<string> };
const key = (machineId: string, terminalId: string): string => `${machineId}\0${terminalId}`;
const revision = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export class WorkbenchWireFixture {
    readonly legacy: LegacyTerminalWireFixture;
    readonly files = new Map<string, Map<string, FileEntry>>();
    /** Source machine browse roots are independent of a chat's mutable cwd. */
    readonly browseRoots = new Map<string, readonly string[]>();
    readonly directories = new Map<string, Map<string, number>>();
    readonly fileWrites: Array<{ sessionId: string; machineId: string; route: string; body: Record<string, unknown> }> = [];
    loseNextSaveAcknowledgement = false;
    loseNextMutationAcknowledgement = false;
    private readonly originals = new Map<string, Map<string, Buffer>>();
    readonly fileRequests: Array<{ sessionId: string; machineId: string; method: string; route: string; path: string }> = [];
    readonly terminalCommands: Array<{ machineId: string; command: MachineTerminalCommand }> = [];
    readonly terminals = new Map<string, Terminal>();
    readonly terminalInputs: Array<{ machineId: string; terminalId: string; data: string }> = [];
    private readonly viewers = new Set<Viewer>();
    private readonly io: SocketServer;
    private nextPid = 8000;
    private modified = 1;

    constructor(server: Server, private readonly sessions: () => HapiSession[], jwt: string) {
        this.legacy = new LegacyTerminalWireFixture(sessions);
        this.io = new SocketServer(server, { path: '/socket.io/', transports: ['websocket'], serveClient: false });
        this.io.of('/terminal').use((socket, next) => next(socket.handshake.auth.token === jwt ? undefined : new Error('Fixture authentication failed')));
        this.io.of('/terminal').on('connection', socket => {
            this.legacy.attach(socket);
            const viewer: Viewer = { socket, subscriptions: new Set(), controllers: new Set() };
            this.viewers.add(viewer);
            socket.on('machine-terminal:request', (request: { machineId: string; command: MachineTerminalCommand }, ack: (value: unknown) => void) => {
                try { ack({ ok: true, value: this.request(viewer, request.machineId, request.command) }); }
                catch (error) { ack({ ok: false, error: error instanceof Error ? error.message : 'Fixture command failed' }); }
            });
            socket.on('disconnect', () => {
                this.viewers.delete(viewer);
                for (const terminal of this.terminals.values()) {
                    if (!terminal.info.controllerId || !viewer.controllers.has(terminal.info.controllerId)) continue;
                    terminal.info.controllerId = null; terminal.info.controlVersion++;
                    this.publish(terminal.machineId, { type: 'state', terminal: terminal.info });
                }
            });
        });
    }

    seed(session: HapiSession): void {
        const root = session.metadata!.path;
        this.files.set(session.id, new Map([
            [`${root}/source.txt`, { bytes: Buffer.from(`Source file from ${session.metadata!.machineId}\nWorkspace ${root}\n`), modified: this.modified++ }],
            [`${root}/src/nested.txt`, { bytes: Buffer.from(`Nested source from ${session.metadata!.machineId}\n`), modified: this.modified++ }],
        ]));
        this.directories.set(session.id, new Map([[root, this.modified++], [`${root}/src`, this.modified++]]));
        this.originals.set(session.id, new Map([...this.files.get(session.id)!].map(([path, entry]) => [path, Buffer.from(entry.bytes)])));
    }

    updateFile(sessionId: string, path: string, content: string | Uint8Array, mediaType?: string): void {
        const files = this.files.get(sessionId);
        if (!files) throw new Error('Missing fixture source');
        files.set(path, { bytes: typeof content === 'string' ? Buffer.from(content) : Buffer.from(content), modified: this.modified++, ...(mediaType ? { mediaType } : {}) });
    }

    /** Simulated PTY output over the real source Socket.IO event protocol. */
    writeTerminalOutput(machineId: string, terminalId: string, data: string): void {
        const terminal = this.terminals.get(key(machineId, terminalId));
        if (!terminal) throw new Error('Missing fixture terminal');
        terminal.screen += data; terminal.info.seq++;
        this.publish(machineId, { type: 'output', terminalId, seq: terminal.info.seq, data });
    }

    handle(session: HapiSession, tail: string, url: URL, request: IncomingMessage, response: ServerResponse, body: Record<string, unknown> = {}): boolean {
        if (!['directory', 'filesystem/entry', 'filesystem/download', 'file-info', 'file', 'files', 'filesystem', 'filesystem/upload', 'git-status', 'git-diff-numstat', 'git-diff-file'].includes(tail)) return false;
        const send = (value: unknown, status = 200): void => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
        const committed = (value: unknown): void => {
            if (this.loseNextMutationAcknowledgement) { this.loseNextMutationAcknowledgement = false; response.destroy(); return; }
            send(value);
        };
        const root = session.metadata!.path, requested = typeof body.path === 'string' ? body.path : url.searchParams.get('path') ?? root;
        const path = posix.resolve(root, requested);
        this.fileRequests.push({ sessionId: session.id, machineId: session.metadata!.machineId!, method: request.method ?? '', route: tail, path });
        const documentRead = request.method === 'GET' && (tail === 'file' || tail === 'file-info');
        const roots = documentRead ? this.browseRoots.get(session.id) ?? [root] : [root];
        if (!roots.some(allowed => path === allowed || path.startsWith(`${allowed}/`))) { send({ success: false, code: 'denied', error: documentRead ? 'Path is outside workspace roots' : 'Outside source workspace' }); return true; }
        if (!documentRead && !session.active) { send({ success: false, error: 'Session is inactive' }, 409); return true; }
        const files = this.files.get(session.id) ?? new Map<string, FileEntry>();
        const directories = this.directories.get(session.id) ?? new Map<string, number>();
        const inspect = (target: string) => {
            const file = files.get(target);
            if (file) return { path: target, name: posix.basename(target), type: 'file' as const, size: file.bytes.byteLength, modified: file.modified,
                revision: revision(Buffer.concat([Buffer.from(`${file.modified}:`), file.bytes])), entryCount: 1 };
            if (!directories.has(target)) return undefined;
            const children = [...files].filter(([path]) => path.startsWith(`${target}/`));
            const folders = [...directories].filter(([path]) => path === target || path.startsWith(`${target}/`));
            return { path: target, name: posix.basename(target), type: 'directory' as const, size: children.reduce((sum, [, file]) => sum + file.bytes.byteLength, 0),
                modified: directories.get(target)!, entryCount: children.length + folders.length,
                revision: revision(Buffer.from(JSON.stringify([folders.sort(), children.map(([path, file]) => [path, file.modified, revision(file.bytes)]).sort()]))),
            };
        };
        if (request.method !== 'GET') {
            this.fileWrites.push({ sessionId: session.id, machineId: session.metadata!.machineId!, route: tail, body: structuredClone(body) });
            if (tail === 'file' && request.method === 'PUT') {
                const file = files.get(path);
                if (!file || body.expectedHash !== revision(file.bytes)) { send({ success: false, code: 'conflict', error: 'The source file changed after this editor read it' }); return true; }
                if (typeof body.content !== 'string') { send({ success: false, code: 'denied', error: 'Missing source bytes' }); return true; }
                const bytes = Buffer.from(body.content, 'base64'); files.set(path, { bytes, modified: this.modified++ });
                if (this.loseNextSaveAcknowledgement) { this.loseNextSaveAcknowledgement = false; response.destroy(); return true; }
                send({ success: true, hash: revision(bytes), modified: files.get(path)!.modified }); return true;
            }
            if (request.method !== 'POST' || tail !== 'filesystem' && tail !== 'filesystem/upload') { send({ success: false, error: 'Unsupported fixture route' }, 405); return true; }
            if (path === root) { send({ success: false, code: 'denied', error: 'Cannot mutate the source workspace root' }); return true; }
            if (tail === 'filesystem/upload' || body.action === 'create-file' || body.action === 'create-directory') {
                if (inspect(path)) { send({ success: false, code: 'conflict', error: 'The destination already exists' }); return true; }
                if (!directories.has(posix.dirname(path))) { send({ success: false, code: 'not-found', error: 'The parent directory does not exist' }); return true; }
                if (tail === 'filesystem/upload' && typeof body.content !== 'string') { send({ success: false, code: 'invalid', error: 'Missing upload bytes' }); return true; }
                if (body.action === 'create-directory') directories.set(path, this.modified++);
                else files.set(path, { bytes: tail === 'filesystem/upload' ? Buffer.from(body.content as string, 'base64') : Buffer.alloc(0), modified: this.modified++ });
                committed({ success: true, entry: inspect(path) }); return true;
            }
            const entry = inspect(path);
            if (!entry) { send({ success: false, code: 'not-found', error: 'Source entry not found' }); return true; }
            if (body.expectedRevision !== entry.revision) { send({ success: false, code: 'conflict', error: 'Source entry changed after inspection' }); return true; }
            const selectedFiles = [...files].filter(([candidate]) => candidate === path || candidate.startsWith(`${path}/`));
            const selectedDirectories = [...directories].filter(([candidate]) => candidate === path || candidate.startsWith(`${path}/`));
            if (body.action === 'delete') {
                if (entry.type === 'directory' && body.recursive !== true) { send({ success: false, code: 'invalid', error: 'Recursive deletion must be explicit' }); return true; }
                for (const [candidate] of selectedFiles) files.delete(candidate);
                for (const [candidate] of selectedDirectories) directories.delete(candidate);
                committed({ success: true, deletedPaths: [...selectedFiles, ...selectedDirectories].map(([candidate]) => candidate) }); return true;
            }
            if (!['rename', 'move', 'copy'].includes(String(body.action)) || typeof body.destination !== 'string') { send({ success: false, code: 'invalid', error: 'Unsupported source action' }); return true; }
            const destination = posix.resolve(root, body.destination);
            if (!destination.startsWith(`${root}/`) || destination === path || destination.startsWith(`${path}/`)) { send({ success: false, code: 'denied', error: 'Invalid source destination' }); return true; }
            if (inspect(destination)) { send({ success: false, code: 'conflict', error: 'Source destination exists' }); return true; }
            if (!directories.has(posix.dirname(destination))) { send({ success: false, code: 'not-found', error: 'Destination parent does not exist' }); return true; }
            for (const [candidate, file] of selectedFiles) files.set(destination + candidate.slice(path.length), { bytes: Buffer.from(file.bytes), modified: this.modified++ });
            for (const [candidate] of selectedDirectories) directories.set(destination + candidate.slice(path.length), this.modified++);
            if (body.action !== 'copy') {
                for (const [candidate] of selectedFiles) files.delete(candidate);
                for (const [candidate] of selectedDirectories) directories.delete(candidate);
            }
            committed({ success: true, entry: inspect(destination), ...(body.action === 'copy' ? {} : { commit: { action: body.action, path, destination } }) }); return true;
        }
        if (tail === 'files') {
            const query = (url.searchParams.get('query') ?? '').toLowerCase(), limit = Number(url.searchParams.get('limit') ?? 200);
            const found = [...files.keys(), ...directories.keys()].filter(path => path !== root && path.toLowerCase().includes(query)).sort().slice(0, limit);
            send({ success: true, files: found.map(path => ({ fileName: posix.basename(path), filePath: posix.relative(root, path), fullPath: path, fileType: directories.has(path) ? 'folder' : 'file', ...(files.has(path) ? { size: files.get(path)!.bytes.byteLength } : {}) })) }); return true;
        }
        if (tail.startsWith('git-')) {
            const original = this.originals.get(session.id) ?? new Map<string, Buffer>(), staged = url.searchParams.get('staged') === 'true';
            const changed = [...new Set([...original.keys(), ...files.keys()])].filter(path => !original.get(path)?.equals(files.get(path)?.bytes ?? Buffer.alloc(0)) || !files.has(path));
            const lines = (bytes: Buffer | undefined) => bytes?.toString().replace(/\n$/, '').split('\n') ?? [];
            let stdout = '';
            if (tail === 'git-status') stdout = '# branch.head fixture\n' + changed.map(path => original.has(path)
                ? `1 .${files.has(path) ? 'M' : 'D'} N... 100644 100644 100644 ${'a'.repeat(40)} ${'b'.repeat(40)} ${posix.relative(root, path)}` : `? ${posix.relative(root, path)}`).join('\n');
            else if (tail === 'git-diff-numstat' && !staged) stdout = changed.filter(path => original.has(path)).map(path => `${lines(files.get(path)?.bytes).length}\t${lines(original.get(path)).length}\t${posix.relative(root, path)}`).join('\n');
            else if (tail === 'git-diff-file' && !staged && original.has(path) && changed.includes(path)) {
                const name = posix.relative(root, path), before = lines(original.get(path)), after = lines(files.get(path)?.bytes);
                stdout = `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1,${before.length} +1,${after.length} @@\n` + before.map(line => `-${line}\n`).join('') + after.map(line => `+${line}\n`).join('');
            }
            send({ success: true, stdout, stderr: '', exitCode: 0 }); return true;
        }
        if (tail === 'directory') {
            const entries = new Map<string, { name: string; type: 'file' | 'directory'; size?: number; modified: number }>();
            for (const [file, entry] of files) {
                if (!file.startsWith(`${path}/`)) continue;
                const relative = file.slice(path.length + 1), first = relative.split('/')[0]!;
                entries.set(first, relative.includes('/') ? { name: first, type: 'directory', modified: entry.modified }
                    : { name: first, type: 'file', size: entry.bytes.byteLength, modified: entry.modified });
            }
            for (const [directory, modified] of directories) {
                if (directory === path || !directory.startsWith(`${path}/`)) continue;
                const first = directory.slice(path.length + 1).split('/')[0]!;
                entries.set(first, { name: first, type: 'directory', modified });
            }
            if (directories.has(path)) send({ success: true, entries: [...entries.values()] });
            else send({ success: false, error: 'Not a source directory' });
            return true;
        }
        if (tail === 'filesystem/entry') { const entry = inspect(path); send(entry ? { success: true, entry } : { success: false, code: 'not-found', error: 'Source entry not found' }); return true; }
        const entry = files.get(path);
        if (tail === 'file-info' && !entry) { send({ success: true, entries: [{ path }] }); return true; }
        if (!entry) { send({ success: false, code: 'not-found', error: 'Source file not found' }, tail === 'filesystem/download' ? 404 : 200); return true; }
        if (tail === 'file-info') send({ success: true, entries: [{ path, size: entry.bytes.byteLength, modified: entry.modified }] });
        else if (tail === 'file') send({ success: true, path, content: entry.bytes.toString('base64'), hash: revision(entry.bytes), writable: path.startsWith(`${root}/`), size: entry.bytes.byteLength, modified: entry.modified });
        else {
            response.writeHead(200, { 'content-type': entry.mediaType ?? 'text/plain; charset=utf-8', 'content-length': entry.bytes.byteLength,
                'content-disposition': `attachment; filename="${posix.basename(path)}"` });
            response.end(entry.bytes);
        }
        return true;
    }

    async close(): Promise<void> { await new Promise<void>(resolve => this.io.close(() => resolve())); }

    private request(viewer: Viewer, machineId: string, command: MachineTerminalCommand): unknown {
        const sessions = this.sessions().filter(session => session.metadata?.machineId === machineId);
        if (!sessions.length) throw new Error('Machine does not belong to this fixture namespace');
        this.terminalCommands.push({ machineId, command: structuredClone(command) });
        if (command.type === 'list') return [...this.terminals.values()].filter(value => value.machineId === machineId).map(value => structuredClone(value.info));
        const identity = key(machineId, command.terminalId);
        if (command.type === 'create') {
            if (!sessions.some(session => session.metadata!.path === command.cwd)) throw new Error('Cwd does not belong to the source machine');
            if (!this.terminals.has(identity)) {
                const info: MachineTerminalInfo = { terminalId: command.terminalId, title: command.title, cwd: command.cwd, pid: this.nextPid++, createdAt: Date.now(), endedAt: null,
                    status: 'running', exitCode: null, cols: command.cols, rows: command.rows, seq: 0, controllerId: null, controlVersion: 0 };
                this.terminals.set(identity, { machineId, info, screen: `Simulated source terminal ${machineId}\r\n${command.cwd}\r\n$ ` });
            }
            return structuredClone(this.terminals.get(identity)!.info);
        }
        const terminal = this.terminals.get(identity);
        if (!terminal) throw new Error('Source terminal does not exist; attach does not create it');
        const info = terminal.info;
        if (command.type === 'attach') { viewer.subscriptions.add(identity); return { terminal: structuredClone(info), reset: true, data: terminal.screen, seq: info.seq }; }
        if (command.type === 'detach') { viewer.subscriptions.delete(identity); return null; }
        if (command.type === 'claim') {
            if (info.controllerId && info.controllerId !== command.controllerId && !command.takeover) throw new Error('Terminal has another controller');
            info.controllerId = command.controllerId; info.controlVersion++; viewer.controllers.add(command.controllerId);
        } else if (command.type === 'release') {
            this.assertControl(viewer, info, command); info.controllerId = null; info.controlVersion++;
        } else if (command.type === 'input') {
            this.assertControl(viewer, info, command);
            if (info.status !== 'running') throw new Error('Source terminal is not running');
            this.terminalInputs.push({ machineId, terminalId: info.terminalId, data: command.data });
            const text = command.data.replaceAll('\r', '\r\n'); terminal.screen += text; info.seq++;
            this.publish(machineId, { type: 'output', terminalId: info.terminalId, seq: info.seq, data: text });
            return null;
        } else if (command.type === 'resize') {
            this.assertControl(viewer, info, command); info.cols = command.cols; info.rows = command.rows;
        } else if (command.type === 'rename') info.title = command.title;
        else if (command.type === 'terminate') { info.status = 'exited'; info.exitCode = 0; info.endedAt = Date.now(); info.controllerId = null; info.controlVersion++; }
        this.publish(machineId, { type: 'state', terminal: info });
        return command.type === 'release' ? null : structuredClone(info);
    }

    private assertControl(viewer: Viewer, info: MachineTerminalInfo, command: { controllerId: string; controlVersion: number }): void {
        if (!viewer.controllers.has(command.controllerId) || info.controllerId !== command.controllerId || info.controlVersion !== command.controlVersion) throw new Error('Source terminal control has changed');
    }
    private publish(machineId: string, event: MachineTerminalEvent): void {
        const terminalId = event.type === 'output' ? event.terminalId : event.type === 'state' ? event.terminal.terminalId : undefined;
        for (const viewer of this.viewers) {
            if (terminalId && !viewer.subscriptions.has(key(machineId, terminalId))) continue;
            viewer.socket.emit('machine-terminal:event', { machineId, event: structuredClone(event) });
        }
    }
}
