# 新建聊天的源目录选择：已上线并通过桌面验收

2026-11-14，中央与原 Windows source 已正式发布同一 release `c96c0c12ac2900f3e619d32cfa4faca0a85e447939b2f465dc2e4fe477a40a9b`，原生进程与 SDK `.29` 保留。两条约定实际路径均已通过，不需要手填目录。

新建表单的主操作为“选择文件夹”：在所选 Agent 的真实机器上浏览主目录、可访问磁盘根、父级和子文件夹，点击“选择此文件夹”后填入创建 cwd。最近目录保留为快捷入口；手输路径收为可选，不要求用户记路径。

只读接口 `sourceWorkspace/directories` 使用 source 级资源授权，逐次核对 machineId/sourceId/engine；不先创建会话，也不借 session 文件授权扩大范围。只有明确的 `local-system` 注册拥有目录浏览，后端复用 pinned 官方 `BrowseDirectoryPicker.capability().list`，客户端使用官方 DSH Button/Input 及既有目录浏览布局。中央转发 Windows 来源时，客户端按需连接 exact paired Windows owner，使用其目录服务；不打开中央同名路径。

Windows 根盘最多检查 26 个盘符，500ms 截止，保留成功结果与当前根，按 source owner 缓存 30s；不会每进一层重新探盘。POSIX 提供 `/`。关闭、切机器、切来源或 owner 换代后丢弃旧结果；初始 cwd 已失效时，“主目录”仍可直接恢复，不迫使用户清空手输入。

14 个生产叶、4 个测试叶，immutable freeze SHA `492011d05d9c0872fcd25c44e295a2367a2e12ec8c2727f167dc4ff3a05036de`。新增直接依赖仅为已安装、lock 中已存在的官方 `@deepseek-ai/dsh-host-directory-picker-browse@0.2.2-rc.1`，无 SDK 重建。普通 DSH 原目录流程、HHPI v1、创建 ledger 和原生执行保持原有语义。

## 检查

- 20 项 Node 通过：真实官方 Gateway/授权/源注册组合及实际本机目录读取，原生 catalog 是明确 fixture；Windows 盘符超时/缓存使用受控边界。span `4dc0be42-d952-4ab9-9798-0f7039867e63`。
- 18 项 DOM 通过：生产新建组件与 controller，远端 RPC/DSH primitives 为明确边界；覆盖跨盘/父子/确认、源与机器切换/关闭取消、坏初始 cwd→Home 恢复。span `9bc2a940-a713-49fb-8c80-e65d6dbd8334`。随后只更新同一个 forwarded 用例，证明 paired owner 尚未注册时按需等其接入；1 通过、17 未重跑，span `8f4dc458-30b9-47cd-8a8b-d6227f139bae`。
- Host 类型检查通过，span `4791a565-5402-4e24-8610-76cf68140779` 的 Host 项目；该次 Client/experience 声明错误原样保留。修正可选属性、旧 fixture 必需方法和测试查询声明后，最终 Client/experience 类型通过：`ede991bb-4079-40c7-ac05-4f7f8eaec0a0`。未重复 Host 与已通过行为检查。
- 根独立审阅确认 source 资源授权、真实执行端身份、取消与换代、forwarded owner 按需接入；审阅发现 Windows 跨盘/不可达盘截止，以及坏初始 cwd 缺 Home 的问题，均已修正。根未重复运行测试。

## 发布及真实界面

唯一 publisher 已发布中央 runtime/client 与原 Windows source runtime/provider，正式 main `decca7f820b4`、中央 provider `03cfc478087b`、Windows provider `694ac970c870`。两端 bootstrap 为同一预期 HostBuild；发布门禁见 publisher 管理的 [publication.json](publication.json)。

- 第一场 11.440s：所选 Windows Agent 实际列出 4 个可访问磁盘根，打开另一盘根后，沿已知目录的真实盘根逐层进入 6 级子目录，点击“选择此文件夹”，没有手输路径；只创建一次 owned 空会话，打开完整原生输入框，宽 993px、高 44px，实际输入并清空短草稿。
- 第二场 2.288s：中央转发的 Windows 来源仍由 exact paired Windows owner 浏览，进入真实子目录后取消选择，未选入未确认的目录、未再次创建，返回同一个 editor 且草稿原样保留，随后清空测试草稿。
- 共 11 次目录请求，全部为同 source/原 Windows owner，返回 Win32 路径；0 blocked、0 pageerror、0 用户 workspace 写、0 模型消息。浏览器 span `8367c5cc-e403-44c4-bce3-0466e2e0294d`，整体 exit 0。
- 新目标已明确命名，仅对该 exact owned ID 执行一次原生重命名和归档，均 accepted；不声称已观察到目录缓存立即物理移除。原生 operation/canonical/native 映射及真实路径仅私有保留。

两张固定 webshot 已由负责人和根代理亲自查看：真实磁盘入口、上下级 breadcrumb、子目录和“选择此文件夹”均可见，手输为可选；展开时弹窗可滚动，但当前选择主动作无遮挡；确认后创建出的聊天有完整编辑器。真实交互与几何来自发布浏览器，图片是该实际 DOM/CSS 的离线固定 webshot 渲染，分层记录。原图含私有侧栏/目录，仅本地保留，公开仅保存图片哈希，见 [acceptance.json](acceptance.json)。

普通 DSH-only Runner、SDK 和 native daemon 不变。没有发送模型消息或修改用户布局、草稿、队列。Mac 未实机访问，手机、FPS 和全量矩阵未执行；历史 full suite 非全绿边界保留。资源 SAFE，无剩余浏览器/构建活动。
