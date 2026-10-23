# HAPI-DSH UI 与性能验收

用户已将 UI 验收交给 Agent。本流程替代此前“上线后交给用户手测”的阶段规则。原始目标见 HAPI 的 `docs/chat-experience-contract.md` 和 `docs/plans/tmux-workspace-implementation.md`：首次打开、双向历史滚动、实时更新、输入、多 Pane 和手机操作均须覆盖。

## 快速运行

首次完整构建后，启动一个常驻环境：

```sh
TMPDIR=/mnt/cache/data-cache npm run build
TMPDIR=/mnt/cache/data-cache npm run e2e:warm -- serve
```

迭代时运行 `npm run e2e:warm -- rebuild-client`，然后 `npm run test:ui`。报告含逐项结果、原始帧间隔、长任务、锚点漂移、正文/输入框可用时间、DOM 与堆数据。失败退出码为 1，完整 JSON 写入 `/mnt/cache/data-cache/hapi-dsh-warm-*/`；控制端不输出 admission 凭据。

首开不加载语音 SDK 和长图导出库。两者通过 pinned DSH 的 `require.async()` 包内分块接口在使用时加载；快速验收会打开语音面板并实际导出 PNG，检查分块请求和下载内容。分析主包体积可运行 `HAPI_DSH_BUNDLE_REPORT=/mnt/cache/data-cache/hapi-bundle.json npm run build:client`，得到 esbuild 的模块体积报告。

`npm run test:perf` 连续执行五轮桌面流程，再做 360/390px 手机模拟。Host 和 Chromium 进程复用，每轮清理浏览器 context 并重置合成布局；测试 fixture 的源历史和 Host 缓存保持，所以首轮与后续轮分别报告。测试代码可重新加载，修改 Host/fixture 初始化代码后重启常驻环境。只在客户端变动时重建客户端，避免安装 profile 和启动 Host 的重复开销。

性能运行期间不并行执行构建、其他浏览器测试或 CPU 分析。性能失败保留，不通过重试挑选最好的一轮覆盖。采样器运行在浏览器内，打开计时从正常 sidebar 点击开始，分别等真实正文和可编辑输入框；外部 Playwright 等待不算打开耗时。

完整导航另行计时：恢复测试从 `navigationStart` 到保存会话的真实正文和可编辑输入框，保留草稿断言。`npm run test:perf:production` 使用本机配置的 admission 文件，只读探测线上初次导航及带浏览器缓存的再次导航，输出工作区、正文、编辑器、资源耗时和主线程长任务。`HAPI_DSH_CPU_RATE=4 HAPI_DSH_PROBE_RUNS=1 npm run test:perf:production` 可增加 CPU 降速样本；这是模拟环境，不是真机测量。不得用 workspace ready、骨架或热切换数据替代这个完整耗时。

队列与命令呈现回归可单独运行 `TMPDIR=/mnt/cache/data-cache npx playwright test e2e/source-presentation.spec.ts`。两个用例共用一个官方 Host，使用与生产字段一致的合成源记录：五条 `indeterminate` 回执不会出现在输入区，刷新不重发，真实排队消息仍可取回编辑；带 `command_actions` 的 shell 调用显示简短标题，展开保留命令、输出和真实退出码。覆盖桌面、390px 和 360px。设置 `HAPI_DSH_VISUAL_OUTPUT=/mnt/cache/data-cache/source-presentation` 时额外调用 webshot 输出桌面及手机截图，需人工查看产物后才能报告视觉通过。

## 门槛与来源

| 项目 | 判定 |
| --- | --- |
| 静止补页锚点 | 每个采样帧偏移 ≤1 CSS px，原锚点不丢失；来自 HAPI 约定 |
| 已读区域往返 | 新的历史页请求和源历史读取均为 0 |
| 缓存打开 | 正文和输入框分别 <500ms；正文样本 p95 <150ms，来自后续架构目标 |
| 首次会话正文/输入框 | 本地合成环境各 <1500ms，当前工程门槛，非原版用户指定数值 |
| 冷浏览器文档 | 常驻 Host 下 <6000ms，单独记录；不是冷 Host 或远端生产指标 |
| 连续双向滚动 | 本地 Chromium 帧间隔 p95 ≤50ms，最大 ≤200ms；rAF 时间戳量化容差为 0.2ms，保留未经修约的原始值。当前工程门槛，不等于 60 FPS 承诺 |
| 手机结构 | 360/390px 正文全宽，无横向页面溢出；输入框 ≤160px、单行顶栏/底栏各 ≤52px |
| 草稿与交互 | 切换、刷新和宽度变化保留草稿；多 Pane 草稿/审批目标独立；关闭不 abort |
| 实时与断线 | 六次源端增量分别在回复结束前出现，各次等待上限 1500ms并记录实际延迟；离开末尾后更新不拉回、输入实例和草稿保留；断线保留正文，不自动重发 |

过程采样和交互断言与视觉检查互补。截图通过 `webshot` 技能采集并实际查看；截图不能证明滚动无卡顿。物理手机软键盘、实际触摸滚动和远端网络不能用 viewport resize 或本地 fixture 冒充。缺失的场景明确记录为未覆盖，不能列入通过数。

## 数据与边界

浏览器执行 pinned 官方 DSH Conversation、SessionProvider、编辑器和插件加载器；HAPI wire 和执行结果为合成 fixture，不调用真实模型。发送、队列、审批、断线等测试只操作该隔离环境。生产探针只读取既有会话及页面状态；报告只存时序、计数和脱敏错误，不存正文、凭据或私有会话身份。

单次通过只说明对应环境与样本通过。最终交付同时给出源码版本、客户端构建时间、Host/浏览器启动次数、运行次数、失败项和未覆盖范围。内存窗口长期有界、跨设备通知、真实远端冷启动等，必须有各自证据，不能从短流程推断。
