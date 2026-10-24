# 常驻官方环境与快速验证

这条开发路径保留一个 pinned DSH `0.2.1-rc.3` Host 和一个 Chromium 进程，使用明确的合成 HAPI wire fixture。它减少反复安装 profile、启动 Host、准备同一份目录的成本。浏览器仍执行官方 AppFrame、Conversation、SessionProvider、editor 和插件加载器；不会连接生产 Hub、执行真实 Codex 模型或改动用户会话。

当前版本的升级验收见 [rc.3 升级记录](dsh-rc3-upgrade.md)。本文下半部分的具体耗时与通过记录来自 rc.2 环境，保留为历史基线，不是 rc.3 的验收结果。升级依赖后应重建并重启合成 Host，不能用仍加载旧依赖的常驻进程验证新版本。

## 使用

先完成一次完整构建，然后在专用终端启动：

```sh
npm run build
npm run e2e:warm -- serve
```

另一个终端反复执行：

```sh
npm run e2e:warm -- check
npm run e2e:warm -- status
```

`check` 输出八个检查点的独立耗时、总耗时、Host/browser 启动计数和新增 graph 请求数；任一检查失败时退出码为 1。第一次检查启动 Chromium，以后的检查复用这个进程。每批检查新建 browser context，并在旧页面关闭后通过带 revision 的公开 workspace API 重置合成布局；每批的 localStorage 和 draft 状态不会互相污染；官方 notice 在这个合成 Host 上第一次真实确认后继续保留其确认状态。合成的发送检查会通过真实取消 UI 撤销自己刚提交的队列项。若某批失败，工具会重启这一个合成环境，避免把残留状态带进下一批。

这是同一场景内八个连续检查点，不等价于八份完整 spec，也不代替已有的专项回归测试。检查范围是 workspace/sidebar、首次 transcript/composer、共享 split、draft/focus 隔离、Enter 与 queued-edit、审批归属、上一轮历史、reload 恢复与关闭不终止执行。大型历史、epoch churn、远端隧道和全部 composer 行为仍由对应专项测试验证。

## 客户端热更新

客户端改动可以单独构建：

```sh
npm run e2e:warm -- rebuild-client
```

命令只编译客户端 bundle，不重建 Host 或生成类型声明。它等待官方 `dsh-client-hmr` 发布新的 graph revision，然后重新加载当前测试页面。Host 和浏览器进程继续运行。bundle 使用临时文件加原子 rename 发布，避免官方轮询看到半写入文件。

自动模式在启动时启用：

```sh
npm run e2e:warm -- serve --watch
```

`src/client` 变更会去抖后执行同样的客户端编译、官方 HMR 发布确认和页面重载。Host/shared 源文件的变更会标记 `restartRequired`，暂停冒烟检查，直到运行：

```sh
npm run e2e:warm -- restart
```

`restart` 完成完整构建并重启这个合成 Host。配置、依赖、provider fixture 或构建脚本发生改变后也应执行此命令。`rebuild-client` 不替代 `npm run typecheck`、完整构建或发布前必要的定向测试。需要可见浏览器时，可在支持显示服务的开发机上为 `serve` 加 `--headed`。

退出时：

```sh
npm run e2e:warm -- stop
```

Ctrl+C / SIGTERM 也会关闭 fixture 子进程、浏览器和临时环境。控制通道使用仅当前用户可访问的本地 Unix socket；没有额外网络管理端口。日志与状态不包含 launch token。程序化探针可以通过 `e2e/warm-control.ts` 的 `requestWarm('connection')` 在内存中取得临时 admission URL；不要把这个结果写入日志、测试报告或提交。

## 验证边界

