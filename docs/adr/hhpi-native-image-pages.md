# 原生超长图的源端输入页

状态：实现。发布与真实模型验收分别记录。

两张上传的源文件为 1216×37686、1216×30029；原 operation 关联的是这些全尺寸文件。运行中的 Codex 0.162 将无 detail 的 localImage 转为 66×2048、83×2048，已送历史也引用相同小图。已安装 CLI 0.165 不代表原 daemon 已升级。`detail:original` 可保住原生队列像素，但当前 Astra 配置仍在模型请求前缩至 194×6000。已有 thread 的 queue/steer 没有可安全单次启用该 feature 的接口。

新发送沿现有 receipt → session → clientUserMessageId 关联，在实际文件 owner 内建立不可变派生计划。每页最多 6000×6000，沿 EXIF 显示方向裁取，相邻页重叠 128px；不缩放文字像素。不透明图页编码为 WebP95，透明图保留 PNG。原图文件和上传结果不变，uploadInputs 仍一 receipt 返回一个 plain localImage。仅 source dispatch 展开图页并加 `detail:original`，admission params、operation fingerprint 与旧 operation 输入不变。恢复复用原计划和文件 SHA，不给已受理的旧 operation 加页或重发。

每次新 operation 最多 32 页、编码合计 11MiB，超预算在派发前明确拒绝，不缩宽或丢页。两张真实 JPEG 产生 13 页、84,053,568 像素、10,502,652 编码字节，native 单条 base64 响应约 14.0MB，保留 16MiB 帧限制。queue/list 逐条读取，游标预算仍为原先最多 1600 条；有派生计划的会话历史按单 item 读取，普通会话保留原批量读取。

自有 queue-view 在同 session/clientId 且全部图页 SHA、顺序匹配后，返回既有 source-local 页引用和可选 `presentationContent`。原生队列不改。官方 QueueDock 使用两个原图引用，真实编辑/steer/恢复用同一规范化输入核验身份，dispatch 再校验本地页字节并保留 original。正文只合并一次，交错文字、普通文件和未管理图片继续使用原投影。原图资源沿同 session 的既有上传 receipt 索引读取，并复核 SHA/bytes；未知图片仍走原 reader。

仅真正 `localImageFiles=true` 的 source 执行这些文件操作；中央转发 Windows native transport 没有该 OS 的文件所有权。普通 DSH 与未升级 source 不执行此策略。无需 SDK 或 HHPI v1 协议版本变更；queue-view 的可选展示字段属于现有 HHPI 自有适配结果。

Sharp 0.35.5 已是 DSH attachment-local 的固定依赖，本插件显式声明直接依赖以使用公开裁图 API，Apache-2.0。发布包需在实际 Linux/Windows consumer 验证 native module 可加载，不能只验证开发 checkout。

验证使用同一运行 binary 0.162、实际 Astra cached metadata、无额外 image feature 开关，模型 HTTP 为既有 loopback fixture。双 operation 同时排队、原输入不变与 receipt 重查、编辑后运行中 steer、模型请求 13 页宽高/SHA/顺序均通过；外部模型调用为零。该证据不代表商品文字 OCR。原全尺寸文件仍在，旧队列和已发历史小图均不自动恢复或重发。
