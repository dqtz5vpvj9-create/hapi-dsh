# 独立离线恢复发行入口

使用与恢复边界见[离线恢复说明](../../../docs/offline-recovery.md)。在 checkout 运行 `npm run recovery:pack -- --out ABSOLUTE_DIRECTORY` 生成独立归档；`cli.mjs` 只在该归档中与已编译的 `api.mjs` 一起执行。它不进入主产品的 runtime 或 bundle payload。
