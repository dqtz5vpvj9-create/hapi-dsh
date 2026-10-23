/** The pinned official ModuleLoader owns fetching, revisioning and deduplication. */
declare const require: { async(specifier: string): Promise<unknown> }

export function loadVoiceComposer(): Promise<typeof import('./source-voice/composer.tsx')> {
    return require.async('./client.voice.js') as Promise<typeof import('./source-voice/composer.tsx')>
}

export function loadCapture(): Promise<typeof import('html2canvas-pro')> {
    return require.async('./client.capture.js') as Promise<typeof import('html2canvas-pro')>
}
