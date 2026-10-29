/** A few named regressions to prove behavior assertions can detect them.
 * Applied only to Vitest's in-memory module graph; no source file is changed. */
export const faults = {
  'stale-directory': {
    file: 'src/client/source-directory.tsx',
    before: 'if (active) setEntries(', after: 'if (true) setEntries(',
    testFile: 'tests/experience/source-directory.test.tsx',
    testName: 'typing a path coalesces reads and a late older response cannot replace the chosen folder',
  },
  'lost-draft': {
    file: 'src/client/composer-autosave.ts',
    before: "['hapi', source.hubId, source.hapiSessionId]", after: "['hapi', source.hubId, source.hapiSessionId, sessionId]",
    testFile: 'tests/experience/composer-lifecycle.test.tsx',
    testName: 'typed Chinese draft survives close and a new display generation without being sent',
  },
  'ime-send': {
    file: 'src/client/composer-enter/behavior.ts',
    before: 'event.isComposing || event.keyCode === 229 || this.composing || this.now() < this.compositionUntil', after: 'false',
    testFile: 'tests/experience/composer-keyboard.test.tsx',
    testName: 'Chinese composition confirmation never becomes a send and normal shortcut resumes afterward',
  },
} as const
