# 构建与分发维护

## 官方 bundle 契约

根 `package.json` 的主导出是 Host ESM；`./client` 指向构建后的官方 Client 模块注册脚本；`./cli` 与 `bin.hapi-dsh` 指向 CLI。`dsh.bundle.patch` 指向 `config/cordis.patch.yml`，`dsh.client.inject` 列出官方客户端依赖，平台为 `web`。

官方浏览器 loader 需要模块注册格式；单独输出普通 ESM 文件并不会自动成为 DSH Client：

```javascript
window.__ModuleLoader__.load({
  id: "hapi-dsh",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    // 构建器在这里放入插件自己的 CommonJS bundle。
    return module.exports;
  }
});
```

`scripts/build.mjs` 分别构建 Host、Client、CLI 和 `dist/runner`。Host 和 Client 的 Cordis 类型声明分开检查，避免同名服务的两端类型被错误合并。官方依赖仍由原运行时提供；构建器不修改上游代码。

Client 还包含五个按需包内 chunk：`client.voice.js`、`client.capture.js`、`client.native-panels.js`、`client.session-panels.js` 和 `client.administration.js`。它们使用同一个官方模块 ID、各自的 `chunk` 名称注册，由 `require.async()` 加载。`package.files` 包含整个 `dist`；打包与 CLI artifact 检查必须同时确认这五个文件存在。安装 smoke 还会从实际启动的官方 Host boot graph 取得 revision，逐个请求官方 chunk 路由并检查 JavaScript 注册内容，避免“主包能启动、打开可选面板才 404”。

分阶段启动的共用逻辑位于 `src/shared/boot-graph.ts`。Host 的 `src/index.ts` 和 Client 的 `src/client/deferred-plugins.ts` 都静态导入它，构建器将实际使用的函数分别编入 `dist/index.js` 和 `dist/client.js`，无需新增 HTTP 资源、package 子路径导出或运行时源码加载。`package.files` 同时收录整个 `src`；打包检查逐个核对 TypeScript 源文件，Host 声明构建也包含 `src/shared/**/*.ts`。这些是构建与文件清单的静态约束，最终安装结果仍须对应最终提交的 artifact。

`dist/runner/package.json` 是独立 Host-only manifest，包名为 `hapi-dsh-runner`，有自己的 patch，故意不带 `dsh.client`。运行时通过官方 `dsh plugin --profile hapi-runner add link:<dist/runner>` 安装该 bundle。不要用根 package 的子路径替代独立 manifest，否则官方模块发现可能把主工作区 Client 带进 Runner。

## 创建可安装发行包

```bash
npm install --global pnpm@11.28.5
npm ci
npm run check
HAPI_DSH_OFFICIAL_TESTS=1 node --import tsx --test --test-isolation=none tests/federation-official.test.ts
npm exec -- playwright install --with-deps chromium
npm run test:e2e
node scripts/distribution-pack.mjs
node scripts/distribution-smoke.mjs
```

打包脚本使用 `npm pack --ignore-scripts`，要求先显式构建。它验证包内 Host、Client、CLI、Runner manifest/patch、类型声明、许可证与文档，拒绝把本地凭据、测试产物或依赖目录装入发行包，再为 `.tgz` 计算 SHA-256。

发行包包含插件源码、构建脚本、TypeScript 配置和 `UPSTREAMS.json`，不包含已安装依赖；安装时 npm 根据固定依赖版本下载官方 DSH。锁文件及测试保存在同版本 GitHub 源码中。当前只支持正常 npm 解析/安装路径，未提供离线全依赖镜像或跨平台单文件二进制。

支持的安装入口是已构建 `.tgz`，或 `git clone` 后 `npm ci`、`npm run build`。不要用 `npm install github:...` 代替这两条路径；本包没有隐式 `prepare` 生命周期来替使用者编译源码。

## GitHub Actions

`.github/workflows/ci.yml` 保留类型、逻辑、官方 federation 与完整浏览器回归。打包 job 与回归并行，生成同一份 `.tgz` 和 `INSTALL.md`；Linux、Windows、macOS 三个 job 下载这份包，在带空格的干净目录安装运行依赖，调用真实 npm 命令 shim，验证版本、登录脱敏、主/Runner profile、离线 doctor、HTTP 启动与撤销。测试目录的 pnpm 随安装提供，不依赖预装的全局 pnpm。发布仍等待整个工作流成功，快速生成安装包不绕过正式发布门槛。

日常准备包可用 `npm run dist:pack`，完整安装验证用 `npm run test:install`。这两条命令不会提交、推送或发布到 npm。

`.github/workflows/release.yml` 在 `v*` tag 上调用相同验证流程。验证成功后校验 tag 与 `package.json.version` 一致，下载该流程已经检查过的同一安装包，复核 SHA-256，再创建 GitHub Release。发布任务只有所需的 `contents: write` 权限，不运行 `npm publish`。

创建新版本时：

1. 更新 package version 与锁文件，记录变更和已完成的真实部署验收。
2. 使本机与 CI 的所有门槛通过，核对许可证和第三方来源。
3. 提交后创建匹配版本的 tag，例如 package `0.1.0` 对应 `v0.1.0`。
4. 推送 tag 触发发布；下载 release 包在干净机器复验安装路径。

不要为修复已发布字节而移动同名 tag 或覆盖既有发行包。修复后产生新版本，并让各台 Hub/Runner 协同升级。发布流程不会静默覆盖已有 GitHub Release。

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

## 对照源码与许可证

HAPI 的工作区几何及原生输入适配保留来源声明，本项目使用 AGPL-3.0-only。完整对应源码、构建脚本和锁文件随 GitHub tag 提供；安装包 README 和 NOTICE 指向源码仓库。DSH 是原样 npm 依赖，使用其 MIT 许可与声明。

需要更新兼容版本时，先检查官方插件 manifest、ClientModuleSystem/Loader、Session 与 connection 契约，再同时更新固定版本、握手检查、真实集成测试与文档。不能仅放宽版本判断来跳过实际兼容性验证。
