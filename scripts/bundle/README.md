# 单 tgz 分发包（hapi-dsh-bundle）

这里实现 spec 第 5 节的分发层：一个 `hapi-dsh-bundle-<version>.tgz`，装一次即可用，
不需要源码构建，也不使用私有 registry。未修改的官方依赖仍在安装时从公共 registry 解析，
所以这是**单包入口**，不是离线安装。

## 布局

```text
package/
  dist/install.mjs            # 安装入口，只 import Node 内置模块和随包的 ./lib/*.mjs
  dist/lib/*.mjs              # 安装器、release 状态机、overrides、tar
  payload/hapi-dsh.tgz        # hapi-dsh 构建产物（含 dist/runner）
  payload/dsh-ext/*.tgz       # 仅被补丁修改的官方包
  manifest.json               # 发布身份、payload 哈希、能力集合、releaseId
  SHA256SUMS                  # 除自身外每个包的哈希
  LICENSES/                   # 本项目、上游 DSH、HAPI 及第三方许可
  SOURCE-OFFER/README.md      # 对应源码地址与版本
  SOURCE-OFFER/PROVENANCE.json
```

`manifest.json` 里的 `releaseId` 是「身份 + 全部 payload 哈希」的内容地址；
安装器把它重新算一遍，不一致就拒绝安装。release 目录名是 `r-<releaseId 前 16 位>`。

## 命令

首次安装（此时 hapi-dsh 还不存在）：

```bash
tar -xzf hapi-dsh-bundle-<version>.tgz
node package/dist/install.mjs install --profile hapi --role host
node package/dist/install.mjs install --profile hapi-runner --role runner
```

升级用同一个入口；也可以装好之后用 CLI：

```bash
hapi-dsh bundle status
hapi-dsh bundle verify
hapi-dsh bundle upgrade --tgz hapi-dsh-bundle-<version>.tgz --role host
hapi-dsh bundle rollback
hapi-dsh bundle prune
```

`--dry-run` 会完成校验、解包、overrides 规划和资格检查，打印将要执行的官方命令，
但不改 profile、不移动 release 指针。

## 安装流程

1. **verified**：校验 manifest schema、releaseId、SHA256SUMS、payload tarball 的身份
   （hapi-dsh 包名/版本，ext 包名/版本），以及 `dist/install.mjs` 的 import 白名单。
2. **解包**：把 bundle 复制到 `<DSH_HOME>/hapi-dsh/releases/r-<hash>/`，并把
   `payload/hapi-dsh.tgz` 解到同目录 `package/`。目录按内容命名，已存在且内容一致就复用，
   内容不同直接失败（不可变 release）。
3. **overrides**：在 profile 的 `pnpm.overrides` 里写入指向 release 内 tarball 的 `file:`
   引用（相对 profile 目录解析，但目标必须落在 release 根内）。只改 hapi-dsh 自己记录过的
   key；用户其他 override 原样保留；遇到 hapi-dsh 没写过的同名 key 立即失败，不覆盖。
4. **官方命令**：profile 缺失时先 `dsh --profile <p> --from-default-profile web`，然后
   `dsh plugin --profile <p> add link:<release>/package`（runner 用 `.../package/dist/runner`），
   最后 `--dump-config` 确认插件行存在。安装器不自己解析插件依赖。
5. **doctor-passed**：Node ≥ 24、pnpm ≥ 11、官方 launcher 版本、许可与 source-offer 齐全。
6. **waiting-idle**：读 `<DSH_HOME>/hapi-dsh/runtime.json`（由 Host/Runner 写）。有普通
   DSH 会话时停在 waiting-idle，不强制重启；`--wait-idle-timeout` 可以等，默认直接报告。
7. **activating**：加锁、备份 profile 的 `package.json`/`pnpm-lock.yaml`、写 staging
   overrides、调官方插件命令。
