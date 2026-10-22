# 启动、窗格与 composer 反馈（2026-10-22）

本批接在 `58800d1` 之后：普通 URL 已默认使用共享 Host graph，生产 source service 已显式启用 tail-first seed。以下区分用户报告、实际代码变化和本地合成验证，不将占位布局或旧版本测试计作新版本正文可用。

## 六项反馈与本批范围

| 反馈 | 本批变化 | 尚需区分的边界 |
|---|---|---|
| 新 split 首次 body 约 1.9 s、composer 最差 2.4 s | 每 Host 最多保留 5 个最近会话，最多 2 个 pending retain；首屏后预备公开 Conversation binding；sidebar hover/focus 提升对应预热优先级 | 这些数字来自用户的生产观察。预热不等于新 session editor 已挂载，尚未证明生产首开目标达标 |
| 冷启动 workspace 约 9 s | HTML 层先显示已保存的当前窗口几何，再启动未修改的官方 entry module | 这是提前反馈，不能算作真实 workspace、正文或 composer 可用；实际 graph 启动成本仍在 |
| 隐藏 pane 长时间显示 loading | 隐藏且尚无 Session reference 的 pane 显式标为 deferred，不挂 loading；首次可见再绑定 | 已挂载后隐藏的 view 继续保留，避免切窗口丢草稿和滚动 |
| 上一轮在初始 retained window 外 | 首次可见并完成首屏后，通过官方公开 `loadOlder()` 最多补 2 页，直到至少有两个 Turn 起点 | 超大 Turn 可能超过两页；Host 尚未 backfill 的行不能从 Client window 中提前取出 |
| 模型与权限界面 | 源会话使用模型 capsule、两页 popover、effort 滑杆/stops、能力允许时的 Fast，以及独立权限 capsule | 普通 DSH 会话保留官方设置逻辑；voice、Schedule、Goal 等后续功能不在本批完成范围 |
| 每份 spec 重启官方环境 | 新增常驻官方 Host / Chromium 及八检查点 smoke，支持客户端重建后等待官方 HMR 再重载 | 八检查点不是原有八份完整 spec，专项回归仍需按变更选择 |

## 计时定义

必须分别记录下面的时间，不能将它们混称为“打开完成”：

1. **布局反馈**：`hapi:boot-layout`，仅表示 HTML 中有只读布局预览。
2. **实际 workspace**：`hapi:workspace-ready`，实际 `[data-hapi-workspace]` 已有布局尺寸，预览随后移除。它不保证会话正文完整。
3. **正文**：目标 session 的已知正文已在官方 Conversation 中出现。
4. **composer**：目标 pane 的真实编辑器出现并可接受输入。

浏览器 `first-contentful-paint` 也单独记录。首次 Host、已准入页面导航、新 split 和已 warm 切换是不同场景。不能用一个小型本地 fixture 的 warm 数据替代用户远端或大型目录的结果。

## 冷启动诊断

本批开始时对上一版已构建的 shared 路径进行了本地探针：固定官方 DSH，12 个明确的合成 source session，Chromium 禁用页面 HTTP cache；Host 已启动且测试 catalog 已建立。该场景没有生产隧道或真实模型。

| 指标 | 结果 |
|---|---:|
| 实际 workspace 元素出现 | 5,037.4 ms |
| 所记录的主要 plugin/static 资源下载完成 | 718.5 ms 以内 |
| 最大两个主线程 long task | 2,365 ms、1,453 ms |
| CPU profile 中官方语法高亮预热累计 | 约 2,323 ms |
| 第一次打开合成 session：pane / composer / body | 172.8 / 331.0 / 435.1 ms |
| 新 split 打开另一合成 session：pane / composer / body | 80.5 / 126.0 / 172.6 ms |
| 再次新 split：pane / composer / body | 78.2 / 113.8 / 151.2 ms |

CPU profile 中耗时集中在固定官方 Web entry 的 highlighter 初始化及 `codeToTokens` 预热。这个小型 fixture 没有复现用户的 1.9–2.4 s 首开，因而不能据此宣布生产问题解决。资源请求已由当前官方 loader 合并，也不能直接沿用交接中旧页面“58 个单 row 请求”的归因。

代码仍使用未修改的 pinned 上游。布局预览使用公开 `webserver/index-inject` 和 `webServer.tapIndex` 扩展点，将识别到的官方 entry script 暂时设为 inert，两个 animation frame 后用原有属性和 URL 恢复；250 ms 定时器作后备，后台页面立即启动。没有改写官方 JS、Loader、Context 或 service。不同的未识别 carrier 原样通过，`?hapiBoot=off` 可直接关闭这项反馈。

