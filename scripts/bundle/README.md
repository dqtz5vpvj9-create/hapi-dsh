# HHPI 完整分发包（技术名 hapi-dsh-bundle）

`hapi-dsh-bundle-VERSION.tgz` 把 HHPI 插件、匹配的 DSH 源码扩展、安装器、许可与对应源码放在一个安装入口。未修改的依赖仍在安装时通过公开 registry 解析，因此不是离线单文件二进制。当前 Windows 原源 Runner、真机与最终同版发布仍待验收，本文描述安装契约。

## 内容与身份

```text
package/
  dist/install.mjs
  dist/lib/*.mjs
  payload/hapi-dsh.tgz
  payload/dsh-ext/*.tgz
  manifest.json
  SHA256SUMS
  LICENSES/
  SOURCE-OFFER/
```

active 上游是 DSH `0.2.2-rc.1`、提交 `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`。当前准备中的源码发行是 `hhpi-dsh-022-20261107.25`，新增空输入提示、键盘与操作时的 queueActions 一致检查，保留 typed draft steering 和缺少投影的默认行为。`.24` 新增 QueueDock 可选逐行 queueActions 与原提交者附件预览交接；缺少投影或行时保留普通 DSH 行为。`.23` 在 `.22` 草稿修订隔离基础上，合入注册表候选失败保留有效正文、root 注册间隙恢复与公开 historySource 整窗/代际选择修复；该 `.23` 批次十三叶输入及来源身份先于正式 SDK 构建冻结；安装及实际路径验收另行记录。二十二包完整集合、每包身份与补丁输入由源 release 的 `release.json` / package manifest 定义；不能只比较相同的 rc 字符串。`.15` 的 purity 构建失败记录独立保留；`.16` 的显式模块请求和工作区导航所有权开关保留；`.17` 的动态主题焦点局部样式保留；`.18` 的等估值尺寸修订修复保留；`.19` 的 range-only 与非读者布局滚动保护保留；`.20` 修复布局快照改写 reading pin 的反馈环；本版修复已观察到的尺寸偏移误判和 pending reader 保存中间态，真实阅读采样、确切导航和待完成采样各保留其 semantic owner。来源契约已通过，实际搜索/Zoom及阅读待验；正式 390px 的 100ms 仍未归因。已有阅读性能负证据保留，不能把源码构建当成 80ms 通过。更早 rc 的材料独立归档。

安装器沿用现有 releaseId、清单、payload 和源码身份检查，不接受改变同名不可变 release。源码 offer 包含补丁、实际包源码、锁文件、构建输入、ADR、上游 PR 草稿和许可。用于 source extension 的 manifest protocol 与 HHPI wire v1 是不同的契约。

## 准备真实 bundle

按[源码扩展流程](../../docs/hhpi-extension-install.md)准备完整 source-bearing release，完成当前代码检查与构建，再执行：

```text
npm run bundle:pack -- --ext-release ABSOLUTE_EXT_RELEASE_DIRECTORY
```

`--fixture` 只验证安装器结构与故障行为，不能发布原生能力。需要指定可写的 fixture 临时根时使用 `/mnt/cache/data-cache` 下的新目录。正式 source release 的实际版本号、包列表和源码 offer 来自输入清单，不手写另一套版本。

## 初次安装与受管路径

在 Node 24.x、固定 DSH 和 pnpm 已可执行的环境中解压真实发行：

```text
tar -xzf hapi-dsh-bundle-VERSION.tgz
node package/dist/install.mjs install --profile hapi --role host
```

在源机器安装 Runner 时，使用其原 DSH home、profile 和角色：

```text
node package/dist/install.mjs install --dsh-home DSH_HOME --profile hapi-runner --role runner
```

参数中的占位符替换为实际路径/文件。已有实例使用其真实 profile，不新建另一进程冒充升级。配置和官方配对见[安装指南](../../docs/install.md)。`--dry-run` 只生成计划，不激活 profile 或移动指针。

受管根为 `DSH_HOME/hapi-dsh/releases/r-RELEASE/`。Host link 指向其中的 `runtime/node_modules/hapi-dsh`；Runner link 指向同一 runtime 的 `runtime/node_modules/hapi-dsh/dist/runner`。原始解包 `package/dist/runner` 不是受管运行依赖入口。安装器核对真实 Host、Runner 与 DSH consumer 的解析，防止扩展只装在无人使用的目录。

## 激活、失败与回滚

已有状态机保持 `downloaded → verified → staged → doctor-passed → waiting-idle → activating → healthy`。校验失败不激活；普通 DSH 仍执行时停在 idle gate。激活前保存 profile manifest/lock，安装使用官方 DSH plugin 命令并保留其他插件和 override。健康检查核对解析、扩展身份、DSH 单例及配置的真实 endpoint。

检查通过不等于进程已经重启。服务管理器仍需监督原 CLI、避免双实例，并确认新 runtime 真正运行。Windows 任务显示 Ready 不证明 Runner 在运行；实际 Session 0 app-server、文件和 PTY 要另验收。

失败恢复 profile 备份与原 lock，保留旧 active。至少保留两个先前 release，`--keep-previous` 不能小于 2。回滚恢复软件与依赖，不改原生日志、队列或审批结果，不重发未知写操作。现有 CLI 提供：

```text
hapi-dsh bundle status
hapi-dsh bundle verify
hapi-dsh bundle upgrade --tgz hapi-dsh-bundle-VERSION.tgz --role host
hapi-dsh bundle rollback
hapi-dsh bundle prune --keep-previous 2
```

自定义实例使用对应私有配置。Runner 使用其源机器、原 Runner 配置与角色的 standalone 安装/监督流程，不能把主 Host 配置误当 Runner 配置。

## 状态与检查边界

`DSH_HOME/hapi-dsh/state.json` 保存每个 profile 的 active/previous、managed override 与激活尝试；`runtime.json` 是实际 Host/Runner 的 PID、身份与 busy session 快照。快照缺失如实记录，不根据缺文件推定进程退出，也不把旧机器上的无关 HAPI PTY 当作本次迁移对象强停。

现有 `file:` override 不适配某环境时可使用 `--style dir` 的正式解包目录路径，再执行相同解析和健康检查。混载依赖仍然失败，不通过放宽版本、跳过解析或删除旧数据绕过。

最终发布须核对当前 artifact 的安装、完整源码/许可、普通 DSH 委托、真实源 owner、浏览器与设备证据。历史安装器测试只能证明其注明的边界。
