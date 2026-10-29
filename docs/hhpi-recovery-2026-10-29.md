# HHPI 工作区恢复记录

状态：部分源码恢复，WIP，不可发布。基线为 `034317c9ace1ca93db69fdf80b4dcb178fbfeef1`。

## 恢复范围

2026-10-29 用户要求立即提交上一轮实现。当前执行环境无法访问上一轮工作区，远端 main 仍停留在基线。本分支保存从上一轮实际文件读取输出中恢复的源码，避免继续仅依赖临时工作区。未覆盖 main，未部署生产。

已恢复到原路径的文件：

| 文件 | 恢复内容 |
| --- | --- |
| `src/client/remote-history.ts` | 共享源缓存、独立 Pane 历史窗口、补页去重、版本与取消处理 |
| `src/client/remote-sessions.ts` | 远端 Session 适配、会话目录、引用生命周期与源操作路由 |
| `src/client/remote-reading.ts` | 使用官方 mounted reader 的 Pane 导航 |
| `src/client/remote-controls.tsx` | Steer、审批和操作回执控件 |
| `tests/hhpi-history.test.ts` | 六项历史行为测试源码，源端 wire 为明确 fixture |
| `src/remote/protocol.ts` | 可找回的较早协议文件快照 |

协议快照早于客户端最后一次修改，尚缺客户端引用的 `SourceReadRequest.around` 和 `isSourceSessionId` 等后续变更；`src/hhpi-api.ts` 也未恢复。文件按可核实原文保存，未修补这些缺口以冒充原始最终实现。此分支不是完整、可构建的 HHPI。

## 未恢复的实现

上一轮状态清单还列出网关、直接 Codex 适配器、HHPI Remote API、源作用域保护、无 HAPI 配置与启动修改、安装脚本、DSH 集成及相关测试。其完整最终内容目前不可访问。未用推测代码替代，也未将基线原文件当作已恢复修改。

上一轮记录中的主要待恢复路径：

```text
package-lock.json
package.json
scripts/build.mjs
src/cli/config.ts
src/cli/doctor.ts
src/cli/index.ts
src/cli/login.ts
src/cli/runtime.ts
src/client/index.ts
src/client/pane-native.ts
src/client/source-sessions-provider.ts
src/client/source-sessions.ts
src/client/surface/session-view.tsx
src/codex/session-controller.ts
src/hapi-agent/subagent-controller.ts
src/hapi/file-references.ts
src/hapi/terminal-controller.ts
src/hapi/workspace-files.ts
src/index.ts
src/runner/config.ts
src/runner/identity.ts
tests/codex-session-controller.test.ts
tests/config-private.test.ts
tests/config-recovery.test.ts
tests/federation-official.test.ts
tests/hapi-file-references.test.ts
tests/hapi-machine-terminals.test.ts
tests/hapi-workspace-files.test.ts
tsconfig.client.json
tsconfig.host.json
config/hhpi.example.json
scripts/install-dsh-ext.mjs
src/hhpi-api.ts
src/remote/codex-adapter.ts
src/remote/codex-history.ts
src/remote/ 中其余新增文件
src/shared/source-access.ts
tests/codex-direct-native.test.ts
tests/codex-direct.test.ts
tests/federation-bundled-identity.test.ts
tests/federation-no-hapi.test.ts
tests/hhpi-gateway.test.ts
```

## 验证状态

本次仅恢复和保存源码。类型检查、单元测试、完整构建、干净安装、真实 DSH/Codex 接入、浏览器连续阅读、实体设备和生产发布均未执行。上一轮存在六项历史测试通过的执行输出，但该历史结果不构成本恢复分支的验证结果。

当前环境为 Node 22.16.0，缺少本项目要求的 Node 24 及已安装依赖；容器 git clone 还遇到 GitHub DNS 解析失败。提交通过已连接的 GitHub API 完成。当前分支不得合并或发布为已验收实现。
