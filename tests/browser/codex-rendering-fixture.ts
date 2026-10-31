/** Native item shapes cross the production source adapter before official rendering. */
import { CodexHistory } from '../../src/remote/codex-history.ts'
import { CodexAttachments } from '../../src/remote/codex-attachments.ts'
import type { SourceEventIndex } from '../../src/remote/event-index.ts'
import type { SourceSession, SourceResource } from '../../src/remote/protocol.ts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface CodexRenderingResources {
  read(path: string, signal?: AbortSignal): Promise<SourceResource>
  dispose(): Promise<void>
}

export async function seedCodexRendering(index: SourceEventIndex, metadata: SourceSession): Promise<CodexRenderingResources> {
  const directory = await mkdtemp(join(tmpdir(), 'hhpi-codex-rendering-')), lifetime = new AbortController()
  const imagePath = '/synthetic/1700000000000-00000000-1111-2222-3333-444444444444-Screenshot.png'
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC'
  const attachments = new CodexAttachments(index, directory, async path => {
    if (path !== imagePath && path !== '/synthetic/preview.png') throw new Error('Unknown synthetic source image')
    return { dataBase64: png }
  }, lifetime.signal)
  const history = new CodexHistory(index, {
    userContent: (turnId, item) => attachments.content(turnId, item),
    toolContent: (turnId, item) => attachments.content(turnId, item),
  })
  history.acceptTurn(metadata, {
    id: 'pretty-native-turn', status: 'completed', startedAt: 1, completedAt: 2,
    items: [
      { id: 'pretty-user', type: 'userMessage', content: [
        { type: 'text', text: 'Inspect README.md and update the synthetic source file.' },
        { type: 'localImage', path: imagePath },
      ] },
      { id: 'pretty-command', type: 'commandExecution', status: 'completed',
        command: '/bin/bash -lc \'cat README.md\'', cwd: '/synthetic',
        commandActions: [{ type: 'read', name: 'README.md', path: '/synthetic/README.md' }],
        aggregatedOutput: 'Native command output from the source.', exitCode: 0 },
      { id: 'pretty-file', type: 'fileChange', status: 'completed', changes: [
        { path: '/synthetic/src/sample.ts', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-const oldValue = 1;\n+const newValue = 2;\n' },
      ] },
      { id: 'pretty-failed-command', type: 'commandExecution', status: 'completed',
        command: '/bin/bash -lc \'cat missing-file.txt\'', cwd: '/synthetic',
        commandActions: [{ type: 'read', name: 'missing-file.txt', path: '/synthetic/missing-file.txt' }],
        aggregatedOutput: 'cat: missing-file.txt: No such file or directory', exitCode: 2 },
      { id: 'pretty-image', type: 'imageView', status: 'completed', path: '/synthetic/preview.png' },
      { id: 'pretty-agent', type: 'subAgentActivity', kind: 'started', agentThreadId: 'synthetic-child-thread',
        agentPath: 'render-review', model: 'native-fixture', reasoningEffort: 'medium' },
      { id: 'pretty-result', type: 'agentMessage', text: 'Synthetic Codex rendering completed.' },
    ],
  }, true)
  for (const state of await attachments.enrich(index.read({ sessionId: metadata.id, limit: 160 }).entries)) {
    history.acceptItem(metadata, state.turnId, state.item, state.completed)
  }
  return {
    read: (path, signal) => attachments.read(path, signal),
    async dispose(): Promise<void> { lifetime.abort(); attachments.revoke(); await rm(directory, { recursive: true, force: true }) },
  }
}
