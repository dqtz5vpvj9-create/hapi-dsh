import { z } from 'zod'
import type { MachineOptions } from '../client-api.ts'
import type { HapiClient } from './client.ts'

const homesSchema = z.object({ success: z.boolean(), homes: z.array(z.object({ id: z.string(), label: z.string(), path: z.string(), official: z.boolean().optional() })).optional() })
const modelsSchema = z.object({ success: z.boolean(), models: z.array(z.object({ id: z.string(), displayName: z.string(), supportedReasoningEfforts: z.array(z.string()).optional() })).optional() })
const accountsSchema = z.object({ success: z.boolean(), accounts: z.array(z.object({ id: z.string(), label: z.string(), email: z.string().nullable(), enabled: z.boolean() })).optional() })
const profilesSchema = z.array(z.object({ id: z.string(), label: z.string(), homeId: z.string().optional() }))

/** Read only the requested Runner's public selectors; credentials never cross this boundary. */
export async function nativeLaunchOptions(client: Pick<HapiClient, 'request' | 'listMachines'>, machineId: string): Promise<MachineOptions> {
    const base = `/api/machines/${encodeURIComponent(machineId)}`
    const [homes, models, accounts, machines] = await Promise.allSettled([
        client.request(`${base}/codex-homes`), client.request(`${base}/codex-models`),
        client.request(`${base}/codex-accounts`), client.listMachines(),
    ])
    const result: MachineOptions = { homes: [], models: [], accounts: [], keyProfiles: [], warnings: [] }
    const homeResult = homes.status === 'fulfilled' ? homesSchema.safeParse(homes.value) : null
    if (homeResult?.success && homeResult.data.success) result.homes = (homeResult.data.homes ?? []).map(row => ({ id: row.id, name: row.label, path: row.path, ...(row.official === undefined ? {} : { official: row.official }) }))
    else result.warnings.push('Codex home discovery is unavailable on this Runner.')
    const modelResult = models.status === 'fulfilled' ? modelsSchema.safeParse(models.value) : null
    if (modelResult?.success && modelResult.data.success) result.models = (modelResult.data.models ?? []).map(row => ({ id: row.id, name: row.displayName, reasoningEfforts: row.supportedReasoningEfforts ?? [] }))
    else result.warnings.push('Codex model discovery is unavailable on this Runner.')
    const accountResult = accounts.status === 'fulfilled' ? accountsSchema.safeParse(accounts.value) : null
    if (accountResult?.success && accountResult.data.success) result.accounts = accountResult.data.accounts ?? []
    else result.warnings.push('Codex account discovery is unavailable on this Runner.')
    if (machines.status === 'fulfilled') {
        const machine = machines.value.find(row => row.id === machineId)
        const profiles = profilesSchema.safeParse(machine?.metadata?.codexKeyProfiles ?? [])
        if (profiles.success) result.keyProfiles = profiles.data.map(row => ({ id: row.id, label: row.label, ...(row.homeId === undefined ? {} : { homeId: row.homeId }) }))
        else result.warnings.push('The Runner reported invalid Codex key profile metadata.')
    } else result.warnings.push('Codex key profile discovery is unavailable on this Runner.')
    return result
}
