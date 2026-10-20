# 可复现验证与验收边界

本项目把业务 fixture、真实传输、真实官方进程和真实模型执行分开记录。某一层通过不能替代下一层。

## 本地命令

```bash
npm ci
npm run check
HAPI_DSH_OFFICIAL_TESTS=1 node --import tsx --test --test-isolation=none tests/federation-official.test.ts
npm exec -- playwright install --with-deps chromium
npm run test:e2e
node scripts/distribution-pack.mjs
node scripts/distribution-smoke.mjs
```

测试需要允许绑定本机回环端口。`npm test` 使用 Node 的 `--test-isolation=none`，确保 TypeScript 测试被实际执行并报告 case 数；不要把测试文件进程退出成功当成所有断言已经执行。官方进程测试默认跳过，必须显式设置 `HAPI_DSH_OFFICIAL_TESTS=1`。

## 覆盖层次

| 层次 | 真实运行的部分 | 使用 fixture 的部分 | 能证明什么 |
| --- | --- | --- | --- |
| 配置 / profile 单元测试 | 文件权限、原子更新、参数解析、安装状态机 | DSH launcher 返回值、HAPI auth 响应 | 安装不会覆盖既有 profile；凭据不进 argv 或公共视图 |
| Federation transport | 本机 TCP、HTTP、WebSocket、生产 Hub/Runner 实现 | 小型模拟 DSH 业务服务器 | 字节保真、子协议、认证隔离、流超时、撤销与断线不重放 |
| 官方 federation 集成 | 固定官方 DSH npm 包、官方 Web profile、官方 plugin CLI、生产 Runner 插件 | Hub 侧仅使用简单路由适配器 | 未修改官方运行时可完成安装、图读取、bundle 读取、Session RPC、事件 WS |
| Native / workspace 单元测试 | 本仓库的投影、投递状态机、审批状态机与布局逻辑 | 原生桥历史/队列/审批事实 | 既定契约及错误分支符合预期 |
| 原生历史与官方 Conversation | 已发布官方 bundle 内的真实 `ConversationNodeAssembler`、本仓库投影器 | 原生历史输入；不调用浏览器渲染服务 | 延后补写的元数据不会产生假步骤、破坏最终回答的边界 |
| Playwright E2E | 浏览器、构建后的插件、官方 DSH 页面 | 测试文件明确声明的 HAPI/模型输入 | 页面集成、统一工作区交互与真实浏览器行为 |
| 发行包安装 | 干净目录中的 npm 运行依赖、已打包 CLI、官方主/Runner profile | 不联网的 HAPI 地址与临时配对身份 | 安装包不依赖开发目录，配置与配对 CLI 可复现 |
| 部署验收 | 实际 HAPI Hub/Runner、Codex app-server、模型提供方 | 无 | 指定机器、凭据、模型、文件系统与网络组合能完成真实任务 |

## 本次执行结果

在 Linux、Node 24.19.0、固定官方 DSH `0.2.1-rc.2` 上完成以下检查。浏览器使用 Playwright 1.56.1 的 Chromium；所有官方 DSH 代码均来自锁定的原始发行包。

| 命令 / 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | Host、Client 和 E2E 三个 TypeScript 项目通过 |
| `npm test` | 146 项：145 通过，0 失败，1 项官方进程测试因需显式启用而跳过 |
| 显式启用 `tests/federation-official.test.ts` | 1 通过，0 跳过 |
| `npm run build` | Host、Client、独立 Runner、CLI 和类型声明构建通过 |
| `npm run test:e2e` | 5 条浏览器流程通过，0 失败；最终完整运行 55.6 秒 |
| `node scripts/distribution-pack.mjs` | 163 个包内文件审计通过；生成 `hapi-dsh-0.1.0.tgz` 与 `SHA256SUMS`，包含完整源码、构建入口及上游许可证 |
| `node scripts/distribution-smoke.mjs` | 干净临时目录安装发行包及运行依赖通过；已打包入口导入、官方主/Runner profile 安装、离线 doctor、配对凭据脱敏及撤销全部通过 |

测试覆盖私有文件权限、并发身份迁移、进程退出后的锁接管、profile 保护、代理 trust/TLS 参数、原生操作的持久回执与未知结果、布局 CAS 冲突，以及真实官方 store 的跨 graph 存储隔离。原生历史回归直接使用官方 `ConversationNodeAssembler`，确认辅助元数据不会制造假步骤或隐藏最终回答。

