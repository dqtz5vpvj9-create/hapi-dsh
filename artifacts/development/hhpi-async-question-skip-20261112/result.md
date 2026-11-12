# 同一异步问题跳过后重新出现

已正式上线 `60dacf1c…`。原床垫会话只读检查及隔离会话官方 Skip→刷新→重开两条场景均通过；已亲看实际页面保存的 DOM/CSS 经固定 webshot 生成的图片。用户原问题、队列、历史和工作区未被改写。

## 原因与用户影响

床垫会话只有一个原生异步问题。已保存的源回执证明，用户的合法空答案 Skip 曾被 `thread/queue/add` 持久接受；源端问题投影仍只认后来的原生 `userMessage` 为结算。队列条目不再可见而问题仍 pending 时，官方问答组件会重新显示同一张卡；再次提交又命中原操作的 accepted 回执。现有只读证据不说明旧队列条目为何消失，也不证明模型已消费该跳过。

## 修复

明确 Skip 获源端持久 accepted 后，记录这次用户决定并撤掉同一问题、同一修订的卡片。旧回执恢复要求原 source/thread、channel operation ID 与完整空答案 fingerprint 一致；新 question ID 或修订仍可显示。普通答案仍按原生显式回复结算。拒绝、缺失和结果未知时保留问题，不补发原操作。

新的 ledger stored 只读快照不等待当前 in-flight promise，也不 reconcile/执行写入；原 lookup/run 不变。迟到恢复合并同 coordinates 的已提交 Skip，不能覆盖新决定。没有新增 UI、SDK 接口或 HHPI wire 字段，不改原生历史/队列，也不自动继续停止的执行。

## 已执行检查

- 22 项针对性 Node/生产 Adapter、持久索引和公开 Cordis provider 检查通过；原生 RPC 与 metadata 为明确隔离边界。2 个旧可选 native loopback 用例本轮未执行。
- Host 类型检查通过。
- 原生普通 DSH namespace 委托与未知来源拒绝沿既有用例复用。
- 初次误用 Node strip-only loader导致参数属性语法加载失败，保留；改用仓库 tsx 后运行。第二次旧修订断言未触发刷新而失败，补上实际重开/通知边界后通过，未掩盖原失败。

检查 span：`4b21a7a2-95f0-4a75-948b-09129c774346`（22 pass / 2 skip），`e90cbfd5-a4f4-469b-98f5-5a7b8c936cb6`（Host types）。

## 交付边界

不可变冻结为私有 `hhpi-async-question-skip-20261112/freeze.json`。3 个生产叶、2 个既有测试叶和 ADR；生产 before 与正式发布工作目录一致。SDK .29/client/helper不变。发布与实际 UI 结果由本路径负责人继续补充，源回执 accepted 不等同模型读取成功。

## 正式界面结果

- 原床垫会话：6.080 秒，原 pending 1→0，旧问题卡 0，当前 queue 0（只读观察）；11 个正文节点、993×44 的完整编辑器可见。未提交任何答复，source writes/blocked/pageerrors 均 0。span `344c3cc8-b1d0-4588-9715-680bc60e48a7`。
- 隔离会话：9.872 秒，实际官方“跳过”按钮提交一次合法 `selected:[]`，原问题和 operation 身份精确，源持久 accepted；立即、刷新及页面重开后均 pending/card=0，完整编辑器可见。官方正文显示“已跳过”。使用真实 Codex0.165 app-server 与生产 DirectCodexAdapter，模型服务仅本机 synthetic loopback；不是对用户源写入。span `d0fef765-f145-4ad2-a518-d907bc9316a0`。
- 实际图已查看：[原床垫页面](/mnt/cache/data-cache/hhpi-async-question-skip-20261112/original-skip-final.png)，[隔离 Skip 重开后](/mnt/cache/data-cache/hhpi-async-question-skip-20261112/owned-skip-final.png)。图片为实际 browser DOM/CSS 保存后离线固定 webshot；实际交互与几何另记在 acceptance，不把离线截图当作交互证明。

正式 host `7d26c707…`、main `3f84dcd30812`、provider `89f79aac3d70` 已在两场核对。普通 DSH 默认路由未改。浏览器均关闭，自有 app-server 与 CODEX_HOME 已清理。

## 明确边界

旧 accepted 回执确认的是用户跳过决定，不证明模型消费；旧 queue 消失的原因仍未知，不补写或重放。原会话场景是在新版首次读取，未观察用户旧长开页面跨部署自动撤卡的过程。拒绝、unknown 和新修订的行为来自生产 Adapter/receipt 的隔离测试，未另造坏网浏览器场景。未进行手机、全套问答/模型矩阵或性能实验。
