export interface NativeMetadataRequest { home: string; threadId: string; before?: number; after?: number; around?: number; limit: number; userOnly?: boolean; position?: { turnId: string; itemId?: string }; /** Private source fact, confirmed by exact native turns/list, never a browser field. */ unmaterialized?: true }
export class NativeMetadataIndexMissing extends Error {}
export interface NativeMetadataItem { turnId: string; itemId: string; ordinal: number; startedAtMs: number | null; completedAtMs: number | null; revision: number; predecessorId: string | null }
export interface NativeMetadataTurn { id: string; status: 'inProgress' | 'completed' | 'interrupted' | 'failed'; startedAt: number | null; completedAt: number | null; ordinal: number; endOrdinal: number | null; error?: unknown }
export interface NativeMetadataPage { items: NativeMetadataItem[]; turns: NativeMetadataTurn[]; hasBefore: boolean; hasAfter: boolean; coordinates: string; positionMissing?: boolean | undefined; first?: number | null | undefined; last?: number | null | undefined }
export function readNativeMetadata(request: NativeMetadataRequest): Promise<NativeMetadataPage>;
export interface NativeLifecycleRequest { kind: 'lifecycle'; home: string; candidates: readonly { threadId: string; createdAt: number }[] }
export function readNativeLifecycles(request: NativeLifecycleRequest): { absent: string[] };
