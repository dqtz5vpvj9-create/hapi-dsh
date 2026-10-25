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

## Current-stage validation rule (2026-10-23)

- 用户已将 UI 和性能验收交给 Agent；由 Agent 运行浏览器交互、过程采样及必要的视觉检查，修复失败项，不再把测试留给用户。
- UI 改动使用常驻官方 DSH Host 和 Chromium 的快速验收流程，覆盖打开正文与输入框、上下翻历史、锚点、实时更新、多 Pane、草稿及手机布局。指标与运行方法见 docs/ui-acceptance.md。
- 类型检查、逻辑测试、构建、合成浏览器、生产及真机结果分别报告。测试超时、未覆盖或未测均不算通过；报告原始采样、失败项和测试环境。
- 仅改前端时使用客户端发布流程，保留 Host 和原生执行。性能测试串行运行；复用测试环境，避免每个用例重新安装依赖、启动 Host。
- 使用合成会话进行发送、审批、弱网等破坏性测试；生产探针保持只读。保留已有认证、数据安全和发布约束。

## Collaboration responsibilities

- Work only in the files assigned to your task; coordinate shared contracts with the root agent.
- Leave each component typechecked and tested for its meaningful failure modes.
- Keep dependencies exact and record upstream provenance and licenses.

## Immediate publication (user instruction, 2026-10-24)

- 本项目每次修改完成后立即发布到当前线上站点，发布属于任务的一部分；用户已持续授权，无需再次确认。
- 使用与修改匹配且已通过验收的构建，发布后核对线上版本和实际界面。已有历史缺口尚未清零，不是将已验证修复留在本地的理由。
- 保留现有认证、原生执行和发布保护。仅前端改动不重启 Host；Host 改动沿用运行中普通 DSH 会话检查，并保留旧构建供失败时恢复。
- 发布或验收失败时继续处理并报告真实状态，明确区分已提交、已上线、已验证和仍未解决。
