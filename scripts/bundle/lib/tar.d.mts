export interface TarWriteEntry {
    path: string;
    data?: string | Uint8Array;
    mode?: number;
    mtime?: number;
    type?: 'file' | 'dir';
}

export interface TarReadEntry {
    path: string;
    type: 'file' | 'dir' | 'symlink' | 'hardlink' | 'other';
    size: number;
    mode: number;
    mtime: number;
    data?: Buffer;
}

export function createTgz(entries: TarWriteEntry[], options?: { gzip?: boolean; mtime?: number }): Buffer;
export function createTgzFromDirectory(root: string, options?: { prefix?: string; gzip?: boolean; mtime?: number }): Promise<Buffer>;
export function readTar(archive: Buffer, options?: { withData?: boolean }): TarReadEntry[];
export function readTgz(buffer: Buffer, options?: { withData?: boolean }): TarReadEntry[];
export function listTgz(buffer: Buffer): Array<{ path: string; type: string; size: number; mode: number; mtime: number }>;
export function extractTgz(buffer: Buffer, targetDirectory: string): Promise<{ files: number; bytes: number }>;
