import { z } from 'zod';
import { sourceMachineOptionsRequestSchema, type SourceMachineOptionsRequest, type SourceMachineOptions } from '../source-machine-types.ts';

interface SourceMachineTransport { request(path: string): Promise<unknown> }
const availability = z.object({ agents: z.array(z.object({ agent: z.string(), available: z.boolean(), reason: z.string().optional() })) });
const models = z.object({ success: z.boolean(), error: z.string().optional(), currentModelId: z.string().nullable().optional(),
    cliModelSkus: z.array(z.object({ modelId: z.string().min(1), name: z.string().optional() })).optional(),
    availableModels: z.array(z.object({ modelId: z.string().min(1), name: z.string().optional(), provider: z.string().optional(),
        reasoning: z.boolean().optional(), thinkingLevelMap: z.record(z.string(), z.string().nullable()).optional(),
        reasoningEfforts: z.array(z.object({ value: z.string().min(1) })).optional(),
    })).optional() });
const variants = z.object({ success: z.boolean(), error: z.string().optional(), variants: z.record(z.string(), z.array(z.string())).optional() });
const message = (error: unknown): string => error instanceof Error ? error.message : 'Runner discovery is unavailable';
// These are launcher aliases and effort flags from the pinned HAPI protocol,
// not a claim that a provider account offers particular model versions.
const claudePresets = [['sonnet', 'Sonnet'], ['sonnet[1m]', 'Sonnet 1M'], ['opus', 'Opus'], ['opus[1m]', 'Opus 1M'], ['fable', 'Fable'], ['fable[1m]', 'Fable 1M']] as const;
const claudeEfforts = ['low', 'medium', 'high', 'xhigh', 'max'];
const piEfforts = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];

/** Source catalogs never fall back to another engine or the Hub's environment. */
export async function sourceMachineOptions(client: SourceMachineTransport, input: SourceMachineOptionsRequest): Promise<SourceMachineOptions> {
    const request = sourceMachineOptionsRequestSchema.parse(input);
    const base = `/api/machines/${encodeURIComponent(request.machineId)}`;
    const result: SourceMachineOptions = { agent: request.agent, availability: { available: null, reason: null },
        models: [], efforts: [], currentModelId: null, warnings: [] };
    const discoveries: Array<Promise<void>> = [(async () => {
        try {
            const source = availability.parse(await client.request(`${base}/agent-availability`));
            const match = source.agents.find(row => row.agent === request.agent);
            if (match) result.availability = { available: match.available, reason: match.reason ?? null };
            else result.warnings.push('The Runner did not report availability for this engine.');
        } catch (error) { result.warnings.push(`Engine availability: ${message(error)}`); }
    })()];
    if (request.agent === 'claude') {
        result.efforts = [...claudeEfforts];
        result.models = claudePresets.map(([id, name]) => ({ id, name, reasoningEfforts: [...claudeEfforts], origin: 'hapi-presets' }));
    } else if (request.agent === 'dsh' || request.agent === 'qoder') {
        result.warnings.push('This engine reports its models and effort options after the source session starts.');
    } else {
        const needsCwd = ['opencode', 'grok', 'kimi', 'copilot'].includes(request.agent);
        if (needsCwd && !request.cwd) result.warnings.push('Choose a working directory to load this engine’s project-specific models.');
        else discoveries.push((async () => {
            try {
                const query = new URLSearchParams();
                if (needsCwd) query.set('cwd', request.cwd!);
                if (request.agent === 'agy' && request.refresh) query.set('refresh', 'true');
                const source = models.parse(await client.request(`${base}/${request.agent}-models${query.size ? `?${query}` : ''}`));
                if (!source.success) throw new Error(source.error ?? 'The Runner rejected model discovery');
                result.currentModelId = source.currentModelId ?? null;
                if (request.agent === 'cursor') result.cliModelSkus = source.cliModelSkus ?? [];
                result.models = (source.availableModels ?? []).flatMap(row => {
                    // A Pi provider is part of its identity. An incomplete row
                    // must not create an ambiguous option with another provider.
                    if (request.agent === 'pi' && !row.provider) {
                        result.warnings.push(`Pi omitted the provider for ${row.modelId}; that ambiguous option was not advertised.`);
                        return [];
                    }
                    const id = request.agent === 'pi' ? `${row.provider}/${row.modelId}` : row.modelId;
                    const reasoningEfforts = request.agent === 'pi'
                        ? row.reasoning === false ? [] : piEfforts.filter(level => row.thinkingLevelMap?.[level] !== null)
                        : (row.reasoningEfforts ?? []).map(item => item.value);
                    return [{ id, name: request.agent === 'pi' ? `${row.name ?? row.modelId} · ${row.provider}` : row.name ?? row.modelId,
                        reasoningEfforts, origin: 'runner' as const }];
                });
                if (request.agent === 'opencode') {
                    try {
                        const sourceVariants = variants.parse(await client.request(`${base}/opencode-model-variants?cwd=${encodeURIComponent(request.cwd!)}`));
                        if (!sourceVariants.success) throw new Error(sourceVariants.error ?? 'The Runner rejected model variant discovery');
                        for (const row of result.models) row.reasoningEfforts = sourceVariants.variants?.[row.id] ?? [];
                    } catch (error) { result.warnings.push(`Model effort variants: ${message(error)}`); }
                }
            } catch (error) { result.warnings.push(`Model catalog: ${message(error)}`); }
        })());
    }
    await Promise.all(discoveries);
    return result;
}
