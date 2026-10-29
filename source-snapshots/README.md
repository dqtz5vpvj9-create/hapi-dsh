# 配套源码快照

这里保存 HHPI/V4 当前实现依赖的相邻仓库源码变更，供外部 Agent 在没有原机器的情况下恢复。它们是可应用补丁，不是新的运行时发布，也不表示连续阅读已经验收通过。

| 快照 | 上游基线 | 范围 |
| --- | --- | --- |
| `dsh-ext/source.patch` | `deepseek-ai/deepseek-harness` 的 `1f81c047fc48fa190a683e469daa699857e9afe8` | 三个相关包的源码/测试，以及 ext 源码、ADR、补丁系列与 PR 草稿。 |
| `hapi/source.patch` | `dqtz5vpvj9-create/hapi` 的 `55166cf8d87814ccfb383b538a8e8c55283bed81` | 原工作区的 HAPI 源码、测试、构建及运维脚本变更。 |

完整变更路径记录在 `manifest.json`。不包含已安装依赖、包缓存、运行日志、ext 编译包、生产 profile、凭据或本机桌面上下文记录。已有许可证随各快照保存；原始仓库的许可证和来源声明继续适用。

## 恢复源码

在所需仓库的干净 clone 中 checkout 对应基线后，使用本仓库的补丁绝对路径：

```bash
git checkout --detach 1f81c047fc48fa190a683e469daa699857e9afe8
git apply --check /path/to/hapi-dsh/source-snapshots/dsh-ext/source.patch
git apply --whitespace=nowarn /path/to/hapi-dsh/source-snapshots/dsh-ext/source.patch
```

HAPI 使用其上表基线和 `hapi/source.patch`，步骤相同。DSH 的此完整补丁已经包含 ext 改动，**不要在它之后再次应用 `ext/patches` 的历史系列**。快照生成时已分别在干净 Git index 上验证可应用，并核对恢复的源码树与所选原工作区源码一致；没有重置或修改相邻仓库工作区。

## 构建与安装边界

按照恢复后仓库的 `AGENTS.md`、`package.json` 和 package manager 版本安装、构建、运行受影响测试。DSH 的历史 `ext/scripts/pack.mjs` 仍有本机 registry 路径假设，外部环境打包前需改成自己的依赖位置；不能直接照搬 `/mnt/cache/src`。

本仓库依赖声明仍固定官方 rc.3。官方 npm 包与恢复后的扩展源码不同：源码可恢复，不代表一次 `npm ci` 就安装了本机的 ext.18。原机器的编译包与 profile 没有装入这些补丁，也没有自动发布到 npm。外部实现者需要显式构建、打包并为 Host/Runner 安装同一扩展组合，或在 HHPI 重构中去掉相应依赖。

`ext` 中的旧六门禁材料仅作源码历史。新的测试与阅读验收以本仓库 `AGENTS.md`、`docs/testing.md` 和 `HANDOFF.md` 为准，不恢复旧的整夜测试流程。
