# 首屏资源的剩余拆分空间

只拆剩余自有面板，不能消除当前弱网冷启动等待。生产只读报告 `/mnt/cache/data-cache/hapi-cold-open-1792774454463.json` 的首次导航，在可见正文出现前完成了 2,274,612 字节 HTTP 编码数据传输。按 1.6 Mbps 理想吞吐计算，仅这些字节就需要 11.37 秒；这不包含额外往返、WebSocket 历史、反序列化、投影及布局成本，也不是该次无降速样本的实际耗时。

## 实际传输分布

| 类别 | 编码字节 | 占比 |
| --- | ---: | ---: |
| 自有主包 | 376,474 | 16.55% |
| 官方插件 | 1,358,280 | 59.72% |
| 官方 shell 脚本和样式 | 490,310 | 21.56% |
| HTTP API | 49,548 | 2.18% |

最大资源为自有主包 376,474 B、官方入口 286,375 B、Conversation 195,219 B、vendor 181,352 B、Chat 155,277 B、api-remotes 109,951 B、trajectory 83,629 B、Cordis runner 64,906 B、workspace 54,888 B、settings-models 52,395 B。插件报告只保留 `/plugins/` 路径；这里的插件名称依据 pinned 本地文件的解码长度及官方包装开销对应，属于静态归因，不是报告保存的 URL query。

主包在该样本中解码后为 1,284,074 B。之后本地构建继续变化，因此以下旧 metafile 的输入贡献不能当作当前构建的精确压缩节省。

## 三项自有候选

使用 `/mnt/cache/data-cache/hapi-current-bundle.json`（2026-10-23 14:30:33 UTC）的输入图计算：从主入口排除候选后不可达、且实际贡献了输出字节的模块。下表是当时的独占输出范围；必须保留的注册与共享状态会进一步缩小真正可延后的部分。

| 候选 | 当时独占输出 | 最小拆分方式与约束 |
| --- | ---: | --- |
| 文件工具面板 | 48,505 B | `source-file-actions.tsx` 的编辑、搜索、Git 和管理界面按需加载。现有 `SourceActions` owner、文件 journal、pane 关闭保护、更新 checkpoint 和 beforeunload 保护必须贯穿界面生命周期，不能因关闭面板丢失。`source-file-mutation-journal.ts` 已由 workspace 共用，不计入这一节省。 |
| Companion 配对与 QR | 38,068 B | `source-companion.tsx` 当前把本地 QR 编码器及配对界面带入主包。保留 settings slot 注册及 controller 观察集合，打开面板才加载 QR 与界面；连接 reset、pagehide、隐藏页面和卸载时的凭据隐藏、销毁规则保持。不能改用外部 QR 服务。 |
| 语音设置面板 | 18,452 B | `source-voice/index.tsx` 仍静态引入 settings 的两个面板和 `words`。将小型语言选择函数独立，设置页按需加载；麦克风入口立即注册，复用原 catalog、transport、preferences。不能为了设置页加载整套已经拆出的语音 SDK。 |

三项合计 105,025 B 未压缩输出。套用该样本主包的整体压缩率，仅作量级估计约为 31 KB 编码数据，在 1.6 Mbps 下约 0.15 秒。压缩字典和 tree shaking 会改变实际差值，且注册逻辑仍需常驻；这里没有重新构建或实测节省，也没有据此宣称主线程长任务减少了多少。

若实施，沿用 `client-chunks.ts` 的官方 `require.async()` 和 `scripts/client-bundle.mjs` 的包内 chunk 注册。React、Cordis、官方 store/slots 继续 external；共享 controller、Context 和服务通过参数交给面板，不能在 chunk 内创建第二套插件 owner。打包、CLI artifact 检查和安装后的实际 chunk HTTP 验收须同步覆盖新增文件。现有原生历史、会话工具、管理面板、语音 SDK 和截屏五个 chunk 已拆出，不能再次计作新增收益。

