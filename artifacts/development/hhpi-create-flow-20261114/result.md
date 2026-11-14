# 新建聊天完整路径：已修复并上线

2026-11-14，正式 release `d69c7cb68a1cdc8b5db6ca3cf1520d412bbdf4450cfbd651ef4683e91a637599`。中央与 Windows 原来源 provider 已同步；SDK `.29`、协议和原生执行保持原有边界。

实际桌面验收完成了两个用户目标：Windows 机器 → Codex → 该来源最近目录 → 单次创建 → 原目标完整输入框；以及旧 accepted 创建记录 → 再次进入新建直接得到新表单 → 次级入口恢复原目标。原生输入框可见可编辑，宽 993px、高 44px，已实际输入并清空一行测试草稿，未发送模型消息。后续再次新建均为新表单，没有重复创建。测试目标使用明确测试名称，原始 operation/canonical/native ID 映射仅存私有记录。

## 修复

- 成功打开 exact 创建目标后，以 operation/target 双重 CAS 完成呈现 intent；源创建回执与 native 会话不删除。历史 accepted 记录再次显式新建时直接显示新表单，原结果保留紧凑的次级打开入口；未知、未决请求继续防重。
- 一个弹窗完成机器、Agent、目录选择。单来源不显示内部 source ID；有歧义时按真实机器身份区分连接。原生最近目录只取 exact machine/source/engine，按最近使用排序；普通 DSH 最近目录排除原生转发来源，双向不继承错误 OS 路径。
- 没有 native 来源或所有来源不可创建时，可在同一机器明确选择可用 DSH；不擅自更改 Agent。临时不可用分支有实际重试入口。
- 取消、换机器或相同 Host ID 重连替换 owner 后，迟到结果仍保留，但不打开旧目标、抢焦点或关闭新弹窗。

生产六叶：`controller.ts`、`remote-creation.ts`、`remote-create-session.tsx`、`source-create-dialog.tsx`、`dsh-session.tsx`、`ui.tsx`。immutable revision2 八叶与已审 revision1 的源码相同，仅纠正发布 consumer 说明；freeze SHA `50f123cc8a164bf91ab60a3b6a8eb500a9643051742b6a740e7a1753d01eadf0`，见 [publication.json](publication.json)。

## 验证及审查

- 13 项生产表单/实际 controller 的 DOM 行为检查通过，span `e51fe27d-08c6-412f-9775-0ab9bf6c33b3`。
- 8 项创建 ledger/回执/身份 Node 检查通过，span `e6c37789-8cc2-49ad-95b4-7470a682722d`。
- Client 与 experience 类型检查通过，span `3d16e290-c66e-4a0c-ba75-c3a01f4e5d78`。
- 独立首轮五项审查后，diff 复核发现 DSH→native 目录继承、无 API 分支重试空转、失效 source ID 三项，均已修复并定向复核；根复核 exact operation/target CAS 与同 Host owner 替换 guard 通过。
- 两个正式浏览器场景在同一隔离 workspace 中完成。第一场 10.012s；第二场关键交互完成且全脚本约 25.749s，未另开模型、未写用户 workspace。场景 span `8688994c-c840-4be0-ab54-1fbaa07bb998`。

保留原聚合 `exit 1`：第二场的核心交互均已完成，最后测试资源清理的 `thread/archive` 回执 accepted，但紧接着一次 source catalog 查询仍含该 ID，触发“必须立刻物理消失”的额外断言。没有重复归档或第三次浏览器运行；不以目录立即消失作为创建成功条件，也不声称已观察到最终侧栏移除。该目标有明确测试名称，私有映射保留。

## 界面证据与边界

两张实际浏览器 DOM/CSS 快照已用固定 `webshot` 命令离线渲染，并由路径负责人及根代理亲自查看：新建弹窗标题、机器/Agent/目录和主创建清楚，旧结果为次级入口；创建后原生输入框完整，无错误。实际点击、创建和输入来自真实浏览器记录；离线 webshot 不替代交互证明。原图包含用户侧栏标题与真实目录，仅私有本地保留；公开记录只存哈希，见 [acceptance.json](acceptance.json)。

第二场旧 accepted 是隔离浏览器 IndexedDB 中恢复的本地旧记录，引用第一场真实创建且打开的同一目标，不冒称修改了用户现有本机记录。Mac/全部来源离线/迟到取消通过定向 DOM 边界证明，本轮未实机访问 Mac。手机未测。历史 full suite 曾有未分类失败，本轮没有重跑或将其改记为通过；状态见发布记录。
