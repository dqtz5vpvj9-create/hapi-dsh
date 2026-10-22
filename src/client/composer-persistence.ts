import type { DraftSnapshot, InputActions } from '@deepseek-ai/dsh-client-ui-conversation/client'

/** The official shell has one writer; keep it bound until its last view leaves. */
export class ComposerPersistenceBindings {
    private readonly bindings = new WeakMap<InputActions, { users: number; stop(): void }>()
    retain(actions: InputActions, bind: (write: (draft: DraftSnapshot) => void) => () => void, write: (draft: DraftSnapshot) => void): () => void {
        let entry = this.bindings.get(actions)
        if (!entry) { entry = { users: 0, stop: bind(write) }; this.bindings.set(actions, entry) }
        entry.users++
        let released = false
        return () => {
            if (released) return
            released = true
            if (--entry.users) return
            entry.stop(); this.bindings.delete(actions)
        }
    }
}