## 第一阶段依赖的边界

`workspaceBootGraph` 保留真实 `inject`/`external` 依赖闭包。官方 attachment 的 manifest 依赖 Chat、Conversation、trajectory、tool，所以 trajectory 即使列为可延后模块，也会因附件能力被保留。model-selection 依赖 api-remotes；Conversation 和 Chat 是当前正文、编辑器及节点渲染的官方模块，不能在本仓库切割其内部工厂。

`settings-models` 除设置界面还注册首次安装的 welcome/credential onboarding，必须留在第一阶段。Cordis runner 接收不能重放的瞬态 inspect 请求，也必须保留。此前将 models 视作纯设置页的候选已撤回，真实 manifest 回归同时覆盖这两项与附件的依赖闭包。

剩余收益应分别计量：按需面板主要减少下载和 JavaScript 解析；首屏历史窗口改变记录传输、JSON 解码及 Conversation 投影；触摸时延后补页和背景插件工作影响布局与帧间隔。它们不是同一个指标。官方模块进一步拆包需要上游公开更细的模块边界；历史类型过滤或按调用目的限制分页也需要对应公开能力，不能以修改上游源码或私有 window 替代。

## 已有导航报告的时序复核

以下只复核旧构建聚合报告，没有运行新探针，也不代表当前工作树已达到相同结果。弱网报告 `hapi-cold-open-1792770553621.json` 生成于 2026-10-23 15:49:13 UTC，条件为 150ms / 1.6Mbps；无降速报告 `hapi-cold-open-1792774454463.json` 生成于 16:54:14 UTC。两份报告的历史范围和构建检查点不同，不能当作固定载荷前后对照。

| 指标 | 旧弱网首次导航 | 旧弱网缓存后再次导航 | 后续无降速首次导航 |
| --- | ---: | ---: | ---: |
| 工作区 / 输入框 / 可见正文 | 12.363 / 13.211 / 22.308s | 1.264 / 1.911 / 11.119s | 1.246 / 1.395 / 1.686s |
| 58 个静态资源实际传输 | 2,241,048 B | 0 B，全部命中缓存 | 2,242,464 B |
| 最后一个静态资源完成 | 11.731s | 0.416s | 0.278s |
| follow snapshot 解码大小 | 2,732,179 B | 2,743,630 B | 494,378 B |
| 正文前已记录长任务合计 / 最大 | 1,185.6 / 275ms | 811.2 / 260ms | 936 / 219ms |

旧弱网再次导航的 HTTP 实际传输只有 136,114 B，均为 API。输入框到正文仍相隔 9.209s；1.911s 至 10.859s 没有记录到超过 50ms 的长任务，末尾两段为 180ms 和 82ms。由此可以排除静态缓存失效及连续主线程长任务是这九秒等待的主因，但不能排除较短任务。

WebSocket 聚合时序中，旧首次与再次导航的 Host-wide control baseline 到独立 follow snapshot 分别相隔 7.737s、7.780s，正文出现与后者到达接近。baseline 是控制投影，不是历史分页的第一块。Node 收帧与页面 Performance 使用不同时间起点，且事件回调有调度延迟，不能比较几十毫秒的先后；这些记录也没有 Host 准备完成时间或压缩后的 WebSocket 字节数，无法把等待进一步定量分为 Host 历史准备、序列化与线路传输，更不能用解码字节除以 1.6Mbps 当作实测传输时间。

后续优化应优先对同一历史切点测量公开 follow/page 的 20/4/2 窗口，并联动首屏后的上下文补页预算；继续修静态缓存不能消除上述重复导航等待。较小窗口是否真能避开旧插件事件尚未测得，不能直接改参数或丢弃历史事实。后续无降速样本的快照仅约 494KB，同时仍有 219ms 长任务；它既不能证明旧日志已瘦身，也不能替代最终构建的弱网与主线程验收。本次调查到此停止。