Federation transport 测试覆盖超过 1 MiB 的原始字节传输、插件路径、双向文本/二进制 WebSocket、非首选子协议、握手拒绝后的通道释放、持续事件流、断线不重发和凭据撤销。单独启用的官方集成测试实际复制 Web profile、安装 Host-only Runner、读取真实插件图及 Conversation bundle、调用 Session list 并打开 `$events`。Runner 图没有误装根工作区 Client。

发行包安装测试先验证 SHA256，再清空 `NODE_PATH`、`DSH_HOME` 和 HAPI 配置环境变量，以 `npm install --omit=dev` 安装实际 tarball。主插件、SessionController provider 和 Runner 三个已打包 Host 入口可独立导入；官方 CLI 创建主 profile 与仅 Host 的 Runner profile，离线 doctor 检查固定 DSH 版本、构建文件和安装状态。临时配对凭据未出现在公开配置中，撤销后配对表为空，测试结束清除临时安装目录。该步骤没有连接真实 HAPI 或调用模型。

### 五条真实浏览器流程

1. 同一个侧边栏列出原生 Codex 与远端 DSH；官方 Conversation 同时渲染两种会话，分屏尺寸和布局刷新后恢复。审批提交与原生最终解决分开，SSE 重连后可取消排队输入、发送并展示原生响应。
2. 远端窗格经过生产反向通道调用真实官方 AgentLoop；打开所属 Host 的官方 Settings、用 Escape 关闭、切换 Plugins 页面，再返回 Conversation。
3. 原生推理强度和服务级别设置、映射到真实 native 边界的分支，以及带机器/home/目录的新建流程；空原生 thread 可以直接从官方 composer 发出第一条消息。
4. 官方 New Session 入口进入统一创建界面，在目标 Host 登记 Workspace 并创建普通 DSH 会话；选择模型、提交 prompt，并在官方 Conversation 展示 AgentLoop 响应。
5. 对源发布的 Codex 计划提案执行一次；刷新后仍恢复同一排队回执，不重复提交；源消费队列后显示已调用状态及响应。

浏览器断言检查统一侧边栏、没有 iframe、可见回答和未捕获页面异常。DSH 的模型输入来自明确标记的测试 provider；HAPI 原生桥和 Codex 事件也来自 fixture。真实官方进程、浏览器、生产插件及 Hub/Runner 通道不会因此变成真实 Codex app-server 或真实模型执行的证据。

启动恢复或切换焦点时，固定版本的官方右栏偶尔会打印 `Sidebar Session opening failed: … is released`：这是 `sidebarView` 在打开完成前被正常取消后的日志。工作区窗格持有独立引用，以上流程确认可见会话仍能发送与恢复；本插件没有为消除该日志修改或拦截上游代码。

当前分发不宣称已经使用用户的 Codex 登录、实际 app-server 和模型凭据完成在线部署验收，也不宣称全部第三方 DSH 插件都通过兼容认证。后续提交的精确结果以对应 CI artifact 为准。

## 真实部署验收清单

发布候选版本至少在一套实际 HAPI/DSH 环境中验证以下用户路径，并把版本、平台及结果附到 release notes：

1. 同一侧边栏同时列出本机 DSH、远端 DSH 与原生 Codex；跨机器同名或相同原始 ID 的会话保持独立。
2. 在一个工作区分屏混排不同引擎会话，关闭、恢复、切换窗格后实际执行继续；刷新浏览器后布局恢复。
3. 原生 Codex 启动真实 turn，正确展示文本、工具、文件/图片；审批答案最终由原生事件确认。
4. 运行期间发送排队输入、steer、cancel，核对实际 app-server 状态；人工制造响应丢失时界面显示不确定结果，不重复执行。
5. 中断 HAPI 与 DSH Runner 网络，再恢复；目录和视图恢复，未确认操作不会被后台盲目重发。
6. 用官方插件管理器安装实际要分发的插件，验证它在所属 Host 的会话、设置与 Remote API 上运行；依赖页面级注入的插件单独记录。
7. 从 GitHub Release 的 `.tgz` 在干净机器安装，完成 init、doctor、主 Host 启动、配对、Runner 启动及撤销。

CI 自动完成可无凭据复现的门槛。真实凭据验收由部署操作者执行，不把令牌或用户会话录制进公共测试产物。
