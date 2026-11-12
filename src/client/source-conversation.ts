/** The same source contributions belong to every official Conversation graph. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type { SourceComposerBridge } from './source-composer.tsx'
import { installRemoteFeedbackPolicy } from './remote-feedback.tsx'
import { installSourcePathActions } from './source-path-actions.tsx'
import { installSourceFileActions } from './source-file-actions.tsx'
import { installArtifactPreview } from './artifact-preview.tsx'
import { installDocumentSelections } from './document-selection.tsx'
import { installSourceMarkdown } from './source-markdown.tsx'
import { installSourceChatFiles } from './source-chat-files.tsx'
import { installToolProgressDisplay } from './tool-progress-display.tsx'
import { installSourceTranscript } from './source-transcript.tsx'
import { installNativeToolDetails } from './native-tool-details.tsx'
import { installCodexReviewDisplay } from './codex-review-display.tsx'
import { installComposerPicker } from './composer-picker/index.tsx'
import { installSourceTaskEntry } from './source-task-entry.tsx'
import { installRemoteFileUpload } from './remote-file-upload.ts'
import { installRemoteInputTriggers } from './remote-input-triggers.ts'
import { installRemoteSourceControls } from './remote-controls.tsx'
import { installRemoteNativeFork } from './remote-native-fork.tsx'
import { installTurnSharing } from './turn-share.tsx'
import { installShareReceiver } from './share-receiver.tsx'
import { installSourceNativeNavigation, type SourceNativeNavigationOptions } from './source-native-navigation.tsx'
import { installOrdinaryReadingMemory } from './ordinary-reading-checkpoint.ts'

/** Direct public service reads made by this source-only installer branch.
 * Artifact resources/previews and input triggers keep their own nested scopes. */
export const SOURCE_CONVERSATION_SERVICES = [
    'sourceFiles', 'hhpiSessions', 'remote', 'remote.hhpi', 'fileUpload', 'fileDrag',
    'layout', 'shortcuts', 'sidebarRightTabs',
] as const

export function installSourceConversation(ctx: Context, composer: SourceComposerBridge,
    navigation: SourceNativeNavigationOptions): () => void {
    const stops: Array<() => void> = []
    const dispose = (): void => { for (const stop of stops.splice(0).reverse()) stop() }
    try {
        stops.push(installOrdinaryReadingMemory(ctx))
        stops.push(installRemoteFeedbackPolicy(ctx))
        stops.push(installSourcePathActions(ctx, ctx.sourceFiles), installSourceFileActions(ctx, ctx.sourceFiles))
        stops.push(installArtifactPreview(ctx, ctx.sourceFiles), installDocumentSelections(ctx))
        stops.push(installSourceMarkdown(ctx, ctx.sourceFiles), installSourceChatFiles(ctx, ctx.sourceFiles))
        stops.push(installToolProgressDisplay(ctx), installSourceTranscript(ctx, ctx.sourceFiles), installNativeToolDetails(ctx))
        stops.push(installCodexReviewDisplay(ctx), installComposerPicker(ctx))
        stops.push(installSourceNativeNavigation(ctx, navigation))
        stops.push(installSourceTaskEntry(ctx), installRemoteSourceControls(ctx), installRemoteNativeFork(ctx))
        stops.push(installRemoteFileUpload(ctx, ctx.sourceFiles, composer.checkpointUpload), installRemoteInputTriggers(ctx, ctx.remote.hhpi, navigation.workspace, navigation.hostId))
        stops.push(installTurnSharing(ctx), installShareReceiver(ctx, composer))
        return dispose
    } catch (error) { dispose(); throw error }
}
