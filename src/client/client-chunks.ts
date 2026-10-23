/** The pinned official ModuleLoader owns fetching, revisioning and deduplication. */
declare const require: { async(specifier: string): Promise<unknown> }

export function loadVoiceComposer(): Promise<typeof import('./source-voice/composer.tsx')> {
    return require.async('./client.voice.js') as Promise<typeof import('./source-voice/composer.tsx')>
}

export function loadCapture(): Promise<typeof import('html2canvas-pro')> {
    return require.async('./client.capture.js') as Promise<typeof import('html2canvas-pro')>
}

export function loadNativePanels(): Promise<typeof import('./native-panels.ts')> {
    return require.async('./client.native-panels.js') as Promise<typeof import('./native-panels.ts')>
}

export function loadSessionPanels(): Promise<typeof import('./session-extras.tsx')> {
    return require.async('./client.session-panels.js') as Promise<typeof import('./session-extras.tsx')>
}

export function loadAdministrationPanel(): Promise<typeof import('./source-admin-panel.tsx')> {
    return require.async('./client.administration.js') as Promise<typeof import('./source-admin-panel.tsx')>
}
