export interface NativeMetadataRequest { home: string; threadId: string; before?: number; after?: number; around?: number; limit: number; userOnly?: boolean }
export interface NativeMetadataItem { turnId: string; itemId: string; ordinal: number; startedAtMs: number | null; completedAtMs: number | null; revision: number; predecessorId: string | null }
export interface NativeMetadataTurn { id: string; status: 'inProgress' | 'completed' | 'interrupted' | 'failed'; startedAt: number | null; completedAt: number | null; ordinal: number; endOrdinal: number | null; error?: unknown }
export interface NativeMetadataPage { items: NativeMetadataItem[]; turns: NativeMetadataTurn[]; hasBefore: boolean; hasAfter: boolean; coordinates: string; first?: number | null | undefined; last?: number | null | undefined }
export function readNativeMetadata(request: NativeMetadataRequest): Promise<NativeMetadataPage>;
