# 配套源码快照

这里保存当前 DSH 扩展的完整源码补丁，以及迁移和离线恢复所需的历史来源。源码身份由 [manifest.json](manifest.json) 和 [UPSTREAMS.json](../UPSTREAMS.json) 记录；运行实例的版本与验收结果另由对应正式发行记录确认。

| 快照 | 上游基线 | 用途 |
| --- | --- | --- |
| [dsh-ext/source.patch](dsh-ext/source.patch) | DSH `0.2.2-rc.1`，提交 `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db` | 当前完整二十二包扩展的合并源码与契约测试，对应 `hhpi-dsh-022-20261107.27`。 |
| [dsh-ext/releases/0.2.1-rc.3](dsh-ext/releases/0.2.1-rc.3) | 提交 `1f81c047fc48fa190a683e469daa699857e9afe8` | 旧 rc 的补丁、增量和构建转换，仅供历史对照。 |
| [hapi/source.patch](hapi/source.patch) | HAPI fork 提交 `55166cf8d87814ccfb383b538a8e8c55283bed81` | 已退休 HAPI 运行链路的历史源码、测试与运维来源，仅供迁移核对和显式离线恢复。 |

这里不保存已安装依赖、包缓存、运行日志、编译包、生产 profile、凭据或本机桌面上下文。原始许可证和来源声明继续适用。

## 准备当前 DSH 源码

在本仓库根目录运行受维护的准备脚本：

```sh
node scripts/dsh-ext/prepare.mjs /mnt/cache/data-cache/hhpi-source-preparation
```

脚本输出 JSON，其中 `directory` 是恢复后的源码目录。它检出固定上游提交，仅应用当前完整 `source.patch`，并记录补丁身份；已有目录只有通过源码校验才复用，不覆盖已修改的目录。可通过 `DSH_SOURCE_REFERENCE` 指定含固定提交的本地 checkout，以复用 Git objects。

当前补丁已经包含对应的原生持久化、阅读布局和其他扩展。不要在其后重放旧 rc 的 `native-persistence.patch`、`ui-chat-layout.patch`、历史 `ext/patches` 系列或构建转换。

## 构建、安装与历史边界

当前依赖固定为 DSH `0.2.2-rc.1`，源构建使用 upstream 锁定的 `pnpm@11.28.5`。按[扩展安装说明](../docs/hhpi-extension-install.md)运行 `build-extension.mjs`、`create-release.mjs` 和 `install-extension.mjs`，构建并校验完整二十二包集合。`npm ci` 只还原包锁声明的原版依赖，随后仍须显式安装完整扩展；相同 npm rc 版本字符串不能证明扩展已安装。正式 Host/Runner 分发与回滚见[分发说明](../docs/distribution.md)。

旧 rc 的增量及其原有恢复说明归入 manifest 的 `previousRc`，不属于当前准备步骤。HAPI 快照也不恢复为产品运行依赖；需要读取历史记录时，使用[独立离线恢复工具](../docs/offline-recovery.md)。

源码、构建、部署、浏览器交互与物理设备是不同证据层。测试与实际路径验收沿用本仓库 [AGENTS.md](../AGENTS.md) 和[测试说明](../docs/testing.md)；历史门禁材料不作为当前验收结论。
