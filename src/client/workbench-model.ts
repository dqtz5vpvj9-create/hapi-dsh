import type { TerminalOutputCursor, TerminalOutputStream } from '../workbench-types.ts';

/**
 * Adapted from HAPI web/src/lib/terminal-output.ts at 0f8ef697.
 * Copyright HAPI contributors. SPDX-License-Identifier: AGPL-3.0-only
 * Cursor belongs to one xterm receiver's accepted FIFO writes, never ready.
 */
export class TerminalOutputTracker {
    cursor: TerminalOutputCursor | undefined;
    issue: 'gap' | 'legacy' | 'truncated' | null = null;
    private legacyOutput = false;
    get blocked(): boolean { return this.issue === 'gap' || this.issue === 'legacy'; }
    reset(): void { this.cursor = undefined; this.issue = null; this.legacyOutput = false; }
    reconnect(): void { if (this.legacyOutput) this.issue = 'legacy'; }
    receive(data: string, stream: TerminalOutputStream | undefined, accept: (data: string) => boolean | void): void {
        if (this.blocked) return;
        if (!stream) {
            if (this.cursor) { this.issue = 'legacy'; return; }
            if (data && accept(data) !== false) this.legacyOutput = true;
            return;
        }
        if (stream.version !== 1 || stream.gap || !Number.isSafeInteger(stream.startOffset)
            || !Number.isSafeInteger(stream.endOffset) || stream.startOffset < 0
            || stream.endOffset < stream.startOffset || stream.endOffset - stream.startOffset !== data.length) { this.issue = 'gap'; return; }
        const cursor = this.cursor;
        if (cursor && (cursor.epoch !== stream.epoch || stream.startOffset > cursor.offset)) { this.issue = 'gap'; return; }
        if (!cursor && !stream.replay) { this.issue = 'gap'; return; }
        if (cursor && stream.endOffset <= cursor.offset) return;
        const unseen = cursor ? data.slice(Math.max(0, cursor.offset - stream.startOffset)) : data;
        if (accept(unseen) === false) return;
        this.cursor = { epoch: stream.epoch, offset: stream.endOffset };
        if (!cursor && stream.truncated) this.issue = 'truncated';
    }
}

export interface WorkbenchChange { path: string; previousPath?: string; staged: boolean; status: string; added?: number; removed?: number }
/** Git's quoted UTF-8 path format is not JSON (it also uses octal byte escapes). */
export function decodeGitPath(input: string): string {
    if (!input.startsWith('"') || !input.endsWith('"')) return input;
    const bytes: number[] = [];
    const text = input.slice(1, -1);
    const escapes: Record<string, string> = { a: '\x07', b: '\b', t: '\t', n: '\n', v: '\v', f: '\f', r: '\r', '\\': '\\', '"': '"' };
    for (let index = 0; index < text.length; index++) {
        const char = text[index]!;
        if (char === '\\') {
            const octal = /^[0-7]{1,3}/.exec(text.slice(index + 1));
            if (octal) { bytes.push(Number.parseInt(octal[0], 8)); index += octal[0].length; continue; }
            index++;
            bytes.push(...new TextEncoder().encode(escapes[text[index] ?? ''] ?? text[index] ?? ''));
        } else {
            const point = text.codePointAt(index)!;
            bytes.push(...new TextEncoder().encode(String.fromCodePoint(point)));
            if (point > 0xffff) index++;
        }
    }
    return new TextDecoder().decode(new Uint8Array(bytes));
}
function afterFields(line: string, count: number): string | undefined {
    let at = 0;
    for (let field = 0; field < count; field++) { const space = line.indexOf(' ', at); if (space < 0) return undefined; at = space + 1; }
    return line.slice(at);
}
export function parseWorkbenchChanges(status: string, stagedStats = '', unstagedStats = ''): { branch: string | null; changes: WorkbenchChange[] } {
    let branch: string | null = null;
    const changes: WorkbenchChange[] = [];
    const stats = (source: string): Map<string, { added?: number; removed?: number }> => {
        const result = new Map<string, { added?: number; removed?: number }>();
        for (const line of source.split('\n')) {
            const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
            if (!match) continue;
            result.set(decodeGitPath(match[3]!), { ...(match[1] === '-' ? {} : { added: Number(match[1]) }), ...(match[2] === '-' ? {} : { removed: Number(match[2]) }) });
        }
        return result;
    };
    const staged = stats(stagedStats), unstaged = stats(unstagedStats);
    for (const line of status.split('\n')) {
        if (line.startsWith('# branch.head ')) { branch = line.slice(14); continue; }
        if (line.startsWith('? ')) { changes.push({ path: decodeGitPath(line.slice(2)), staged: false, status: '?' }); continue; }
        const kind = line[0];
        if (kind !== '1' && kind !== '2' && kind !== 'u') continue;
        const xy = line.split(' ', 2)[1];
        const paths = afterFields(line, kind === '2' ? 9 : kind === 'u' ? 10 : 8);
        if (!xy || xy.length !== 2 || !paths) continue;
        const [name, previous] = paths.split('\t');
        const path = decodeGitPath(name!);
        const common = { path, ...(previous === undefined ? {} : { previousPath: decodeGitPath(previous) }) };
        if (kind === 'u') { changes.push({ ...common, staged: false, status: 'conflict', ...unstaged.get(path) }); continue; }
        if (xy[0] !== '.') changes.push({ ...common, staged: true, status: xy[0]!, ...staged.get(path) });
        if (xy[1] !== '.') changes.push({ ...common, staged: false, status: xy[1]!, ...unstaged.get(path) });
    }
    return { branch, changes };
}

/** Paths are interpreted by the source Runner, never by the browser's OS. */
export function childPath(parent: string, child: string): string { return parent ? `${parent.replace(/[\\/]$/, '')}/${child}` : child; }
export function parentPath(path: string): string { return path.replace(/[\\/]$/, '').replace(/(?:^|[\\/])[^\\/]+$/, ''); }
export function bytesToBase64(bytes: Uint8Array): string {
    let text = '';
    for (let index = 0; index < bytes.length; index += 16_384) text += String.fromCharCode(...bytes.subarray(index, index + 16_384));
    return btoa(text);
}

/** HAPI's terminal modifier encoding, including xterm application cursor mode. */
export function terminalKey(sequence: string, modifiers: { ctrl: boolean; alt: boolean; shift: boolean }, applicationCursorKeys = false): string {
    const parameter = 1 + Number(modifiers.shift) + 2 * Number(modifiers.alt) + 4 * Number(modifiers.ctrl);
    if (parameter === 1) return applicationCursorKeys ? sequence.replace(/^\u001b\[([ABCDHF])$/, '\u001bO$1') : sequence;
    const cursor = /^\u001b(?:\[|O)([ABCDHFPQRS])$/.exec(sequence);
    if (cursor) return `\u001b[1;${parameter}${cursor[1]}`;
    const navigation = /^\u001b\[(\d+)~$/.exec(sequence);
    if (navigation) return `\u001b[${navigation[1]};${parameter}~`;
    if (sequence === '\t' && modifiers.shift && !modifiers.ctrl && !modifiers.alt) return '\u001b[Z';
    let result = sequence;
    if (modifiers.ctrl && result.length === 1) {
        const code = result.toUpperCase().charCodeAt(0);
        if (code >= 64 && code <= 95) result = String.fromCharCode(code - 64);
        else if (result === ' ') result = '\u0000';
        else if (result === '?') result = '\u007f';
    } else if (modifiers.shift && result.length === 1) result = result.toUpperCase();
    return modifiers.alt ? `\u001b${result}` : result;
}
