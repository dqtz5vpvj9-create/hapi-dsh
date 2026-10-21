import type { Context } from '@deepseek-ai/cordis'
import { createElement } from 'react'
import { remoteValue, type HapiRemoteApi } from '../client-api.ts'
import { NativeActionLedger } from './native-state.ts'
import { NativeControlLedger } from './native-control-state.ts'
import type { NativeActionsApi } from './native-actions.tsx'
import { NativeForkAction, type NativeForkActionProps } from './native-fork-action.tsx'
import { installNativeComposerAdmission } from './native-composer.ts'
import { installNativeRewindAction } from './native-rewind-action.tsx'
import { ObservedControlLedger } from './observed-controls.tsx'
import { installSourcePathActions } from './source-path-actions.tsx'
import { installSourceFileActions } from './source-file-actions.tsx'
import { installSourceTerminalActions } from './source-terminal-actions.tsx'
import { installLegacyTerminalView } from './legacy-terminal-view.tsx'
import { installArtifactPreview } from './artifact-preview.tsx'
import { installSourceMarkdown } from './source-markdown.tsx'
import { installNotifySummaryDisplay } from './notify-summary-display.tsx'
import { installSourceVoice } from './source-voice/index.tsx'
import { installGeneratedMediaDisplay } from './generated-media-display.tsx'
import { installToolProgressDisplay } from './tool-progress-display.tsx'
import { installCodexReviewDisplay } from './codex-review-display.tsx'
import { installNativeActionDock } from './native-action-dock.tsx'
import { installTurnSharing } from './turn-share.tsx'
import { installSourceDshChildControls } from './source-dsh-child.tsx'
import { installSourceAppearance } from './appearance/index.tsx'

export interface NativePaneIntegration { api: HapiRemoteApi; native: NativeActionsApi; controls: NativeControlLedger }

declare module '@deepseek-ai/cordis' {
    interface Context { hapiPaneNative: NativePaneIntegration }
}

/** Source-only controls layered on the unchanged official Conversation. */
export function installNativeIntegration(ctx: Context, api: HapiRemoteApi, open: (sessionId: string) => void, refresh: () => void): NativePaneIntegration & { dispose(): void } {
    const ledger = new NativeActionLedger(), controls = new NativeControlLedger(api), observedControls = new ObservedControlLedger(api)
    const native: NativeActionsApi = {
        ledger, controls, observedControls, branchLabel: () => ctx.locale.bind('chat')('message.branch'),
        cancel: async (sessionId, localId) => remoteValue(await api.nativeCancel({ sessionId, localId })),
        steer: async (sessionId, localId) => remoteValue(await api.nativeSteer({ sessionId, localId })),
        retry: async (sessionId, localId) => remoteValue(await api.nativeRetry({ sessionId, localId })),
        answer: async (sessionId, requestId, answer, deny) => remoteValue(await api.nativeAnswer({ sessionId, requestId, answer, ...(deny === undefined ? {} : { deny }) })),
        resume: async sessionId => remoteValue(await api.resumeSession({ sessionId })),
    }
    const disposers: Array<() => void> = []
    disposers.push(installSourceAppearance(ctx))
    disposers.push(installSourcePathActions(ctx, api))
    disposers.push(installSourceFileActions(ctx, api))
    disposers.push(installSourceTerminalActions(ctx, api))
    disposers.push(installLegacyTerminalView(ctx, api))
    disposers.push(installArtifactPreview(ctx, api))
    disposers.push(installSourceMarkdown(ctx))
    disposers.push(installNotifySummaryDisplay(ctx, api))
    disposers.push(installSourceVoice(ctx, api))
    disposers.push(installGeneratedMediaDisplay(ctx))
    disposers.push(installToolProgressDisplay(ctx))
    disposers.push(installCodexReviewDisplay(ctx))
    disposers.push(installNativeActionDock(ctx, native, api))
    disposers.push(installSourceDshChildControls(ctx, api))
    disposers.push(installTurnSharing(ctx))
    const Fork = (props: Omit<NativeForkActionProps, 'controls' | 'open'>) => createElement(NativeForkAction, { ...props, controls, open })
    disposers.push(ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
        name: 'conversation.chat.assistant-actions', id: 'hapi.native-fork', order: 100, locale: 'hapiWorkspace',
    }, Fork)))
    disposers.push(installNativeComposerAdmission(ctx.sessions, ctx.conversation.blocks, {
        t: ctx.locale.bind('hapiWorkspace'), subscribe: listener => ctx.locale.subscribe(listener),
    }))
    disposers.push(installNativeRewindAction(ctx, api, refresh))
    return { api, native, controls, dispose() { for (const dispose of disposers.reverse()) dispose(); ledger.clear(); controls.clear(); observedControls.clear() } }
}
