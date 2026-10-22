# HAPI DSH integration

## Goal

Build a distributable DSH plugin composition with one cross-machine session sidebar, the HAPI tmux-style workspace, official DSH Conversation for all supported sessions, and native Codex thread execution through the existing HAPI bridge.

## Constraints

- Do not edit, patch, monkey-patch, or vendor a modified DSH implementation. Use supported plugin registrations, providers, slots, and profile configuration.
- Preserve native Codex thread identity, original execution ownership, native queue, final approval resolution, and reconnection semantics.
- Closing a pane releases a view and must not terminate its native execution.
- Keep all engines and machines in one sidebar. Do not use separate machine applications or an iframe per machine.
- Reuse official DSH Conversation and plugin infrastructure; do not create another generic chat renderer or plugin manager.
- No secrets, user data, installed credentials, or private configuration in source, examples, tests, commits, or logs.
- A claimed integration must execute against the pinned upstream version; tests using fakes must be identified as such.
- The user explicitly authorizes implementation, a new public GitHub repository, and publication of the result. No changes to upstream repositories are authorized.

## Current-stage validation rule (2026-10-22)

- 当前阶段由用户直接验收上线后的界面。Agent 不运行浏览器界面测试、截图或视觉检查，也不把这些检查作为上线门禁。
- Agent 完成类型检查、必要的逻辑测试和构建后，按现有部署流程上线；只核对服务启动与 HTTP 可达性。交付时明确说明界面尚未由 Agent 验收。
- 此阶段规则优先于历史交接文档中关于定向 E2E、截图和界面验收的要求；保留已有认证、数据安全和发布约束。

## Collaboration responsibilities

- Work only in the files assigned to your task; coordinate shared contracts with the root agent.
- Leave each component typechecked and tested for its meaningful failure modes.
- Keep dependencies exact and record upstream provenance and licenses.
