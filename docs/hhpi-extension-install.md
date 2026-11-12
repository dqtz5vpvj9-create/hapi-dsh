# HHPI 的 DSH 源码扩展

当前固定上游为 DSH `0.2.2-rc.1`、提交 `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`，源构建使用 upstream 锁定的 `pnpm@11.28.5`。机器可读输入以 [UPSTREAMS.json](../UPSTREAMS.json)、[源码说明](../source-snapshots/dsh-ext/README.md)和 [manifest](../source-snapshots/manifest.json)为准，不把开发目录名或相同 npm rc 视为同一构建。

当前完整集合由 `scripts/dsh-ext/prepare.mjs` 的 `EXTENSION_PACKAGES` 定义，共二十四包，涵盖客户端/Session、Terminal owner、FileSystem、原生持久化、文件导航器、工作区导航、动态主题，以及 translator 与 cot-translation。

截至 2026-11-12，中央 Host 和两个在线 Runner 已部署源码发行 `hhpi-dsh-022-20261107.29`，完整二十四包；另两个离线配对记录未升级，须在重连后完成同版更新。`.29` 为官方 QueueDock 增加可选逐行“发送此条并继续队列”，仅用户点击后使用原生队列项身份启动；缺少投影的普通 DSH 默认行为不变。中央随后单独更新 HHPI 的正式 question Inbox 投影与内部诊断 stderr sink，两个在线 Runner 复用已验证的同套 `.29`。原配置、原生进程和插件开关保持；[本轮发布记录](../artifacts/development/hhpi-stopped-image-queue-20261112/publication.json)区分各载体、验收与未升级范围。上传失败原因仍未知，诊断采集上线不等于上传故障已修复。

历史版本中，`.27` 为 QueueDock 增加可选来源 delivery 与逐行 Steer 状态，显式来源授权可在恢复后的 idle 状态保留操作；缺少投影的普通 DSH 仍沿用 running-only 规则。本批仅修改六个冻结 Conversation 文件，其余 `.26` 来源与完整二十二包集合保留。`.26` 增加 QueueDock 可选 `editText` 正文投影，按源端队列编辑正文并保留附件与 typed 输入身份；缺少该字段的普通 DSH 仍使用原编辑路径。其余 `.25` 功能与完整二十二包集合保留，来源仅增加冻结的五个 Conversation 文件。`.25` 让 InputBar 空输入提示、键盘操作及 InputHub 每次实际调用统一读取 queueActions，任一队列行禁用 Steer 时不执行整个 steer-all；typed draft steering 与缺少投影的默认 DSH 行为保持。`.24` 在完整 `.23` 基线上增加 QueueDock 可选逐行 queueActions 投影，并在精确匹配的源队列交接中保留原提交者附件预览；缺少投影或行时沿用普通 DSH 行为。六叶来源、契约及 ADR/上游 PR 草稿随同批集合归档。`.23` 合入注册表候选失败保留已接纳正文、同一 root host 注册间隙后的恢复，以及公开 historySource 整窗确认、恢复与代际内 provider 选择；对应源码、契约、ADR 和上游 PR 草稿一并归档。该 `.23` 批次十三叶输入及来源身份先于正式 SDK 构建冻结；安装及实际路径验收另行记录。`.22` 在既有 `.21` 基线上修正迟到的发送确认清除新草稿的问题，保留新文本、引用及尝试之外的附件；对应源补丁、具名回归和 ADR/PR 随发行提供。`.15` 首次构建因未声明的 controller 客户端模块请求被官方 purity 检查拒绝；该失败输入保留，修正与工作区导航开关共同进入 `.16`，不覆写旧归档。`.17` 增加已证实的焦点控件局部模态样式修复；`.18` 修正 ui-chat 对实测值恰等于估值的尺寸修订误判，保留 `.17` 归档及全部负证据。`.19` 组合 range-only 几何提交与非读者布局滚动的锚点保护，其实际搜索/Zoom暴露布局快照反复改写阅读 pin 的缺陷，`.20` 将 pin 选择收回到真实阅读采样与确切导航落点，但实际 Zoom 仍暴露尺寸偏移误判为 reader sample、阻断恢复后保存中间位置的问题；`.21` 统一尺寸归属与 pending semantic owner，来源契约已通过，实际路径仍待验证。正式 390px 的 100ms 仍未归因；阅读性能仍须按原 80ms 门槛实测。此前 rc 的补丁在 `source-snapshots/dsh-ext/releases/0.2.1-rc.3` 保留，不能重放到当前 rc 上。

## 从源码准备、构建和安装

