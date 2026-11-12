# 构建、分发与回滚

当前产品是 HHPI，技术包名仍为 `hapi-dsh`。面向使用者的入口是包含插件与完整 DSH 扩展的正式 bundle；开发 checkout 的覆盖安装与普通插件 tgz 是不同的产物。正式 manifest 和实际 Host、Runner 共同确定已部署版本，发布记录见[发行说明](hhpi-retirement-release-notes.md)。

## 构建输入与运行时

官方 DSH 固定 `0.2.2-rc.1`，源码提交、active patch 与许可由 `UPSTREAMS.json` 和 `source-snapshots` 记录。根包、Host-only `hapi-dsh-runner` 与 manifest 声明的全部扩展来自同一归档集合；当前扩展构建步骤见[扩展安装](hhpi-extension-install.md)。

`scripts/build.mjs` 构建 Host ESM、官方 Client 模块注册脚本、CLI、公开普通 DSH provider 和独立 Runner manifest。Client 通过官方模块表与声明依赖加载，当前按需 chunk 为本机语音与截图；旧 HAPI native/session/administration 面板退出。最终文件清单以构建器与打包检查为准，不因旧 dist 文件存在就纳入发行。

Runner manifest 不带工作区 Client，保留原 DSH 执行与插件图。受管 Host 链接到 release 的 `runtime/node_modules/hapi-dsh`，Runner 链接到同一 runtime 的 `hapi-dsh/dist/runner`。健康检查必须从真实 consumer 解析这些包和扩展，而不是只读解包目录的版本。

## 创建发行产物

在固定依赖和完整扩展已安装的 checkout 中执行；最终检查的结果必须对应实际打包字节：

```text
npm run check
node scripts/distribution-pack.mjs
npm run bundle:pack -- --ext-release ABSOLUTE_SOURCE_BEARING_EXT_RELEASE
node scripts/distribution-smoke.mjs ABSOLUTE_EXTENSION_PACKAGE_DIRECTORY
```

`distribution-smoke` 的参数是包含 `manifest.json` 与其声明的全部 tgz 的扩展构建目录；`bundle:pack` 的参数是包含 `release.json`、对应源码与许可的完整发行目录。跨平台安装 CI 随插件上传并复用同一份扩展归档，不在安装阶段换回上游未扩展包。

`distribution-pack` 使用显式构建后的 `npm pack --ignore-scripts`，核对源文件、运行入口、声明、许可和文档，排除凭据与本地数据，沿用既有 `SHA256SUMS`。它将当前 `QUICKSTART.md` 原样复制为 `artifacts/INSTALL.md`，分发文案只有这一份源。

薄包 `hapi-dsh-VERSION.tgz` 不会因普通 npm 安装而自动成为完整扩展发行。完整 `hapi-dsh-bundle-VERSION.tgz` 携带插件 payload、真实 ext tarball、manifest、许可、安装器和完整对应源码/source offer。安装时未修改的依赖仍从公开 registry 解析，因此不是离线单文件二进制。不能用占位 fixture 发布真实 HHPI 能力。

## 安装与升级

完整 bundle 的初次安装入口不依赖已安装 HHPI：

```text
tar -xzf hapi-dsh-bundle-VERSION.tgz
node package/dist/install.mjs install --profile hapi --role host
```

原有 Runner 用其真实 DSH home/profile 和 `--role runner` 安装同一个 bundle，保留私有 Runner 配置与机器身份。已有运行实例先通过 idle gate，再按服务监督方案重启；安装命令成功本身不证明新进程或远端资源已就绪。[安装指南](install.md)说明配置、配对与现有 Web 的挂载。

已安装 CLI 可调用 `bundle status`、`bundle verify`、`bundle upgrade --tgz FILE` 和 `bundle rollback`。自定义实例始终使用对应私有配置。详细 standalone 参数与实际托管路径见[安装器说明](../scripts/bundle/README.md)。

既有发布流程保持不可变 release、清单校验、路径边界、profile manifest/lock 备份、官方插件安装、consumer 解析、idle 和 health gate。失败保留旧 active 并恢复原 profile。至少保留两个先前 release；回滚软件与依赖，不回滚会话日志、原生队列或审批结果，也不重发不确定操作。

## CI、发布与证据

