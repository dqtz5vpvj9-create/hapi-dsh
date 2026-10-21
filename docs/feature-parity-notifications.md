# 原 HAPI 通知、角标与安装能力

本实现使用固定 HAPI 上游已有的 Push 与 visibility 协议，通过官方 DSH 的 `settings.section`、`shell.overlay` 公开插槽挂入同一工作区。没有修改 DSH 或 HAPI 上游，也没有向浏览器下发原 Hub 的认证 token。

## 已实现的产品路径

| 能力 | 实际路径与边界 |
| --- | --- |
| 前台原 HAPI 通知 | 原 `/api/events` 的 `toast` → Host 通知 WebSocket → 主工作区唯一 overlay；保留原标题、正文和源会话身份。 |
| 后台 Push | 用户明确点击启用 → 浏览器通知权限与 `PushManager` → 原 `/api/push/subscribe`；停用先撤销本浏览器 endpoint，再向原 Hub 删除订阅。 |
| 未确认的订阅写入 | 失去 POST 回执显示未确认，不自动重发；刷新浏览器状态只读；用户可以明确发起新注册。 |
| 点击通知 | `hubId + sourceSessionId` 交给统一工作区导航；不把 HAPI ID 当作 DSH ID，不跟随通知中任意 URL。原窗口明确确认接收后聚焦，无法接收则打开新的同源窗口，保留原窗口的未保存内容。 |
| App Badge | 使用统一侧边栏相同的 eligible root 会话与 source read watermark；默认关闭，原 `hapi-app-badge-enabled` 偏好保留。临时连接/读取失败返回未知并保留上次系统数量。 |
| 安装入口 | 接浏览器 `beforeinstallprompt` / `appinstalled`；Safari 显示添加主屏幕步骤。用户接受安装提示不等于已安装，只有真实安装事件更新状态。组合 manifest 由官方 WebServer 的公开命名路由提供，不修改上游静态资产。 |
| 通知 worker 更新 | 按应用路径注册同源 worker，检查并显示待更新状态；不擅自刷新活动编辑器，也不覆盖其他应用的 worker。 |

## 可见状态只代表真实页面

原 HAPI 决定是否发送 Push 时，会区分可见浏览器和后台客户端。因此 Host 后台 SSE 默认以 `visibility=hidden` 连接，不能把持久运行的桥接进程当作一直可见的页面。

每个真实浏览器通过认证 WebSocket 报告前台/后台状态，10 秒续约一次，30 秒失效。只有至少一个未过期的可见浏览器，才通过原 `/api/visibility` 更新当前原始 `subscriptionId` 为 visible。隐藏、关闭、断线和失去续约都会回到 hidden。迟到的 visible 回执与后续 hidden 按顺序处理。若 hidden 写入失去回执，关闭旧 SSE 并以最新 hidden 状态重连，避免后台进程无限压住 Push。

Push 配置与前台通知互不阻断。原公开 VAPID key 读取失败时仍返回稳定 Hub 身份与通知连接位置；前台 presence / toast 正常工作，设置只显示安全的 Push 配置错误。没有假造公钥，也不会透出原请求 URL、token 或异常响应体。

## 浏览器中的数据和权限

- 页面加载不会请求通知权限，也不会创建或自动登记 Push 订阅。权限只在用户明确点击启用时申请。
- localStorage 只保存公开 VAPID key 和订阅确认的 Hub 身份、endpoint 哈希。不会保存 Push endpoint 能力地址、Push 密钥或原 HAPI token。
- 注册前通过公开 `MessageChannel` 向实际 active worker 确认 Hub 和应用路径。旧 Hub 的 active worker 不能替新 Hub 接收订阅。
- worker 负责通知、同源源会话导航及显式 Web Share Target POST；不缓存认证 API 响应，也不接管普通文档 GET 或其他 API 请求。
- 普通页面关闭不撤销 Push 订阅，也不自动 unregister worker；这正是后台通知需要保留的浏览器能力。

## 已有验证及未声称的验证

`tests/hapi-notification-presence.test.ts`、`tests/hapi-source-notifications.test.ts`、`tests/hapi-notification-worker.test.ts`、`tests/client-notifications-runtime.test.ts` 的 19 项通知回归通过；组合 Share Target 后增加的普通 GET / API 不拦截边界回归也通过，当前共 **20 项**。其中包含真实本地 HTTP/WebSocket、原 SSE 数据解析、租约失效、未经认证的连接、订阅写入失回执、实际发出的 worker 源码执行、旧 Hub 拒绝、浏览器安装/Badge 生命周期 fixture。另原 HapiClient 17 项与 presence 4 项联合运行 **21 项通过**。

`e2e/notification-plugins.spec.ts` 两条官方 DSH Web profile / Chromium 156 浏览器验收已通过；组合 Share Target handler 后再次运行仍通过（7.2 秒、6.9 秒）：

- 真实源 SSE → 通知 WebSocket → 官方 overlay → `native-beta` 的官方 Conversation；通知中的外部 URL 没有被跟随。VAPID 503 不阻断前台提示，真实 service worker 已注册，页面和设置加载没有自动申请权限，关闭最后一页后原 source visibility 变为 hidden。
- 真实 active worker 通过 Hub/应用路径身份握手；设置页验证一次 POST 失去回执后保持 unknown、只读刷新不重放、明确注册后确认、订阅能力和密钥不入 localStorage、原侧栏未读数驱动 Badge、停用撤销浏览器订阅。

截图已人工检查，设置页使用官方对话框与主题，源会话仍在统一侧栏。PushManager 与系统 Badge 明确是浏览器协议 fixture，不能据此声称真实外部 Push 服务、iOS/Android 操作系统投递或第三方账号验收。

本页不把通知 worker 等同于完整离线应用缓存。主集成已加入独立 `src/notifications/share-worker.ts`：仅拦截当前应用路径精确的 `/hapi-dsh/share` POST，将有边界的 Blob 暂存到原 Share Transfer IDB 后跳转统一 shell；此新增 Share Target 完整浏览器流程的验收由分享模块单独记录。离线 shell 与原生更新草稿事务也须分别验证，不由通知测试替代。

## 代码与上游依据

源码位于 `src/notification-types.ts`、`src/hapi/source-notifications.ts`、`src/hapi/client.ts`、`src/notifications/worker.ts`、`src/client/source-notifications/`、`src/workspace/notifications.ts`。主工作区负责唯一安装与严格源导航，窗格 graph 不重复创建通知 owner。

原 HAPI 固定 commit 的 `hub/src/web/routes/push.ts`、`hub/src/web/routes/events.ts`、通知渠道、`web/src/sw.ts`、`web/src/hooks/usePushNotifications.ts` 与 App Badge / PWA hooks 用于核对原协议与交互语义；上游版本见 `UPSTREAMS.json`。worker 与桥接代码为本插件实现，不是对上游 service worker 的修改副本。
