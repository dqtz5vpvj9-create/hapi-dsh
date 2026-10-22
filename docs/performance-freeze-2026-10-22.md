# 侧栏预热导致页面冻结（2026-10-22）

用户提供 `Trace-20261023T002253.json.gz`，并确认整个页面不能滚动或点击。此次未运行浏览器测试或截图。

## 已定位的冻结原因

CPU 栈显示：`onPointerEnter → preloadSession → warmSession → update → release → retireScope → projectList → warmRecent → update → pump → retain`。同一操作同时触发 `onCatalog`、`reconcileLeases` 和全量 `aggregateCatalog`。

`createSessionWarmup.update` 在遍历可变 Map 时释放引用。官方引用释放会同步发布目录；`warmRecent` 随即把后台候选重新加入正在被遍历的 Map，外层迭代又释放这些候选。JavaScript Map 迭代器会继续访问重新插入的条目，因此一次鼠标移入就能困在该调用链中。

## 修复与证据

- 先提交完整的新候选集合，再遍历旧集合的快照释放引用。重入更新是更新的请求，外层释放结束后不再覆盖它。
- 目录通知只维护主动访问/悬停过的会话，不再自动补入五个无关的最近会话。
- 使用公开 SessionReference 协议构造同步目录通知的逻辑回归用例：旧版本触发 `eviction/reacquisition loop`，修复后通过；九项预热逻辑测试通过。这是 Node 协议测试，不是浏览器验收。

## 分开记录的服务端状态

排查时认证请求约 92ms，session/list 约 213ms，hapi/catalog 约 43ms；展示进程 RSS 约 3.7GiB、平均 CPU 约 88%。8 秒 CPU 采样还发现历史缓存同步写盘、历史解析和官方 source map 构建热点。这些不是此次浏览器同步重入循环的替代解释，也没有被此次前端修复解决。

临时 CPU 调试入口仅监听回环地址，采样完成后关闭。没有重启 HAPI Hub、Runner 或中止任何原生执行。此次只构建、发布客户端；冻结标签页需要重新加载才能执行新代码。
