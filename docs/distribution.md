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

`dist/runner/package.json` 是独立 Host-only manifest，包名为 `hapi-dsh-runner`，有自己的 patch，故意不带 `dsh.client`。运行时通过官方 `dsh plugin --profile hapi-runner add link:<dist/runner>` 安装该 bundle。不要用根 package 的子路径替代独立 manifest，否则官方模块发现可能把主工作区 Client 带进 Runner。

## 创建可安装发行包

```bash
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

`.github/workflows/ci.yml` 对主分支、PR 和可复用调用执行：固定 Node 版本、`npm ci`、类型/单元/构建检查、真实官方 federation 集成、Chromium Playwright E2E、打包及包内容校验，最后从 `.tgz` 在干净目录安装运行依赖，实际创建主/Runner profile、离线 doctor、脱敏与撤销。报告与包通过 artifact 保存，GitHub Actions 自身也固定到提交 SHA。

`.github/workflows/release.yml` 在 `v*` tag 上调用相同验证流程。验证成功后校验 tag 与 `package.json.version` 一致，下载该流程已经检查过的同一安装包，复核 SHA-256，再创建 GitHub Release。发布任务只有所需的 `contents: write` 权限，不运行 `npm publish`。

创建新版本时：

1. 更新 package version 与锁文件，记录变更和已完成的真实部署验收。
2. 使本机与 CI 的所有门槛通过，核对许可证和第三方来源。
3. 提交后创建匹配版本的 tag，例如 package `0.1.0` 对应 `v0.1.0`。
4. 推送 tag 触发发布；下载 release 包在干净机器复验安装路径。

不要为修复已发布字节而移动同名 tag 或覆盖既有发行包。修复后产生新版本，并让各台 Hub/Runner 协同升级。发布流程不会静默覆盖已有 GitHub Release。

## 对照源码与许可证

HAPI 的工作区几何及原生输入适配保留来源声明，本项目使用 AGPL-3.0-only。完整对应源码、构建脚本和锁文件随 GitHub tag 提供；安装包 README 和 NOTICE 指向源码仓库。DSH 是原样 npm 依赖，使用其 MIT 许可与声明。

需要更新兼容版本时，先检查官方插件 manifest、ClientModuleSystem/Loader、Session 与 connection 契约，再同时更新固定版本、握手检查、真实集成测试与文档。不能仅放宽版本判断来跳过实际兼容性验证。