- `coldHostMs` 包括官方测试环境准备、Host 启动和合成目录就绪，不能当成生产网页冷启动时间。
- 每批保留全新的 browser context，包含一次实际页面 graph 冷加载；批中的 reload 检查还会再加载一次页面。复用的是 Host 和浏览器进程，不是跳过页面初始化。
- `graphRequestsForSplit` 在实际 split 操作前后记录 bundle/bootstrap 请求差值，必须为 0。
- 合成 fixture 与本地网络的耗时不能替代生产 p95、远端 RTT 或用户大型目录数据。
- 首轮与后续轮应分别记录，并同时给出 Host/browser 启动计数。只报单条 assertion 执行时间会遗漏环境成本。

## 工具接入实测（2026-10-22）

以下是新工具在接入时复用上一版已构建的 shared 路径的本地测量，用于证明环境复用。它不是本轮全部产品修复后的最终性能数字，也不是生产网页性能。Chromium 使用项目设置的 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`；无远端 Runner，源会话全部为合成 fixture。

| 范围 | 耗时 | 结果 | 累计 Host / browser 启动 |
|---|---:|---|---:|
| 首次官方 fixture 准备与目录就绪 | 10.921 s | ready | 1 / 0 |
| 第一批八检查点，含浏览器首次启动与两次页面加载 | 12.959 s | 8/8 | 1 / 1 |
| 第二批八检查点，重新创建 context 和重置布局 | 7.426 s | 8/8 | 1 / 1 |

两批 split 的新增 bundle/bootstrap 请求均为 0，页面错误均为 0。首批 workspace 检查 4.715 s，第二批 2.589 s；这两个数字还包括检查点自身的页面 admission / assertion 开销。工具省去了下一批的 Host 冷启动；它没有让产品的冷启动本身变成零成本。

## 本轮 warm 验证检查点与 HMR 验证

本轮 warm 检查点的完整构建完成后，关闭旧 daemon、从当时的 harness 源码重新启动无 watcher 的环境，再顺序运行 `check` → `rebuild-client` → `check`。这组测量发生在后续 composer 布局两次修正之前，不代表最终提交精确字节的验证；最终定向回归另见 [validation.md](validation.md)。首次 fixture 准备为 **23.283 s**，包含新构建对应的 profile template、官方 Host 启动与目录就绪；这部分只支付一次。

| 操作 | 耗时 | 结果 | 累计 Host / browser 启动 |
|---|---:|---|---:|
| 第一批八检查点 | 11.633 s | 8/8，无 pageerror | 1 / 1 |
| 客户端独立编译 | 1.349 s | bundle 发布成功 | 1 / 1 |
| 独立编译、官方 HMR revision 确认、页面重载合计 | 4.288 s | `officialHmrPublished: true` | 1 / 1 |
| HMR 后第二批八检查点 | 14.930 s | 8/8，无 pageerror | 1 / 1 |

第一批与一次 E2E 类型检查短暂重叠；第二批是没有其他已知测试/构建并行任务的主要记录。两批 split 的额外 bundle/bootstrap 请求均为 **0**。第二批变慢也保留在记录中，不用接入时较快的旧构建结果代替本轮结果。

第二批的页面导航标记如下，单位毫秒，均相对各次导航自己的时间原点：

| 导航 | 布局节点插入标记 | 首次内容绘制 FCP | 实际 workspace 可见标记 |
|---|---:|---:|---:|
| 全新 browser context | 84.7 | 308 | 5965.4 |
| 同一批内的已保存布局 reload | 154.8 | 200 | 2164.3 |

布局标记与 FCP 说明初始框架已经出现，**不能代表正文、composer 或实际 workspace 已经就绪**。第二批的首次会话 transcript/composer 检查点仍耗时 **2347 ms**（第一批为 430 ms）。这个检查点包括 Playwright 点击与 actionability、正文/composer 等待及断言，不是独立的浏览器 click→body 探针；它依然说明首开存在明显波动，不能据此宣布首开速度问题已经修复。共享 split 检查点为 434 ms，同样包含交互和断言开销。

该验证证明常驻环境、重复检查和客户端 HMR 发布通路已经可用；完整旧 spec 的独立 fixture 生命周期没有被改写。
