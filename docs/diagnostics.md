# 诊断输出层

页面右下角的 `诊断 N` 入口聚合浏览器侧可解释的失败，用于让用户把一次真实问题的证据直接复制给维护者；它不是聊天记录的一部分，也不替代 Host/Runner 日志。

## 采集范围

条目按字段 allowlist 逐条构造，默认只存在内存（环形缓冲 300 条，刷新即清空）：

| 字段 | 内容 |
| --- | --- |
| 时间 | 记录时刻（浏览器本地时间） |
| method / route | RPC 方法名与 **path-only** route（不含 query/fragment） |
| status / code / requestId / outcome | HAPI/remote 响应状态、业务 code、request id、结果分类 |
| duration / timeout / abort | 耗时与是否超时/主动中止 |
| retry-after | 服务端建议的重试等待（若提供） |
| connection | 连接状态迁移（只记状态变化，不记 payload） |
| pagination | direction、cursors、epoch、reset、hasMore（供历史分页事件） |
| 身份 | 该条目发生时所属的 hub / host / session / source session / machine / engine，按每次记录时的 pane api 实例取值，不使用页面级可变 context |
| build | 构建 ID、hapi-dsh / DSH / HAPI 版本 |

明确不存：请求或响应 body、prompt、消息正文、文件内容、cookies、authorization、URL query 与 fragment、console 原文、错误 message/stack。console 钩子只是受保护的透传，并只记录固定分类（如 connection/request/render）与 `Error.name`。

## 入口与操作

- `诊断 N`：仅在缓冲非空时出现，低视觉权重。
- 抽屉：逐条展示上述字段，支持 `复制全部` 与 `清空`；复制内容包含 build 与版本头，末尾再做一次 token 形态的防御性擦除。
- 数据属性 `data-hapi-diagnostics-chip|drawer|copy|clear|entry` 供定向 e2e 使用。

隐私边界按 review 结论执行：不做 payload 级别的“智能脱敏”，而是根本不采集可能含敏感内容的字段；URL 只保留 path，避免把登录 token 或用户查询写进可复制文本。

## 与对话内错误的分工

- 正文里保留真实 agent/tool 错误与 compaction 等源事件，并按 turn 归位；重复的源错误折叠为 `源错误 · N` 一行，展开仍是原始事件。
- approvals、已提交未决的 answer、indeterminate 的 delivery/plan/setting receipt、可操作的发送失败，留在 composer 附近可见，不能被折叠或诊断层替代。
- 传输失败、重试、堆栈、重复轮询错误与连接迁移属于诊断层，不进入正文。

## 验证边界

- 单测覆盖 allowlist 构造、token 擦除、环形缓冲上限与事件分类（`tests/source-diagnostics.test.ts`）。
- live 探针中止一次 `hapi/nativePlan` 后，`诊断 N` 出现，抽屉显示 build/版本/身份与 `[source · source.plan]`、`[remote · remote.rejected]` 条目，复制按钮可用；探针没有发送消息、没有修改源数据。
- 未接入浏览器侧分页事件的自动上报：HAPI 历史分页在 Host 侧执行，证据以 Host 日志与本仓库的 history reader 单测为准，`recordPagination` 只作为已导出的钩子保留。