历史 `.28` 发布中，中央真实 `deepseek-official` 合成短文本翻译与缓存读取、官方 Reader 的原文切换和双 Pane 取消隔离分别验证；[插件兼容发布记录](../artifacts/development/hhpi-plugin-compat-20261111/publication.json)保留相应证据与全量测试失败边界。

2026-11-11 的插件兼容修复在 `.27` 基线上形成 `.28` 源码发行，增加 translator 和 cot-translation 两个源码包，共二十四包。四个修改包的职责、默认路径和验证边界见[插件委托 ADR](adr/hhpi-plugin-session-delegation.md)与[上游提案](upstream-pr-plugin-session-delegation.md)。源码构建、实际部署、带 RPC fixture 的浏览器路径和真实翻译服务分别记录；`.28` 不表示所有配对机器已升级，也不表示全量测试通过。

在项目根目录执行。临时输入放 `/mnt/cache/data-cache`，每次使用新的输出目录，保留上一套可回滚产物：

```sh
npm ci
node scripts/dsh-ext/prepare.mjs /mnt/cache/data-cache/hhpi-source-preparation > /mnt/cache/data-cache/hhpi-source-preparation.json
```

读取 JSON 的 `directory` 字段，将其作为下面的 `PREPARED_SOURCE`。其余大写路径也应替换为新的实际绝对路径：

```text
node scripts/dsh-ext/build-extension.mjs PREPARED_SOURCE NEW_PACKAGE_DIRECTORY --expected-source /mnt/cache/data-cache/hhpi-source-preparation.json
node scripts/dsh-ext/create-release.mjs PREPARED_SOURCE NEW_PACKAGE_DIRECTORY NEW_RELEASE_DIRECTORY
node scripts/dsh-ext/install-extension.mjs NEW_PACKAGE_DIRECTORY
```

已有正式冻结清单时，构建命令的 `--expected-source` 使用该清单，不能换成 prepared 目录自己声明的 metadata。本轮 `.17` 的对应命令模板为：

```text
node scripts/dsh-ext/build-extension.mjs PREPARED_SOURCE NEW_PACKAGE_DIRECTORY --expected-source artifacts/development/hhpi-delivery-20261107/I6-extension20-layout-pin-frozen-20261108.json
```

prepare 精确还原固定提交并应用 active `source.patch`。build 在调用工具链或编译前先核对 expected 与 prepared 的 top/native 来源身份；expected 已提供 `sourceSha256`（或正式 manifest 的 `build.sourceSha256`）时同时核对整树 hash，未提供则不声称验过整树。build 再使用同一 upstream lock、Typert 生成器、官方编译 preset 与 project references，打包完整集合；不改写编译后的 JS 实现能力。create-release 收集完整补丁、实际 package 源码、锁文件、许可、ADR 和上游 PR 草稿。没有完整真实集合时，fixture archive 只能用于安装器机制测试。

开发 installer 先校验集合与对应源码身份，再安装并核对每包 marker；`package.json` / `package-lock.json` 保持原有固定依赖。`npm ci` 会还原原版依赖，之后须重装完整扩展再验证依赖这些能力的契约。它不会原子升级远端 Host/Runner，也不替代[正式 bundle 流程](distribution.md)。

## 公开能力与默认路径

阅读扩展提供 reading occurrence、统一 window commit、mounted reader 的逐节点 render proof 与 `checkpointReading`。结构化引用保留官方输入与裁决事务。文件上传使用公开 owner/provider 和实际接受回调。Terminal 的 `createTerminalOwner` 允许在真实源 cwd/subprocess 上组合终端，不需要 fake Agent context。FileSystem 的 `writeBytes` 和发布前 checkpoint 复用正式原子提交及 Windows DACL 路径。

这些能力默认保持普通 DSH 路径，缺少能力时明确不可用，不能替换成另一读者、中央文件系统或假本地执行。各扩展的契约、必要性和上游提案保存在 `docs/adr` 与对应 `docs/upstream-pr-*` 中。

## 版本与验收

Host、Runner 和客户端运行图必须消费同一套正式集合。现有发行校验核对上游提交、补丁输入、tarball 和每包 marker，安装后再检查真实 consumer 的解析路径；不能仅比较版本字符串或因为开发 checkout 已安装就推断远端已升级。

实际官方 Session/Conversation/Chat 的契约验证和源码/补丁重放分别记录；源 RPC 与外部服务的 fixture 不证明真实源或生产行为。部署与行为验收按具体 Host、Runner 和用户路径分别记录，已有发布记录见[发行说明](hhpi-retirement-release-notes.md)。源码契约通过不表示所有平台与功能均已验收；物理设备输入/通知及未记录的路径不在本文中标记为通过。
