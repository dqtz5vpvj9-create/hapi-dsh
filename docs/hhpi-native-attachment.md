# 连接既有原生 Codex 源

在原机器的 Host/Runner 私有配置中添加 `sources`，连接既有 app-server，保留原机器与 native thread。HAPI Hub 配置已经退休；旧配置先保留并完成离线身份核对，再准备当前配置，不能仅删除字段就宣称迁移完成。

## 同机 app-server

与 app-server 同一 Unix 用户的示例：

```json
{
  "sources": [{
    "id": "native",
    "machineId": "existing-machine-id",
    "engine": "codex",
    "endpoint": "unix:///absolute/private/native.sock",
    "ownership": "shared"
  }]
}
```

socket 必须属于该用户且无组/其他用户权限。也支持无嵌入凭据的 loopback WebSocket；不把原生 RPC 直接公开到网络。source 配置固定 machine/source/engine，原 nativeId 由 app-server 返回，读取不会创建替代执行。

以上最小配置允许使用共享 app-server 已加载线程的原生操作。线程被原生服务卸载后，仅有 `ownership: "shared"` 的配置会让重开后的输入与附件入口保持只读；刚创建时可写不代表以后仍已加载。需要“新建、保存草稿、重开继续工作”时，还须完成下面的原生锁核对和配置。

确认 app-server 与所有共用同一 Codex home 的写者使用兼容的跨进程线程锁后，在原 source 条目中增加：

```json
{
  "id": "native",
  "machineId": "existing-machine-id",
  "engine": "codex",
  "endpoint": "unix:///absolute/private/native.sock",
  "ownership": "shared",
  "writerLock": "native"
}
```

核对实际 app-server 的运行版本、原生存储实现与现有写者的锁参与情况，不能只看本机另一个 CLI 的版本。以原生本地存储为例，[Codex 0.162.0 的 create/resume](https://github.com/openai/codex/blob/rust-v0.162.0/codex-rs/thread-store/src/local/live_writer.rs)先取得[同一 Codex home 下的线程锁](https://github.com/openai/codex/blob/rust-v0.162.0/codex-rs/rollout/src/writer_lock.rs)，活跃 writer 会导致原生拒绝；版本号本身不是配置许可。其他存储实现、机器或 Windows 源需各自核对，不能套用另一台机器的结论。

保留原配置备份，按正常显示 Host/Runner 生命周期加载该字段，再重开同一 native thread，核对原身份、草稿及源返回的能力。不要重建任务或切换为 `exclusive` 来获得可写状态。`writerLock: "native"` 允许明确发送时冷 resume；重连、读取、订阅及单纯打开 Pane 不会 resume。同一 live writer 拒绝后不继续发送，更换服务或写者后需重新核对锁。[发送恢复说明](hhpi-codex-send-recovery-2026-11-01.md)保留早期设计证据，不作为版本自动放行规则。

## SSH / Windows RPC bridge 与历史元数据

可通过认证的 SSH，在源机器 Node 24 上运行随包的 `dist/remote/native-stdio.cjs`，转发既有私有 socket 或 Windows named pipe。使用参数数组调用；Windows 复杂参数放在源机器的操作者维护 PowerShell 文件中。bridge 只关闭自己的连接，不启动或终止 app-server。

远端 Codex home 另使用 `dist/remote/codex-metadata.mjs` 提供只读历史索引元数据：

```json
{
  "historyMetadata": {
    "command": "ssh",
    "args": ["-T", "agent-host", "/absolute/path/to/node", "/absolute/path/to/codex-metadata.mjs"]
  }
}
```

这是一个 source 条目中的字段。HHPI 追加 `--serve`，跨页/Panes 复用通道。helper 只读元数据，不执行 agent 命令。源侧稀疏索引选择页面，浏览器不枚举整份历史再分页；索引不可用时返回明确错误并保留旧正文。

SSH bridge 只证明 Codex RPC 和元数据通道，不提供另一台机器的 Files、uploads 或 PTY。需要完整源资源时，在源 OS 正式安装同版 Runner，连接原 app-server，并注册：

```json
{ "sourceWorkspaces": [{ "sourceId": "native", "provider": "local-system" }] }
```

该 provider 以真实源系统用户权限提供文件、原子上传和 subprocess，独立于 Codex sandbox。不要在中央 Host 对远端 SSH 来源登记本机 provider。

## 源 Runner 与身份迁移

现有 DSH Runner 保留自己的 machine ID、profile 和原入口。若原 Codex source 的 machine ID 不同，应正式配对一个单独源 Runner，使用原 source 的 machine ID，分离 profile/data；接同一个既有 app-server，不新建另一个模型 owner。当前 Windows 路由迁移与真实 Session 0 FS/PTY 尚待验收。

迁移前保留私有配置、布局、浏览器草稿/附件和操作回执。每条 alias 核对原机器、source、engine、nativeId 与新 Host 的已认证 catalog，再按 workspace revision 更新外层 Host 路由。原 source/native ID 不改；不复制历史、不按标题匹配，不为已有执行重新创建任务。原路径和未知结果保留供明确恢复。

旧无账号浏览器数据只提示存在本机恢复项，通过用户明确选择后本机导出或恢复；不按新登录账号自动认领。普通 DSH 来源通过原 Host federation 接入，不再配置 `sources.engine: "dsh"`。
