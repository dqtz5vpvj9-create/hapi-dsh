# 当前开发对话上传再次失败

内部上传失败诊断已上线，认证入口到 Host 持久 stderr 日志的实际链路已验证。用户于 2026-11-12 07:16:31 UTC 报告的上传失败仍为 **unknown，未修复结案**；本轮 profile 已按 `incomplete` 关闭，work 保留 blocked。诊断上线与用户上传成功分别记录。

最终版本为 source `d3241a83b7cd362f47a7bb32b0bf2c70ad14989a`、release `83bd91924835bd2f28b7ac655d54e535a8544bfccb3de120f0d87d36660e403a`、hostBuild `faba20d64fb2765c73543e060c84504f2acbfacd053248e080cee57473fea26f`，SDK `.29`。精确发布与验证记录见 [publication.json](publication.json) 和 [acceptance.json](acceptance.json)。

2026-11-12 08:18:04.011 UTC，在上述精确 Host 上仅发送一条 `build=development` 的合成 `hapi/uploadFailure` RPC：HTTP 200、`result.ok`、返回 null，真实 Host stderr 新增恰一条固定 JSON，耗时 15ms。08:18:56.587 UTC 的一次最终日志只读检查确认仅此一条合成记录、零条真实错误。没有操作用户附件、重试上传、发送消息或启动模型任务，也未新增浏览器检查。证据见 [live-diagnostic-ingress.json](live-diagnostic-ingress.json) 和 [recent-diagnostics-summary.json](recent-diagnostics-summary.json)。

本轮产品变更仅增加内部失败采集：现有认证 `hapi` namespace 的 `uploadFailure` 方法将固定字段 `stage/source/build/name/code/status` 写入现有 Host stderr；单页限六条/分钟、Host 限三十条/分钟，采集失败静默。Pane 通过共享中央回调上报；source provider 报实际失败阶段，官方 composer 对挂载输入内首次观察到的 error 仅报 `composer-error`，不推断旧 provider 阶段；HTTP append 非 2xx 保留固定 code 与 status。上传准备、压缩、operation、bytes、重试和 UI 行为未改。

已确认的原故障范围：用户明确失败发生在当前开发对话的本机 codex-native 来源。07:35:08 UTC 只读复核仍为 44 条 transfer，最近一条于 07:01:00.178 UTC 完成，`finished/applied` 且 received 等于 bytes；事件时段没有新 begin。08:06:12 UTC 对该精确会话的 `sourceWorkspace/resolve` 只读检查成功，14ms，exactTarget、localOwner、uploadsRegistered 均为 true。该结果证明当时服务端可解析来源，不能说明原页面的来源 generation、本地解码或草稿 checkpoint 正常。服务端未取得原事件的 HTTP/RPC 错误码；站点 access log 原本关闭，Nginx 请求体缓冲 warning 不构成上传错误。见 [current-source-binding.json](current-source-binding.json)。

原页面信息缺口仍在：Root 核实浏览器控制面 `apps=[]/browsers=[]`，无法读取用户原页执行的主图 revision、活 error/reason 对象、来源 generation 和 IndexedDB checkpoint 结果。旧 stage 只在原页 console；appReadState 仅保存阅读位置，既有附件 IndexedDB 保存原件、预处理 bytes 与 operation 意图，不保存 error/name/code，因此无法事后恢复旧阶段。没有以新页面成功替代原页面证据，也未要求用户代测或刷新。

Host 上线本身不保证已开页面执行新版。主图必须完成同 release HMR 的新 revision 替换，或经显式保存更新/整页刷新重新加载；Pane graph 排除 `hapi-dsh`，只重开 Pane 不保证 HHPI installer 更新。新 observer 若仍能看到旧 error 对象，会首见报一次 `composer-error`；若 input 已重建，只能沿既有恢复路径恢复原 File/operation/prepared bytes，其后真实 provider 失败才有阶段记录。没有新报告不能证明原错误不存在。具体代码接点见 [client-update-boundary.json](client-update-boundary.json)。

定向验证：Node 26/26、现有 composer DOM 4/4、后续 sink 契约 10/10 通过。最终 Host types 复用 span `39e440f3-c1c7-420a-9bae-9a790a348088`（最终 Host 输入与 sink 修正版本一致）；最终 Client/experience 在 d324 隔离 stage、SDK .29 下实测通过，35.19s，span `3929afbc-0280-4ead-8dec-e46f9595309c`。首轮与编辑/SDK 安装交错的 types 不复用；本轮未宣称全量测试通过。各次检查 span 与冻结 hash 见 acceptance.json。

历史证据：首个正式探针在 hostBuild `238973bf…` 上 HTTP 200，但持久日志零条，故未计闭环通过。根因是 pinned Cordis 默认 logger 仅写内存 buffer，当前 profile 未挂输出 exporter；随后最小两叶修正接到现有 stderr，并补充真实 gateway 到 stderr 的契约断言。该失败保留在 [live-diagnostic-ingress-first.json](live-diagnostic-ingress-first.json)。最终通过仅证明新版诊断链可用；原用户上传失败继续保留 unknown/incomplete，后续真实诊断到达再按事件续修。