8. **healthy**：30 秒健康门（解析路径、ext 版本、DSH 单例、可选 `--health-url`、可选
   `--dump-config`）。通过后 release 指针才移动；失败则恢复 profile 备份、按原 lockfile
   重装依赖，旧 active 保持不变。
9. 成功后才清理超出保留窗口的旧 release。**至少保留两个上一版本**（`--keep-previous`
   不能小于 2）；`rollback` 只恢复 release 指针、profile manifest/lock 和客户端资源，
   不回滚会话日志、队列或审批，也不重发不确定请求。

幂等：同一 `manifest` 再装一次，若指针、overrides、link 依赖都指向该 release，安装器
直接返回 `changed: false`，连 `state.json` 都不写。

## `file:` overrides 的退路

若 `file:` tarball overrides 在 pnpm 下没有生效（原版与扩展版混载），用
`--style directory`：安装器把 ext tarball 解到
`<DSH_HOME>/hapi-dsh/unpacked/r-<hash>/<pkg>/`，overrides 改指解包目录，重复同一套解析
检查。仍出现混载时安装失败、不启动，旧 active 保留。

## 对接真实 dsh-ext 产物

ext 仓库发布后，给它一个 release 目录（例如 `dsh-ext/ext/releases/<tag>/`）：

```json
{
  "upstreamVersion": "0.2.1-rc.3",
  "upstreamCommit": "1f81c047fc48fa190a683e469daa699857e9afe8",
  "extRelease": "0.2.1-rc.3.ext.1",
  "patchSetSha256": "<64 hex>",
  "compositionVersion": "1",
  "protocol": 2,
  "capabilities": { "historySource": 1, "mountedChat": 1, "windowCommit": 1 },
  "packages": [
    { "name": "@deepseek-ai/dsh-client-ui-chat", "version": "0.2.1-rc.3.ext.1", "tarball": "dsh-client-ui-chat-0.2.1-rc.3.ext.1.tgz" }
  ],
  "licenses": ["LICENSE"],
  "sourceOffer": ["patches/0001-history-source.patch"]
}
```

然后：

```bash
npm run bundle:pack -- --ext-release /path/to/that/release-dir
npm run bundle:pack:fixture -- --tmp /var/tmp   # 宿主 TMPDIR 只读时用 --tmp 指定可写目录
```

`pack.mjs` 会核对每个 tarball 内的 `package/package.json` 名称与版本，再计算
`packageSetSha256` 和 `releaseId`。没有真实 payload 时用 `--fixture`：
`scripts/bundle/fixtures/ext-release/` 里是**占位**包（未修改的官方包结构，`fixture: true`），
只能证明布局、安装、overrides、回滚和 doctor 机制，不能当作 ext 产物或验收证据。

## 状态文件

`<DSH_HOME>/hapi-dsh/state.json`：

```json
{
  "version": 1,
  "profiles": {
    "hapi": {
      "role": "host",
      "active": { "releaseId": "...", "manifestSha256": "...", "treeDigest": "...", "managedOverrides": {} },
      "previous": []
    }
  },
  "releases": { "<releaseId>": { "dirName": "r-...", "manifestSha256": "...", "identity": {} } },
  "attempt": null,
  "history": []
}
```

升级尝试严格按 `downloaded → verified → staged → doctor-passed → waiting-idle →
activating → healthy` 前进；任一步失败把 attempt 标成 `failed` 并保留旧 active。
`runtime.json` 是 Host/Runner 的可选快照（`role`、`pid`、`busySessions`、`identity`），
doctor 用它做实时 release identity 比对；文件不存在时该项如实标为 warning。

## 测试

```bash
npm run test:bundle
```

测试里的官方 launcher 与 pnpm 都是 fake（`tests/host-bundle-support.test.ts`），
覆盖：bundle 布局与哈希、幂等、overrides 合并冲突、升级保留窗口、回滚指针、
健康门失败自动回滚、waiting-idle 与恢复、doctor 各项检查与脱敏。
