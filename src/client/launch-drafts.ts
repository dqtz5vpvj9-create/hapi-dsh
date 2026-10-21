import { z } from 'zod'
import { createNativeSessionSchema, type CreateNativeSession } from '../codex/creation-types.ts'
import { SOURCE_CREATION_FLAVORS } from '../hapi-agent/creation-types.ts'
import type { WorkspaceCreationContext } from './controller.ts'

export type DraftStorage = Pick<Storage, 'getItem' | 'setItem'>
const text = (max = 4096) => z.string().max(max).default('')
const shared = {
    machineId: text(512), directory: text(), model: text(256), reasoning: text(64),
    worktree: z.boolean().default(false), worktreeName: text(200),
}
export const nativeLaunchFieldsSchema = z.object({ ...shared, home: text(), accountId: text(512), keyProfileId: text(128),
    permission: z.enum(['', 'default', 'read-only', 'yolo']).default(''),
    collaboration: z.enum(['', 'default', 'plan']).default(''), serviceTier: z.enum(['', 'standard', 'fast']).default(''),
})
export type NativeLaunchFields = z.infer<typeof nativeLaunchFieldsSchema>
export const sourceLaunchFieldsSchema = z.object({ ...shared, agent: z.enum(SOURCE_CREATION_FLAVORS).default('claude'),
    effort: text(64), permission: text(128), startingMode: z.enum(['remote', 'pty']).default('remote'), copilotMode: text(64),
    cursorBase: z.string().max(256).optional(),
})

/** A folder's source machine takes precedence over reusable form defaults.
 * When there is no verified HAPI machine mapping, require an explicit choice. */
export function nativeFieldsForContext(fields: NativeLaunchFields, context: WorkspaceCreationContext | null): NativeLaunchFields {
    if (!context) return fields
    const changedMachine = fields.machineId !== context.machineId
    return { ...fields, directory: context.directory, machineId: context.machineId ?? '', worktreeName: '',
        ...(changedMachine ? { home: '', accountId: '', keyProfileId: '', model: '', reasoning: '' } : {}) }
}
export function sourceFieldsForContext(fields: z.infer<typeof sourceLaunchFieldsSchema>, context: WorkspaceCreationContext | null): z.infer<typeof sourceLaunchFieldsSchema> {
    if (!context) return fields
    const agent = SOURCE_CREATION_FLAVORS.find(flavor => flavor === context.engine) ?? fields.agent
    const changed = fields.machineId !== context.machineId || fields.directory !== context.directory || fields.agent !== agent
    return { ...fields, machineId: context.machineId ?? '', directory: context.directory, agent, worktreeName: '',
        ...(changed ? { model: '', reasoning: '', effort: '', cursorBase: undefined } : {}),
        ...(fields.agent !== agent ? { permission: '', copilotMode: '', startingMode: 'remote' } : {}) }
}

/** Drafts are separate from confirmed preferences and immutable launch intents. */
export class LaunchDraftStore<T extends { worktreeName: string }> {
    constructor(private readonly storage: DraftStorage | undefined, private readonly key: string, private readonly schema: z.ZodType<T>) {}
    private read(suffix: string): T | null {
        try { const result = this.schema.safeParse(JSON.parse(this.storage?.getItem(`${this.key}:${suffix}`) ?? 'null')); return result.success ? result.data : null }
        catch { return null }
    }
    load(): T { return this.read('draft') ?? this.read('preferences') ?? this.schema.parse({}) }
    save(fields: T): void {
        try { this.storage?.setItem(`${this.key}:draft`, JSON.stringify(this.schema.parse(fields))) } catch { /* Form stays usable; launch intent has a separate durable gate. */ }
    }
    completed(fields: T): void {
        try {
            this.storage?.setItem(`${this.key}:preferences`, JSON.stringify(this.schema.parse({ ...fields, worktreeName: '' })))
            this.storage?.setItem(`${this.key}:draft`, 'null')
        } catch { /* The original creation receipt remains authoritative. */ }
    }
}

export function nativeFieldsFromRequest(request: CreateNativeSession): NativeLaunchFields {
    return nativeLaunchFieldsSchema.parse({ machineId: request.machineId, directory: request.directory,
        model: request.model, reasoning: request.modelReasoningEffort, home: request.codexHome,
        accountId: 'codexAccountId' in request ? request.codexAccountId : '', keyProfileId: 'codexKeyProfileId' in request ? request.codexKeyProfileId : '',
        permission: request.permissionMode, collaboration: request.collaborationMode, serviceTier: request.serviceTier,
        worktree: request.sessionType === 'worktree', worktreeName: request.worktreeName,
    })
}

export function readNativeLaunchIntent(storage: DraftStorage | undefined, key: string): CreateNativeSession | null {
    try { const value = createNativeSessionSchema.safeParse(JSON.parse(storage?.getItem(key) ?? 'null')); return value.success ? value.data : null }
    catch { return null }
}

/** Never start a new execution if an available persistent store rejected its recovery identity. */
export function saveLaunchIntent(storage: DraftStorage | undefined, key: string, request: unknown): void {
    if (!storage) return
    const serialized = JSON.stringify(request)
    storage.setItem(key, serialized)
    if (storage.getItem(key) !== serialized) throw new Error('The browser could not retain this launch request. Free browser storage and retry before creating the session.')
}
