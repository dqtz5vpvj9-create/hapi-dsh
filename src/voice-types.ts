/** Public voice bridge for the unchanged HAPI 0f8ef697 provider routes. */
import { z } from 'zod';
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import { workbenchSourceSchema } from './workbench-types.ts';

export const MAX_VOICE_AUDIO_BYTES = 25 * 1024 * 1024;
export const VOICE_TRANSCRIPTION_PATH = '/hapi-dsh/voice/transcription';
export const VOICE_PROXY_PATHS = { 'gemini-live': '/hapi-dsh/voice/gemini-ws', 'qwen-realtime': '/hapi-dsh/voice/qwen-ws' } as const;
export const voiceBackendSchema = z.enum(['elevenlabs', 'gemini-live', 'qwen-realtime']);
export const transcriptionProviderSchema = z.enum(['openai', 'elevenlabs', 'deepgram', 'groq', 'openai-compatible', 'browser-local']);
export const voiceLanguageSchema = z.string().trim().min(2).max(35).regex(/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i);
const id = z.string().min(1).max(512).refine(value => !/[\u0000-\u001f\u007f]/u.test(value));
const maskedCredential = z.object({ configured: z.boolean(), source: z.enum(['env', 'settings', 'none']), hint: z.string().max(256).nullable(), editable: z.boolean() });
export const voiceCredentialsSchema = z.object({
    openai: maskedCredential, elevenlabs: maskedCredential, deepgram: maskedCredential, groq: maskedCredential,
    openaiCompatible: z.object({ configured: z.boolean(), source: z.enum(['env', 'settings', 'none']), baseUrl: z.string().max(8192).nullable(), model: z.string().max(1024).nullable(),
        baseUrlEditable: z.boolean(), modelEditable: z.boolean(), apiKey: maskedCredential }),
    voiceBackends: z.object({ elevenlabs: maskedCredential, geminiLive: maskedCredential, qwenRealtime: maskedCredential }),
});
const secretUpdate = z.string().max(16_384).nullable().optional();
export const voiceCredentialUpdateSchema = z.strictObject({
    openai: secretUpdate, elevenlabs: secretUpdate, deepgram: secretUpdate, groq: secretUpdate,
    openaiCompatible: z.strictObject({ baseUrl: z.string().max(8192).nullable().optional(), model: z.string().max(1024).nullable().optional(), apiKey: secretUpdate }).optional(),
    geminiLive: secretUpdate, qwenRealtime: secretUpdate,
});
export const voiceCapabilitiesSchema = z.object({
    hubId: id, backend: voiceBackendSchema.nullable(), backends: z.array(voiceBackendSchema).max(3),
    providers: z.array(z.object({ id: transcriptionProviderSchema, label: z.string().max(128), modes: z.array(z.enum(['standard', 'realtime'])).max(2) })).max(6),
});
export const voiceContextSchema = z.object({
    source: workbenchSourceSchema, sessionId: id, title: z.string().max(8192), agentLabel: z.string().max(128), active: z.boolean(), thinking: z.boolean(),
    epoch: z.number().int().nonnegative(), hasEarlier: z.boolean(),
    plan: z.object({ bootstrap: z.string().max(4000), streamChunks: z.array(z.string().max(8000)).max(50), truncated: z.boolean(), totalMessages: z.number().int(),
        messagesInBootstrap: z.number().int(), messagesStreamed: z.number().int(), notice: z.string().max(8192).nullable() }),
    messages: z.array(z.object({ id, seq: z.number().int().nullable(), text: z.string().max(8000).nullable() })).max(50),
    approvals: z.array(z.object({ id, tool: z.string().max(1024), context: z.string().max(8000), answerable: z.boolean() })).max(128),
});
export const voiceInputs = {
    sourceVoiceCapabilities: z.strictObject({}), sourceVoiceCredentials: z.strictObject({}),
    sourceVoiceUpdateCredentials: z.strictObject({ update: voiceCredentialUpdateSchema }), sourceVoiceVoices: z.strictObject({}),
    sourceVoiceToken: z.strictObject({ backend: voiceBackendSchema, voiceId: z.string().min(1).max(512).optional() }),
    sourceVoiceRealtimeToken: z.strictObject({ provider: z.enum(['openai', 'elevenlabs', 'deepgram']), language: voiceLanguageSchema.optional() }),
    sourceVoiceContext: z.strictObject({ source: workbenchSourceSchema }),
};
export const voiceOutputs = {
    sourceVoiceCapabilities: voiceCapabilitiesSchema, sourceVoiceCredentials: voiceCredentialsSchema,
    sourceVoiceUpdateCredentials: voiceCredentialsSchema,
    sourceVoiceVoices: z.object({ voices: z.array(z.object({ id, name: z.string().max(1024), previewUrl: z.string().max(8192).nullable(), category: z.string().max(256).nullable() })).max(5000) }),
    sourceVoiceToken: z.object({ allowed: z.boolean(), backend: voiceBackendSchema, token: z.string().max(65_536).optional(), agentId: id.optional(), socketPath: z.string().max(1024).optional(), error: z.string().max(8192).optional() }),
    sourceVoiceRealtimeToken: z.object({ token: z.string().min(1).max(65_536) }), sourceVoiceContext: voiceContextSchema,
};
export type VoiceMethod = keyof typeof voiceInputs;
export type VoiceRequest<K extends VoiceMethod> = z.infer<(typeof voiceInputs)[K]>;
export type VoiceResponse<K extends VoiceMethod> = z.infer<(typeof voiceOutputs)[K]>;
export type SourceVoiceApi = { [K in VoiceMethod]: (request: VoiceRequest<K>, signal?: AbortSignal) => Promise<RemoteResult<VoiceResponse<K>>> };
export type SourceVoiceContext = z.infer<typeof voiceContextSchema>;
export type VoiceCapabilities = z.infer<typeof voiceCapabilitiesSchema>;
export type VoiceCredentials = z.infer<typeof voiceCredentialsSchema>;
export type VoiceCredentialUpdate = z.infer<typeof voiceCredentialUpdateSchema>;
export type VoiceBackend = z.infer<typeof voiceBackendSchema>;
