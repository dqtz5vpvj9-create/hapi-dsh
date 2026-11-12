/** Context-bound native Conversation contributions for one official graph. */
import type { Context } from '@deepseek-ai/cordis'
import type { SourceComposerBridge } from './source-composer.tsx'
import type { SourceNativeNavigationOptions } from './source-native-navigation.tsx'
import { installSourceConversation } from './source-conversation.ts'
import { installNativeComposerAdmission } from './native-composer.ts'
import { installSourceTerminalActions } from './source-terminal-actions.tsx'
import { installSourceVoice } from './source-voice/index.tsx'
import { installSourceAppearance } from './appearance/index.tsx'

export interface NativePaneIntegration { dispose(): void }
declare module '@deepseek-ai/cordis' { interface Context { hapiPaneNative: NativePaneIntegration } }

export function installNativeIntegration(ctx: Context, composer: SourceComposerBridge, navigation: SourceNativeNavigationOptions): NativePaneIntegration {
    const disposers: Array<() => void> = []
    const dispose = (): void => { for (const stop of disposers.splice(0).reverse()) stop() }
    try {
        disposers.push(installSourceAppearance(ctx), installSourceTerminalActions(ctx))
        disposers.push(installSourceConversation(ctx, composer, navigation))
        disposers.push(installSourceVoice(ctx, ctx.locale.getSnapshot().active))
        disposers.push(installNativeComposerAdmission(ctx.sessions, ctx.conversation.blocks, {
            t: ctx.locale.bind('hapiWorkspace'), subscribe: listener => ctx.locale.subscribe(listener),
        }))
        return { dispose }
    } catch (error) { dispose(); throw error }
}
