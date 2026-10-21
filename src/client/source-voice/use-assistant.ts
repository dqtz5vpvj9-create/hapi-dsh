import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useConversation } from '@elevenlabs/react';
import { VoiceAssistant } from './assistant.ts';
import type { VoiceToolOwner } from './tools.ts';
import type { SourceVoiceTransport } from './transport.ts';

/** The supported SDK owns its WebRTC connection; its public endSession drains a pending start. */
export function useVoiceAssistant(transport: SourceVoiceTransport, owner: VoiceToolOwner, onSettled: () => void) {
    const controller = useRef<VoiceAssistant | null>(null), settled = useRef(onSettled); settled.current = onSettled;
    const latestOwner = useRef(owner); latestOwner.current = owner;
    const [muted, setMuted] = useState(false);
    // Per-start callbacks are bound to the captured Run by VoiceAssistant;
    // late events from an ended SDK connection cannot control its successor.
    const conversation = useConversation({ micMuted: muted });
    const sdk = useRef(conversation); sdk.current = conversation;
    if (!controller.current) controller.current = new VoiceAssistant(transport, () => latestOwner.current, {
        async start(options) { await sdk.current.startSession(options as Parameters<typeof conversation.startSession>[0]); },
        end: () => sdk.current.endSession(), text: text => sdk.current.sendUserMessage(text), context: text => sdk.current.sendContextualUpdate(text),
    }, () => settled.current());
    const instance = controller.current, state = useSyncExternalStore(instance.subscribe, instance.getSnapshot);
    useEffect(() => () => { void instance.stop().catch(() => {}); }, [instance]);
    return { state, start: instance.start.bind(instance), stop: instance.stop.bind(instance),
        setMuted(value: boolean) { setMuted(value); instance.setMuted(value); },
    };
}
