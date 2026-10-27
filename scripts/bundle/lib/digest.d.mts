export function sha256Bytes(bytes: Uint8Array): string;
export function sha256File(path: string): Promise<string>;
export function canonicalJson(value: unknown): string;
export function digestOfEntries(entries: Array<{ path: string; sha256: string; size?: number }>): string;
export function digestTree(root: string, options?: { ignore?: string[] }): Promise<{
    digest: string;
    files: Array<{ path: string; sha256: string; size: number }>;
}>;
