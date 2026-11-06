# Codex 原生能力接入

基准是已安装并执行验证的 `codex-cli 0.165.0`，不是 GitHub main 的所有未来功能。接口清单来自官方二进制的 `codex app-server generate-json-schema --experimental`；上游为 https://github.com/openai/codex ，Apache-2.0。清单位于 `src/remote/codex-methods.ts`。

本次在 HHPI v1 增加可选字段及原生能力方法，不采用 AHP。旧的目录、读取、发送、插话、取消和审批路径保留。新旧 Host/Runner 需要按原发布流程升级后才能使用新增方法；这不承诺旧 strict codec 能接收所有新字段。

## 两个授权范围

原来的 `hhpi/operate` 仍按确切会话授权，图片和结构化回答也沿该会话归属处理。普通 DSH 来源不自动获得这些新输入类型。

`nativeCapabilities`、`nativeCall`、`nativeReceipt`、`nativeReply`、`nativeEvents` 必须获得对应 `hhpiSource` 的方法授权。只有一个会话的权限，不能借原生接口读取其他会话、账号、配置或源端文件。调用前和释放结果前均检查授权。

原生请求沿当前 Codex 连接执行，由原生协议校验参数、沙箱、审批和执行所有权。已知方法清单表示可路由，不表示当前账号、平台、配置或服务支持该操作。原生拒绝保留错误代码与结构化数据，界面不伪造成功。

## 覆盖范围

| 范围 | 本次接入 | 用户界面及验证边界 |
| --- | --- | --- |
| 176 种客户端请求 | 169 种原生方法可通过源级接口调用 | 不是 169 个界面功能逐项实测 |
| initialize | 由 HHPI 自己完成握手 | 不允许客户端重复初始化共享连接 |
| mock/experimentalMethod | 不开放 | 上游测试接口 |
| 5 种 userVerification 方法 | 不开放 | 需要可信本机平台 UI，不能用远程表单冒充设备验证 |
| 模型、推理强度、权限配置、Fast | 原生目录、thread/settings/update、thread/read、settings 通知 | 复用现有输入区选择器；不使用本地 DSH 模型 owner |
| 计划模式、压缩、审查、分支、重命名 | 原生 API | 原输入区更多菜单；审批与运行结果仍由 Codex 决定 |
| 用户提问、权限申请 | 保留请求 ID、连接代际、结构化回答 | 原生提问表单；未知结果不重发 |
| MCP elicitation | 原生应答 | 标准字段表单和 URL 流程；专用复杂表单/设备验证仍需对应原生界面 |
| 图片输入 | 原输入框 → 会话操作 → Codex image input | 数据由原提交持有，使用原生 clientUserMessageId；有界消息尺寸 |
| 普通文件上传 | 原生 fs/createDirectory、fs/writeFile | 已获批准的可选上传 provider 保留原附件按钮；每个文件上限 6 MiB，返回仅限原会话的回执，提交时将源端文件路径作为原生文本输入，不冒充 Codex 的图片或技能类型 |
| 子会话 | 原生 parentThreadId、agentNickname | 通过官方目录 parentId 与 subagentCatalog 展示，不读子正文猜关系 |
| 队列、goal、文件、终端、MCP、skills、plugins、账号、配置、实时音频等 | 清单中的原生调用和通知可路由 | 各专用 UI 尚未全部适配；传输接入不能替代对应 UI 与真实行为验收 |
| 动态工具调用、令牌刷新等反向请求 | pending 快照和 nativeReply | 由有源级授权的能力处理器接手；普通审批按钮不能回答这些请求 |

## 写入和重连

每个原生写入必须带稳定 operationId。复用已有持久化写前回执：先写不确定标记，再进行原生调用。丢失确认后只查原回执，不自动重放。相同 ID 携带不同方法或参数会被拒绝。敏感原生响应只在有界内存缓存中保留；重启后可以返回已接受但结果正文不可恢复，不重新执行以换取结果正文。

原生反向请求绑定连接代际。断线清理 pending；旧请求不能响应到新连接。请求结果和原生最终审批解决分开处理，已送出回答不等于原生操作已经完成。

设置 UI 保留确认值及待确认修改。原生通知或 readback 使展示值收敛；字段相等只说明当前设置符合用户选择，不证明某个未知写入的因果身份。

`nativeEvents` 返回 generation、cursor、reset、事件和当前 pending。最多保留 512 个事件、2 MiB；断档或换代显式要求重新读取原生快照，不把丢失的增量当成连续流。原生事件缓存只在近 30 秒有读取者时启用，正常聊天继续使用已有 HHPI 正文流。

## 证据

新增 Node 契约覆盖源授权、重复写入、未知结果、敏感响应不落盘、原生错误数据、事件断档和旧代请求。组件测试覆盖结构化回答及设置 confirmed/pending。

`HHPI_CODEX_TEST_COMMAND=/home/chris/.local/bin/codex node --import tsx --test tests/hhpi-codex-access.test.ts` 使用实际 Codex 0.165.0、隔离 home 和合成模型服务。验证原线程设置修改/readback、修改设置不发送提示词，以及原生图片提交接纳。它不证明真实外部模型的视觉理解，也不证明所有 169 种方法的业务行为。

发布结果另以本次检查、线上版本核对和有界浏览器报告为准。

普通文件上传使用 `client-file-upload.registerProvider`。没有匹配来源的普通 DSH 会话继续走原上传路径；匹配来源失败不会回落到本地 Agent。源端文件位于原工作目录的 `.hhpi/uploads/<upload-id>/`，上传不会启动模型；用户提交后才进入原生消息。取消或未发送的文件可能留在该目录，本次不自动删除源文件。

本次发布验证：2095 项 Node 测试、48 项组件测试、6 个故障演练通过；DSH 上传 provider 的 15 项测试及 Host/Client aggregate build check 通过。实际 Codex 0.165.0 在隔离目录中完成文件写入、直接文件 readback、上传不触发模型，以及文件回执随原生消息提交。模型服务仍为合成 fixture。

桌面与手机浏览器均打开原模型菜单，菜单处于视口内；原文件选择器各触发一次 HHPI 上传请求。浏览器上传回执在探针中模拟，未上传到生产源端，也未发送生产消息。两者均连续读到六段更早正文，回到底部后的缓存阅读没有新增取页。完整场景仍因 80 ms 性能门槛失败：最大帧间隔分别为 83 ms、117 ms；不能据此宣称滚动性能验收通过。物理手机键盘未测。
