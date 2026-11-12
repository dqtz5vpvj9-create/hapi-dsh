# 独立离线恢复工具

该归档与 HHPI 工作区 bundle 分开发行，只需 Node.js 24 或更新的版本。它不注册 DSH 插件，不读取启动配置或凭据，不连接 Hub、Runner 或 app-server，也不创建 Agent、发送消息、恢复通知或接管终端。主产品继续拒绝旧 HAPI 配置。

解压维护者提供的 `hapi-dsh-offline-recovery-VERSION.tgz`。归档内含可执行入口、已打包的依赖、对应源码、AGPL 声明和 Zod MIT 许可，无需 npm 安装：

```text
tar -xzf hapi-dsh-offline-recovery-VERSION.tgz
node package/cli.mjs --help
node package/cli.mjs recover-browser --input PRIVATE_BROWSER_EXPORT.json --output NEW_PRIVATE_DIRECTORY
```

输入必须是工作区“本机恢复”下载的完整浏览器导出。工具保留原始导出，并将 Blob 分别保存为二进制；草稿、附件、冲突基线和未知对象留在恢复包中。查看 `NEW_PRIVATE_DIRECTORY/recovery/index.html` 与 `index.json`。`needs-review` 表示需要人工核对原身份，并不表示原始字节丢失。输入不会被改写，输出应保存在私有、长期保留的目录，不使用会自动清理的缓存作为唯一备份。

不会把旧无账号数据猜配给新账号，也不会自动导入当前草稿。浏览器原件仍留在原存储；需要导入时另行核对账号、原 Host、源及当前文件版本。恢复包可能包含私密文本和附件，不上传到公开仓库。

仅抽取浏览器附件或捕获已选定的原始导出时可用：

```text
node package/cli.mjs extract-browser --input PRIVATE_BROWSER_EXPORT.json --output FRESH_EXTRACTION_DIRECTORY
node package/cli.mjs capture --request PRIVATE_REQUEST.json --output PRIVATE_RECOVERY_DIRECTORY
node package/cli.mjs resume --output PRIVATE_RECOVERY_DIRECTORY
```

`capture` 请求格式由 `SOURCE/scripts/migrations/hapi-offline/contracts.ts` 的 `offlineRequestSchema` 定义。只选择明确的输入文件；SQLite 输入必须是已有的一致性备份，不能把运行中的数据库/WAL 当作离线快照。`resume` 仅重建已有恢复包的索引与未完成的文件物化，不执行源端操作或自动开始转换。浏览器抽取目标必须是新目录；转换失败的原件和部分输出应保留。

需要精确别名或领域转换时，从 `api.mjs` 导入现有 `runOfflineMigration`、`createSessionsStage`、`createFilesStage`、`createTerminalsStage` 和 `createApplicationStage`。各工厂的选项及原始格式与归档内对应源码一致；向 `runOfflineMigration(request, output, stages)` 显式传入所选工厂。原始 machine/source/engine/nativeId 和账号边界不得按标题、路径或时间猜测。转换结果仍是离线对象，主产品不会自动加载这个目录。PTY 文本只能作为历史输出保留，不能冒称同一进程已迁移；旧 Push endpoint 和 display 水位也不能直接重放。

维护者在当前 checkout 运行 `npm run recovery:pack -- --out ABSOLUTE_DIRECTORY` 生成本归档。它与主 `bundle:pack` 独立；主工作区不依赖或加载此工具。归档内 `manifest.json` 列出实际打包源码、内置依赖与 Node 导入，`SOURCE/` 和 `LICENSES/` 保留对应材料。需要重建工具时，在 `SOURCE/` 安装其固定版本的 Zod 与 esbuild，再执行同一 `scripts/migrations/hapi-offline/pack.mjs`；已编译的用户入口无需这些开发依赖。
