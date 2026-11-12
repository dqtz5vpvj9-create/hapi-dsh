/** The exact rendered SessionBinding owns native queue and Goal operations. */
import type { Context } from '@deepseek-ai/cordis';
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import { useSyncExternalStore } from 'react';
import { isSourceSessionId } from '../remote/protocol.ts';
import type { RemoteSourceSession } from './remote-sessions.ts';
import { RemoteTaskEntry, remoteNativeTaskStyles } from './remote-native-tasks.tsx';
import { useWorkspacePane } from './surface/pane-context.tsx';

export function installSourceTaskEntry(ctx: Context): () => void {
    const Entry = ({ source: props }: PropsRuntime<'hapi.source.composer-tools'>) => {
        const pane = useWorkspacePane(ctx);
        const visible = useSyncExternalStore(listener => pane?.state.subscribe(listener) ?? (() => {}), () => pane?.state.getSnapshot().visible ?? true);
        const language = useSyncExternalStore(listener => ctx.locale.subscribe(listener), () => ctx.locale.getSnapshot().active);
        const session = (props.sessionBinding ?? ctx.sessions.binding(props.sessionId))?.session as RemoteSourceSession | undefined;
        if (!visible || !session || !isSourceSessionId(props.sessionId)) return null;
        return <RemoteTaskEntry session={session} api={ctx.remote.hhpi} language={language}/>;
    };
    const stop = ctx.slots.inject('hapi.source.composer-tools', () => ctx.slots.register({ name: 'hapi.source.composer-tools', id: 'hhpi.tasks', order: 30 }, Entry));
    const style = document.createElement('style');
    style.textContent = remoteNativeTaskStyles + '.hhpi-task-entry{display:flex;align-items:center;justify-content:center;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:20px;width:44px;height:44px;padding:0;flex:0 0 44px;cursor:pointer;border-radius:8px}.hhpi-task-entry:hover{background:var(--dsw-alias-interactive-bg-hover)}';
    document.head.append(style);
    return () => { stop(); style.remove(); };
}
