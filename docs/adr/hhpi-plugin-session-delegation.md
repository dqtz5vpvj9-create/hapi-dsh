# 官方消息插件的委托与来源翻译存储

2026-11-11，基线 DSH 0.2.2-rc.1 / `66491b05`。

## 已确认的问题

HHPI 的 `source-transcript` 在包装官方 `assistant-step` 时，将 `renderSlot` 替换成直接调用 reasoning/images 的内容 Factory。这样会跳过 `conversation.chat.reasoning.body` 上已启用的官方翻译插件，普通 DSH 会话也经过这个包装。线上启动图包含翻译插件，`cotTranslation/limits` 已能返回用户保存的偏好；未安装或未启用不是这次故障的原因。

直接复制 `children` 也不可行：官方 SlotCore 的子插槽只有一个声明者，重声明会破坏注册授权和卸载生命周期。修复需要保留原注册的席位和子插槽所有权。

恢复插槽后，翻译服务还有第二处实际边界：带 Session ID 的请求强制使用本地 DSH 会话日志。Codex 来源具有真实原生身份，却没有该本地 Session writer。用 `resolveAgent` 激活它会制造错误的执行归属。

## 决定

在 `client/ui-slots` 和 `client/ui-renderer` 增加可选 `delegate: StoredEntry`。它只能引用同一插槽单元中的存活注册，继承原注册的 inject、store、locale 和子插槽渲染席位，同时使用当前的 SessionBinding。包装注册不取得子插槽所有权；移除包装后原注册与子插槽声明代际保持。引用失效后旧渲染授权明确拒绝。没有 delegate 的注册行为不变。

HHPI 助手包装只调整来源的 disclosure 行为和计划动作，其他渲染委托官方注册。因此推理正文、图片和后续同槽插件继续通过官方选择与生命周期。

在 `experimental/translator` 增加可选 `registerStorageProvider`。provider 收到精确 Session ID、调用者 Context 和取消信号；返回 `undefined` 使用原 DSH writer，已认领的来源发生失败直接拒绝。外部 owner 只实现现有翻译 request/result 的持久复用，不提供 Agent 或完整会话。`TranslationLog.assertCurrent` 可在外部请求派发前复核来源授权。官方付费翻译仍使用既有 llm、credentials、模型与审计流程，无新增 paid query owner。

`experimental/client-ui-cot-translation` 保留现有 UI、偏好和 reactive 更新，只为 translate Remote 声明其 Session 资源。HHPI 在来源 Host 的私有 `application/translations.sqlite` 中保存翻译，按认证 principal 和完整来源 ID 隔离。缓存读取、请求、外部派发和结果写入均复核真实 gateway 归属与授权。未知或拒绝的 HHPI ID 不回落到普通 DSH writer，也不激活原生任务。关闭 disclosure 取消该读者的请求；另一个 Pane 可独立继续。

四个 DSH 修改包中，ui-slots/ui-renderer 已在既有集合，translator/cot-translation 新增到统一的 24 包源码发行。源码补丁、锁定基线与上游提案一同归档。其余显式拒绝 child/store 的现有包装保留原边界。

## 验证边界

`tests/source-translation.test.ts` 检查持久缓存、账号与完整来源隔离、取消后的迟到结果、跨 Pane 继续、缓存读取和外部派发前撤权，以及 ordinary/未知/未认证来源的分派。

上游源码具名测试覆盖 delegate 的单一声明者、原始注入与子插槽渲染、失效授权，以及真实 native Flash adapter 对外部存储 owner 的使用。图片组件检查官方子插槽被保留，直接内容 Factory 不再绕过插件。官方 Reader/翻译插件的贯穿行为由发布浏览器检查，真实翻译服务调用另行验证；独立 Node 读者 fixture 的 carrier 加载失败不算产品行为通过。发布、实际浏览器和真实服务结果由该轮的独立证据记录，本文不把源码或组件通过当作已上线。
