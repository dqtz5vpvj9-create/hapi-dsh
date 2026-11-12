/** A few named regressions to prove behavior assertions can detect them.
 * Applied only to Vitest's in-memory module graph; no source file is changed. */
export const faults = {
  'stale-workspace': {
    file: 'src/client/source-file-actions.tsx',
    before: 'controller.signal.throwIfAborted()', after: 'void 0',
    testFile: 'tests/experience/workspace-files.test.tsx',
    testName: 'a late workspace resolution cannot reopen tools or send to a previous source session',
  },
  'lost-draft': {
    file: 'src/client/composer-autosave-seat.tsx',
    before: "pane?.hostId ?? 'local', props.sessionId) : null", after: "pane?.hostId ?? 'local', JSON.stringify([props.sessionId, pane?.paneId])) : null",
    testFile: 'tests/experience/composer-lifecycle.test.tsx',
    testName: 'typed Chinese draft survives close and a new Pane binding without being sent',
  },
  'ime-send': {
    file: 'src/client/composer-enter/behavior.ts',
    before: 'event.isComposing || event.keyCode === 229 || this.composing || this.now() < this.compositionUntil', after: 'false',
    testFile: 'tests/experience/composer-keyboard.test.tsx',
    testName: 'Chinese composition confirmation never becomes a send and normal shortcut resumes afterward',
  },
} as const
