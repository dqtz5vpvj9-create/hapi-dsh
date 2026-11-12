# 原生 Codex 使用与恢复

HHPI 连接原机器上的 Codex app-server，保留 machine/source/engine/nativeId 和原来的执行 owner。普通 DSH 使用自己的官方接口，不能把旧 HAPI-owned DSH source 当作本机 Codex 或新建 DSH Agent。

本说明对应当前源码和公开契约；已有部署记录与当批未验证项见[发行说明](hhpi-retirement-release-notes.md)，具体可用性以当前源声明及实际用户路径为准。已生成的方法清单只表示已知协议，不证明某台源具备该能力。

## 打开、阅读与导航

在统一侧栏打开原生会话，正文使用官方 DSH Conversation 与同一个读者。目录、读取、分页和订阅不会 resume 线程；原生历史通过源侧索引选择页面，再读取对应条目。若索引或元数据 helper 不可达，保留已接纳正文并报告历史不可用，不退回整份 transcript 重放。

普通重开默认最近窗口。搜索、父子任务、消息分享和通知点击使用准确的原生 turn/item 或源事件位置，不能根据文字相似度、标题或伪造 seq 猜测定位。每个 Pane 的阅读窗口独立，真正历史修订才撤销旧版本读取。

## 输入与原生操作

输入、附件、图片和结构化引用经过当前 SessionBinding 的官方 editor/submit owner。语音转写只插入草稿。发送前检查源能力，来源无法接受的内容明确拒绝；取消或切换 Pane 不把另一个草稿清空。

| 行为 | 归属与恢复 |
| --- | --- |
| Send / Steer / Cancel | 当前原生 thread/turn；不借本机模型 provider 执行 |
| 审批与原生提问 | 准确 request ID 和源规定的答案格式；源端最终裁决 |
| 模型、推理、权限、协作/计划模式、服务级别 | 查询当前 native capability 与目录，源确认后展示结果 |
| 分支、重命名、上下文压缩、代码审查 | 原生方法与持久 operation ID；分支打开源实际返回的 native ID |
| Queue / Goal / Plan | 仅提供源真实声明的方法，不展示旧 HAPI 专属 schedule/notes 作为原生能力 |
| 父子任务与错误详情 | 只读原 thread、真实父子关系和最后轮次；不伪造本地子代理 |

原生空线程仍可在合法能力范围输入，不要求中央 Host 创建同路径 Workspace。资源能力独立：聊天可读不代表文件、上传或终端已注册。

## 发送恢复与不确定结果

显式写操作先保存其原 operation ID 和目标。传输成功不等于执行完成；accepted、rejected 和 indeterminate 保持各自含义。恢复先读取原回执或原生状态，页面刷新、重连、重新打开不自动重发。来源证明尚未 dispatch 的 retryable 结果，才允许同一 ID 再试。

共享 app-server 的 loaded thread 继续使用其原 owner。冷 resume 只由明确发送触发，并依赖操作者已经核实所有共享写者使用兼容的原生跨进程锁；只有这时才配置 `writerLock: "native"`。不能从版本号或浏览器行为推定锁存在，不能在另一个 live writer 拒绝后继续发送。`exclusive` 也不是绕过原生锁的开关。

仅配置 `ownership: "shared"` 时，新建线程可因仍已加载而允许输入，原生卸载后重开则可能只读；草稿恢复不会加载执行 owner。需要重开继续输入、附加文件并在明确发送时正常恢复的部署，应先按[原生接入的锁核对与配置步骤](hhpi-native-attachment.md#同机-app-server)启用 `writerLock: "native"`，再核对同一任务的真实能力。不要用替代任务、自动 resume 或修改能力值掩盖配置遗漏。

关闭 Pane 释放视图，不取消 turn。更新、回滚或恢复旧布局不会回放写请求，也不会撤销原生结果。实际取消和明确终止终端分别使用自己的控制入口。

## 文件、图片和 PTY

文件和 PTY 必须由真实源 OS 用户的 owner 提供。`sourceWorkspaces: [{"sourceId":"native","provider":"local-system"}]` 是操作者对该运行位置的明确注册，不可加在仅做 Windows SSH RPC 转发的中央 Host 上。它使用源系统用户权限，权限与 Codex sandbox 不混用。

本地准备的 File/Blob 在传输前保存恢复副本，完整上传以原子提交和源授权为准。失败或结果未知保留原件，不自动改路径或重发。终端 owner 保留真实 subprocess/cwd，Pane 关闭只释放视图；用户明确关闭终端才终止对应进程。

接入、配对与源 OS 部署步骤见[原生源接入](hhpi-native-attachment.md)和[安装指南](install.md)。旧 HAPI 配置与数据只能用于离线身份迁移/恢复；产品启动不再读取其 Hub、token 或 observer 运行时。