预览只读取现有 layout key，不读取消息、草稿或凭据，不写 localStorage；窗口名用 `textContent`。解析有大小、节点数和深度上限。预览没有假 spinner；15 秒仍未就绪时显示真实 Reload 动作。预览不会赋予自己真实 workspace selector。

## 最近会话与意图预热

`surface/session-warmup.ts` 保持每 Host 5 个 reference、2 个 pending 的上限。目录中的已归档和未知会话不会预热。sidebar pointer/focus 只改变预热顺序，不调用 `openSession`、选择会话、创建 pane 或提交源操作。已排队的目标移到下一可用槽位，正在打开的 reference 不重启。

reference ready 后才准备公开 `uiConversation.binding`，不挂 editor DOM，也不修改 graph 当前导航。Host 销毁、候选被替换、过期异步完成都有引用清理或代际检查。完整 transcript 保留和内存 trim 的边界仍见 [one-graph-spike.md](one-graph-spike.md)。

## 首次上一轮与隔离

完整规则见 [seamless-history.md](seamless-history.md)。初次预取和用户上滚共用 document gate 与每 Host/session 的 20 页预算。使用公开 `loadOlder()`，避免点击官方按钮时调用 `pauseFollowing()`。用户开始阅读、隐藏 pane、失败或达到两页上限后不再继续自动读取。

同一实际 SessionFace 的多个 occurrence 共用单飞计划；关闭一个 pending occurrence 后，其 readiness 成功或失败回调都不能更改存活 view 的计划状态。Host teardown 释放 event、Session、visibility 和 DOM 订阅。

## Composer 的真实控制路径

`composer-picker` 注册公开、session-scoped 的 input bar slots，继续使用现有 NativeControlLedger / ObservedControlLedger 的 operation id、pending receipt 和源确认值。没有 takeover 私有 composer。首次渲染从 projection 读标签；打开 picker 才查询模型目录和设置，避免为每个 pane 首屏增加设置请求。

模型页保留当前模型勾选，effort 使用当前模型支持的 stops；Fast 只在来源支持相应服务级别时出现。权限独立弹层。写操作进行中和 source lock 时禁用相关控制；弹层归属打开它的 pane，焦点移走或 pane 隐藏就关闭。浮层经 portal 挂到同一 document，避免窄 pane 的 overflow 裁切，官方 composer 节点不移动。

## 验证与剩余验收

本批 warm 验证检查点已完成 `check → rebuild-client → check`，两批均 8/8 通过，新增 split graph 请求为 0，Host/browser 始终为同一对进程。测量发生在后续 composer 布局两次修正之前，不代表最终提交精确字节的验证；最终定向回归另见 [validation.md](validation.md)。客户端独立编译 1.349 s，包含官方 HMR 发布确认与页面重载合计 4.288 s；第二批检查 14.930 s。它是更窄的快速反馈路径，没有改变八份完整 spec 的独立启动方式。

第二批的独立导航标记如下。第一批曾与一次 E2E 类型检查短暂并行，主记录采用没有该并行工作的第二批，且完整保留较慢结果：

| 场景 | 布局标记 | FCP | 实际 workspace 标记 |
|---|---:|---:|---:|
| 新 browser context | 84.7 ms | 308 ms | 5,965.4 ms |
| 已保存布局 reload | 154.8 ms | 200 ms | 2,164.3 ms |

首次会话 transcript/composer 检查点在两批分别是 **430 ms / 2,347 ms**。这里包含 Playwright actionability、点击和断言，不是拆开的 click→body / click→composer 探针；它仍表明首次打开的波动没有消失。新 split 检查点第二批为 434 ms，也包含操作和断言。首开与实际冷启动两项仍保留为未完成。

本批最终结果集中记录在 [validation.md](validation.md)。常驻环境的操作、计时范围与测量见 [warm-validation.md](warm-validation.md)。

仍需真实生产测量：新 split 的正文与 composer 分开计时，缓存恢复正文 <500 ms，warm 切换 p95 <150 ms，以及冷 Host / 远端隧道 / 13 pane 恢复。提前反馈不能代替这些验收。共享模式旧 per-pane rich draft 迁移、tail-to-full display 换代的 rich draft / 附件 / scroll 保护仍是既有缺口，见 [live-history.md](live-history.md)。