旧数据的离线恢复工具单独交付为 `hapi-dsh-offline-recovery-VERSION.tgz`，通过 `npm run recovery:pack -- --out ABSOLUTE_DIRECTORY` 生成。该归档包含 Node 24 可执行入口、内置依赖、对应源码和许可，不属于工作区运行图或主 bundle payload。它只读取用户明确选择的导出、生成私有恢复对象，不连接源或自动导入。实际命令和边界见[离线恢复说明](offline-recovery.md)；发行时将此归档与主 bundle 一并提供。

CI 的 verify、package 和三平台安装 job 是计划执行入口；成功结论来自某次具体 job 的日志，不能根据 workflow 配置推断。当前测试层次、真实官方集成和两条有界浏览器验收见[测试说明](testing.md)。`test:e2e` / Playwright 全应用流程已退出，不应恢复旧命令作为日常门槛。

发布使用实际验证过的同一 artifact，核对包版本、扩展身份、源码与许可；tag 和 release 不覆盖已发布字节。既有站点发布还核对认证 HTTP/WebSocket、运行版本与真实界面。源码/Node/DOM 通过分别记录，不能代替 Windows 原源 Runner、物理设备输入/通知或最终发布证据。

## 许可证与历史

项目使用 AGPL-3.0-only，复用 HAPI 的几何和输入等代码保留其声明；退出旧运行时不删除许可证。DSH 扩展基于 MIT 源码，补丁、实际包源码、构建输入和对应许可随 source offer 提供。第三方许可与固定版本见 `NOTICE`、`UPSTREAMS.json` 和发行内容。

以下只保留旧版本的实际 CI 证据；旧 login、旧 chunk 和旧模型路径不再是当前流程。这些记录不证明本轮源码或 artifact 通过。

## 2026-10-23 安装验收记录

以下记录来自实际 GitHub Actions 日志，不是从 matrix 配置推断支持。`212afb0eb838769796bb7e9509c628633beec861` 的 [CI 39994980405](https://github.com/dqtz5vpvj9-create/hapi-dsh/actions/runs/39994980405) 已成功打包；三个安装 job 下载同一份 artifact，在干净目录完成 npm 安装、真实命令 shim、主 profile、登录脱敏、offline doctor、官方 Host HTTP 启动、Runner 安装和撤销。

| 实测环境 | Node / npm | 安装结果与日志 |
| --- | --- | --- |
| Ubuntu 24.04.5 LTS，x64 | 24.19.0 / 11.17.0 | [通过](https://github.com/dqtz5vpvj9-create/hapi-dsh/actions/runs/39994980405/job/120556314721) |
| macOS 26.6.2，build 25G83，arm64 | 24.19.0 / 11.17.0 | [通过](https://github.com/dqtz5vpvj9-create/hapi-dsh/actions/runs/39994980405/job/120556314680) |
| Windows Server 2025 Datacenter，10.0.26100，x64 | 24.19.0 / 11.17.0 | [通过](https://github.com/dqtz5vpvj9-create/hapi-dsh/actions/runs/39994980405/job/120556314895) |

三个日志都明确完成安装 smoke，并且没有调用真实 HAPI 或模型。这证明这些 CI 环境的安装和 HTTP 启动路径；不代表其他系统版本、浏览器 UI、物理设备或生产链路已验收。

该提交的整个 CI 仍为失败：verify 中 1,064 项逻辑测试有 1,058 项通过、5 项失败、1 项跳过，失败均为测试夹具把 `mkdtemp` 根目录写死到 `/mnt/cache/data-cache`，而 GitHub Runner 没有该目录。`feaefd51b2dd9c8d6b4e9f095d1dbd55c3418909` 将这五个用例改用平台 `tmpdir()`。截至 2026-10-23 17:44 UTC，[新 CI 39996951990](https://github.com/dqtz5vpvj9-create/hapi-dsh/actions/runs/39996951990) 的 package 与三个系统安装均已通过；verify 已通过原失败阶段、官方 federation、测量负对照和共享 UI 验收，完整浏览器回归仍在运行，尚不能标记整个流程通过。

这两个远端提交均不包含随后工作树里的五个 chunk 完整性检查和移动滚动改动。上面的跨平台结果不能替代下一次包含这些改动的最终 artifact 验收；必须按最终提交重新检查 package、三个安装 job 与 verify 的结果。
