/** Optional native process disclosure driven by each stable group's closed state. */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
export async function applyLiveProcessExpansion(root) {
  const edit = async (file, changes) => {
    const path = join(root, file); let text = await readFile(path, 'utf8');
    for (const [before, after] of changes) {
      if (!text.includes(before)) throw new Error(`Pinned process source changed: ${file}: ${before.slice(0, 80)}`);
      text = text.replace(before, after);
    }
    await writeFile(path, text);
  };
  await edit('packages/client/ui-chat/src/client/presentation-policy.ts', [
    ["readonly virtualizeGroupMembers?: boolean", "readonly virtualizeGroupMembers?: boolean\n  /** Open an untouched active process, then close it when a response ends that process. */\n  readonly liveProcessExpansion?: boolean"],
    ...Array.from({ length: 2 }, () => ["'stepGrouping' | 'virtualizeGroupMembers'>", "'stepGrouping' | 'virtualizeGroupMembers' | 'liveProcessExpansion'>"]),
  ]);
  await edit('packages/client/ui-chat/src/client/chat/ChatGroupSeat.tsx', [
    ['const { expanded: open, setExpanded: setOpen } = useDisclosure()', `const disclosure = useDisclosure()
  const liveExpansion = props.usePresentation(policy => policy.liveProcessExpansion === true)
  const closed = useChatGroup(groupKey, group => group?.data.closed)
  const [manualOpen, setManualOpen] = useState<boolean | undefined>(undefined)
  const open = liveExpansion ? manualOpen ?? closed === false : disclosure.expanded
  const setOpen = useCallback((value: boolean) => {
    if (liveExpansion) setManualOpen(value)
    else disclosure.setExpanded(value)
  }, [liveExpansion, disclosure.setExpanded])`],
  ]);
  const tests = join(root, 'packages/client/ui-chat/tests/chat-view.client.spec.tsx');
  await writeFile(tests, `${await readFile(tests, 'utf8')}${await readFile(new URL('../../source-snapshots/dsh-ext/live-process-expansion.test.txt', import.meta.url), 'utf8')}`);
  const chinese = join(root, 'packages/client/ui-chat/README.zh.md');
  await writeFile(chinese, `${await readFile(chinese, 'utf8')}\n### 可选的实时过程展开\n\n展示策略可同时设置 \`liveProcessExpansion: true\` 和 \`stepGrouping: 'collapsed'\`，使尚未手动切换的当前过程自动展开，并在该过程结束时收起。普通正文出现后，即使整轮仍在运行，前一段过程也会收起。手动开关在该分组的挂载期间优先生效。省略此配置时沿用原有行为；分组身份、成员父节点和阅读锚点保持不变。\n`);
  const readme = join(root, 'packages/client/ui-chat/README.md');
  await writeFile(readme, `${await readFile(readme, 'utf8')}\n### Optional live process expansion\n\nA presentation consumer may set \`liveProcessExpansion: true\` with \`stepGrouping: 'collapsed'\` to open each active process until its own group becomes closed. An ordinary response closes the preceding process even while the Turn remains open. Explicit user disclosure choices take precedence for that group's mounted lifetime. Omitting the option preserves existing DSH behavior; group identities, member parents and reading anchors are unchanged.\n`);
}
