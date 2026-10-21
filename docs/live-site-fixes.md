# 实际部署反馈后的功能修复

用户的真实界面反馈暴露了此前验收的缺口：页面能加载、目录里有会话，不等于聊天正文、旧工作区资源和操作入口可用。本页区分已经确认的代码缺陷、使用真实官方浏览器的验证，以及尚未在用户部署中证实的结果。

## 已确认并修正的缺陷

| 界面问题 | 原因与修复 |
| --- | --- |
| 旧窗格长期提示原会话不可用 | 恢复只依赖全量目录按顺序导入。现在按原 Hub/session 精确读取并挂载该源，等待本 Client 的官方 projection 确认后恢复原资源。不会为了打开视图启动或恢复模型进程。 |
| 加载中的同名源可能绑定错 Hub | 旧 HAPI v2 布局没有 Hub 字段。现在先等配置源的真实 catalog 确认 Hub，再补齐身份；其他 Host 先到不能成为默认来源。 |
| 授权文档显示目录外拒绝，或聊天离线后无法预览 | 文档误用只供在线会话、范围限于 cwd 的管理接口。现在预览、下载、文件变化使用原 `/file` 与 `/file-info`，由源 Runner 的 browse roots 授权。目录和写入仍保留各自原契约。 |
| Codex 生命周期 JSON 被打印成聊天 | observed 解析器没有识别 `native-turn`，落入未知事件展示。现在将其作为原 turn 的生命周期事实，并在已知内容之后结算该 turn。 |
| 已完成的 observed Codex 答案被当作持续流 | `streamSnapshot` 表示累计快照，已完成历史也会保留这个字段。现在结合原生执行元数据和稳定 `localId` 判断完成，不再仅依赖该 flag。 |
| “展开详情”没有详情可看 | 原事件的 `details` 在适配层被丢弃。现在保留白名单字符串字段，错误摘要可见，原详情可以展开。 |
| 长历史第一页携带全历史的注释记录 | 原生、observed 的 detached seed 把所有插件记录堆到末尾。现在每条注释跟随对应消息进入历史页，保留原时序与来源，不再重复加载整个历史的注释。 |
| 每个窗格重复一排 Host 控件 | Host Settings、插件页面与视图切换移到现有窗格菜单，保留各 graph 的官方 launcher 与原插件注册表；手机使用当前窗格的底部菜单。 |
| 小号等宽字、内部 provider ID 和模型 JSON 外露 | 自有工作区控件使用官方字体 token 与系统中文字体回退；删除指向不存在 DSH preset 的错误元数据，保留真实引擎标识；DSH 模型 tuple 按其实际格式显示模型名。 |
| 安装浮层挡住内容 | 取消自动推送安装浮卡，设置中的显式安装、通知与更新入口保留。 |
| 离线原生会话一直提示“正在重新连接” | `disconnected` 还包括未运行的历史会话，并不证明正在自动恢复。现改为“Codex 尚未连接，草稿已保留”，由用户使用已有恢复入口。 |

源会话恢复及 154 个会话的测试边界见 [目录恢复](catalog-recovery.md)。文档读写权限与官方插件职责见 [文件和终端适配](feature-parity-workbench.md)。整个修复使用固定 DSH 的公开 provider、Slot 与 Session 契约，没有改动其上游源码或 bundle。

## 原生聊天整段空白的结论边界

已经用 pinned HAPI 的 indexed wire 形状构造 180 轮、4500 步历史，通过未修改的官方 Conversation 打开并刷新，实际用户消息和最终答案可见。修复前的投影器也通过了这一复现。因此 **历史长度或末尾注释堆积不能单独解释用户截图中的整段空白**，本仓库不将分页优化写成该线上问题已被定因或修好。

已核对 pinned HAPI 的 indexed 和 fallback 历史：它们都生成稳定 `localId`；四种原 envelope 封装与内外两处 native execution 元数据均有对应解析。没有为制造“修复成功”而把未完成 snapshot 当作完成消息。进一步定位需要实际问题会话的结构计数和客户端历史窗口证据；原始正文、账号、路径和登录链接不应成为公共回归数据。

仓库提供[只读历史结构诊断](source-history-diagnostics.md)，只输出固定分类与数量，不输出正文、工具结果、原身份或路径。原 HAPI 的 JSON 导出只是 Hub 消息库快照，并不保证包含实际 native RPC 历史；诊断与报告明确保留这一区别。另有 `--native-pages` 模式直接检查在本机捕获的原 `/messages` 响应、可选请求游标与 epoch 链，并分别报告队列 overlay、解析候选及分页异常；不混合不同代的历史，不要求上传原始消息，也不把离线捕获称为实时界面已通过。

## 验证与部署

新专项使用真实官方 Host、插件 Loader、Conversation、Markdown、PDF、Terminal 与 Chromium；HAPI 历史、文件、机器和模型数据均是明确的合成源协议 fixture。实际运行结果统一记录在 [验证记录](validation.md)。这些测试不会被描述成已读取用户的私人目录或完成其线上模型调用。

用户已有的三条 UUID、5 秒 Host 启动预算、Live E2E 修复保留在提交历史中。UUID 继续使用其 `randomId()` API；Notice 测试使用实际完成过的 Host 确认，避免误把工作区外框出现当作弹窗处理完毕。

`e2e/live-site.spec.ts` 保留 `HAPI_DSH_LIVE_URL_FILE` 入口。基础用例明确标为 availability smoke；它只能证明登录、UI 与源目录可达。另一个用例需要 `HAPI_DSH_LIVE_SOURCE_SESSION_ID` 指定一个已存在、列表可见且有正文的原 HAPI 会话，实际打开官方聊天正文、检查空间并刷新再读。它不会发送聊天、恢复进程、批准请求、写文件或输入终端。测试默认关闭真实站点的录屏、trace 和内容截图，不把私人页面自动写入可共享产物。

```bash
HAPI_DSH_LIVE_URL_FILE=/private/path/to/launch-url \
HAPI_DSH_LIVE_SOURCE_SESSION_ID=original-hapi-session-id \
npx playwright test e2e/live-site.spec.ts --workers=1
```

当前开发环境未能连接用户的 Tailnet 站点，未执行其登录链接或真实源会话验收。发布源码与已经更新常驻 Host/Runner 是两件不同的事实；本页不声称已部署到该站点。
