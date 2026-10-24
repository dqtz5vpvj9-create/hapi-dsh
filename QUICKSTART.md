# 安装 HAPI DSH 0.1.2

Windows、macOS 和 Linux 使用同一个 `.tgz` 包。先安装 Node.js 24 或更新版本（自带 npm），在终端执行 `node --version` 确认版本。安装依赖需要联网，不需要 Git、Bun、源码编译或单独安装 DSH。

需要已有的兼容 HAPI Hub 地址和访问令牌；向维护者取得这两项。若只想访问别人已经部署好的工作区，直接用浏览器打开入口即可，无需本地安装。HAPI Hub 与 Runner 的准备说明见仓库的 [docs/install.md](https://github.com/dqtz5vpvj9-create/hapi-dsh/blob/main/docs/install.md)。

## 下载与安装

取得 `hapi-dsh-0.1.2.tgz`，终端进入下载目录，执行：

```text
npm install --global pnpm@11.28.5 ./hapi-dsh-0.1.2.tgz
hapi-dsh --version
```

应输出 `0.1.2`。pnpm 用于官方 DSH 插件管理，首次创建 profile 时也会联网下载依赖，请等待命令结束。

Windows 可在命令提示符或 PowerShell 中运行；如果 PowerShell 拦截 `.ps1` 命令，使用 `npm.cmd` 和 `hapi-dsh.cmd`，无需修改系统执行策略。macOS/Linux 若全局 npm 目录无写权限，可使用自己的 Node 版本管理器，或采用下方的本地安装方式。

## 连接自己的 HAPI

将示例地址换成实际 Hub 地址，四条命令在三个系统上相同：

```text
hapi-dsh init --hapi-url http://127.0.0.1:3006
hapi-dsh login
hapi-dsh doctor
hapi-dsh start
```

`login` 提示输入令牌，输入内容不回显，保存在当前用户的私有配置中。以后启动直接运行 `hapi-dsh start`，不需要每次设置环境变量。已有的 `HAPI_DSH_TOKEN` 环境变量仍优先于保存的令牌。

默认浏览器地址为 `127.0.0.1:3080`，通过启动时打开或打印的登录链接进入。保持终端运行；`Ctrl+C` 关闭本地 Web Host，不结束原生 HAPI 会话。登录链接和配置文件含凭据，请勿作为安装包转发。

## 无管理员权限：安装到当前目录

在一个准备长期保留的目录里执行（不要放在会自动清理的临时目录）：

```text
npm install pnpm@11.28.5 ./hapi-dsh-0.1.2.tgz
npm exec -- hapi-dsh init --hapi-url http://127.0.0.1:3006
npm exec -- hapi-dsh login
npm exec -- hapi-dsh doctor
npm exec -- hapi-dsh start
```

以后从该目录运行 `npm exec -- hapi-dsh start`。`npm exec` 会将本地 pnpm 加入 PATH。不要用临时 `npx --package URL` 启动，因为 DSH profile 会引用安装目录。

## 升级与排障

退出本地 Web Host，安装新的 `.tgz`，运行 `hapi-dsh install` 更新原 profile，然后重新启动。已有配置、会话和第三方插件会保留。不要再次 `init` 覆盖配置。

- 初始化中断：运行 `hapi-dsh install` 重试。
- 只检查本机安装：运行 `hapi-dsh doctor --offline`。
- Hub 认证失败：确认地址和命名空间，重新运行 `hapi-dsh login`；检查是否有旧的 `HAPI_DSH_TOKEN` 环境变量覆盖配置。
- 使用自定义配置：给后续命令都加上同一个 `--config "配置文件路径"`。
- 加入他人的 DSH 机器目录：让维护者提供私有配对文件，再使用 `hapi-dsh runner init --pairing-file "文件路径"` 和 `hapi-dsh runner start`，无需配置 HAPI 令牌。

这份包仅包含软件与公开源码，不包含维护者的账户、Hub 地址、访问令牌或会话数据。
