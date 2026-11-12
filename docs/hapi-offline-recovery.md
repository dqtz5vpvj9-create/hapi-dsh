# HAPI 离线恢复材料

这套工具读取操作者明确选定的冻结导出，生成私有恢复包。它不连接 Hub，不导入产品运行时，不修改原始数据，也不停止、接管或向原生执行发送操作。各领域转换由后续迁移阶段提供；只保存快照不表示切换已完成。

使用 Node 24.x，在源码目录运行：

```sh
node --import tsx scripts/migrations/hapi-offline/index.ts capture --request /private/selected-snapshot.json --output /private/recovery-package
node --import tsx scripts/migrations/hapi-offline/index.ts resume --output /private/recovery-package
```

`capture` 请求格式为：

```json
{
  "version": 1,
  "packageId": "chosen-recovery-package",
  "scope": "explicit-account-and-origin-partition",
  "snapshot": {
    "id": "chosen-frozen-export",
    "root": "/private/frozen-export",
    "inputs": [
      { "id": "hub", "path": "hub-backup.sqlite", "format": "sqlite-backup", "version": "sqlite-user-version-33" },
      { "id": "drafts", "path": "drafts.json", "format": "json", "version": "selected-export-v1" }
    ]
  },
  "requiredStages": []
}
```

`scope` 是调用者明确提供的账号、应用 origin 分区标识，不是凭据或授权。请求和源数据只写入本地私有包，不写入公共报告。输入路径必须是选定根目录内的普通文件；支持 `json`、`jsonl`、`sqlite-backup` 和 `binary`。目录不会自动扫描。SQLite 输入必须是已完成的 backup/export，不能直接选择有未合并 WAL 的运行数据库。操作者须先保证所有输入属于同一冻结快照；字节数检查不能证明跨文件一致性，也不能识别同长度的并发改写。

恢复目录权限为 `0700`，文件为 `0600`。`inputs/` 保留原始字节，`recovery.sqlite` 保存请求、阶段和对象主键，`objects/` 提供逐对象 JSON，`index.json` 和不含脚本的 `index.html` 提供本地浏览入口。包可能包含正文、草稿、配置和附件，应沿原数据访问边界保存，不能进入仓库、公共静态站点或发布报告。HTML 不嵌入源内容；原始 JSON、HTML 或二进制文件仍是未转换的原数据。

`preserved` 表示仅保留快照；`incomplete` 表示输入、阶段或对象物化未完成；`needs-review` 表示所有指定阶段已结束，但仍有未映射对象；`complete` 只说明指定阶段的恢复输出完成。它们均不证明目标已导入、授权、接管或原生验收通过。未指定的领域不在完成声明内。

开发阶段实现 `OfflineStage`，交给 `runOfflineMigration(request, output, stages)`：

```ts
const stage: OfflineStage = {
  id: 'sessions', version: '1',
  async run({ snapshot, recovery }) {
    const exported = await snapshot.json('selected-session-export')
    await recovery.putObject({
      id: 'original-hub:namespace:session-key',
      family: 'sessions', inputId: 'selected-session-export',
      state: 'unresolved', value: exported,
      reason: 'No exact current native target was supplied.',
    })
  },
}
```

把阶段的 `id`、`version` 写入请求的 `requiredStages`，按数组顺序执行。未安装的阶段保持 pending，不伪装完成。阶段应只生成离线恢复材料；不要在回调中导入生产数据库、联网、重放操作或处理 owner 退出。`SnapshotReader.jsonLines` 同时保留行号、原文和解析失败；`sqlite` 提供只读事务、绑定参数查询和实际 schema/user_version。转换必须先核对其支持的格式版本，不能根据文件名推断 schema。

对象以 `(family, id)` 为主键，`id` 应包括旧 Hub、namespace 和原始主键，必要时包括原修订号。相同主键和内容可重复提交；不同内容必须保留为另一个明确修订，工具拒绝覆盖原对象。`value` 必须是 JSON 数据；附件等原始字节通过 input 引用保留。映射成功的对象还需提供经过完整校验的当前 `AppSourceRoute`。保留的 confirmed 回执只作历史证据，unknown 操作保持原 ID 和未知状态；HAPI 专属队列转成未发送草稿，待决审批不能自动回答。

对象先写入 SQLite，再原子生成 JSON；中断后 `resumeOfflineRecovery(output)` 无需原导出或 Hub 即可物化已存对象。重新执行 `runOfflineMigration` 继续失败阶段，读取包内已保存的快照，完整阶段不会重跑。阶段应以稳定原键幂等生成材料。必须使用原请求恢复；快照、账号分区或阶段版本改变时使用新包。临时 `.pending` 文件不是有效输出，原始输入和 SQLite 记录才是恢复依据。

`ExactIdentityIndex` 只匹配调用者明确提供的 `machineId + engine + nativeId`，已有 `sourceId` 也必须相同。HHPI 路由须与完整 identity 一致；普通 DSH 路由须与原始 DSH session ID 一致。缺少字段返回 unmapped，多个精确目标返回 ambiguous。Hub JSON/SQLite 元数据读取器只接受已记录的 flavor、机器和对应原生 ID；相互冲突的机器字段不作取舍。标题、cwd、时间、display 哈希和 `-rN` 后缀都不是身份依据。配置目标只是候选，实际打开仍要检查目标 Host 授权及当前来源。

领域迁移应继续保留文件正文、未保存草稿、冲突基底、附件、原始阅读位置和终端 owner 证据。旧 HAPI `seq` 不能转换成原生 turn/item；缺少确切对应关系时保留恢复记录，当前页面只能采用明确的安全退路。真实生产迁移、目标导入、别名安装及 owner 退出由组合根在切换步骤执行，本工具不会自动实施。

## 当前运行时的有限别名

`src/workspace/source-aliases.ts` 与离线工具分离，不导入 Hub 客户端或迁移脚本。领域迁移可生成 `SourceAliasDocument`，由组合根明确安装到相应账号和应用 origin：

```ts
const document: SourceAliasDocument = {
  version: 1,
  scope: { accountId: 'authenticated-account', origin: 'https://workspace.example.invalid' },
  entries: [{
    legacy: { kind: 'hapi-session', hubId: 'recorded-hub', namespace: 'recorded-namespace', sessionId: 'recorded-session' },
    target: exactCurrentAppSourceRoute,
    recovery: [{ packageId: 'chosen-recovery-package', family: 'sessions', objectId: 'original-hub:namespace:session-key' }],
  }],
}
const index = new SourceAliasIndex(document, authenticatedScope)
const result = await index.resolve(reference, {
  scope: authenticatedScope,
  current: () => capturedGenerationIsCurrent(),
  authorize: (route, signal) => authorizeTargetHostAndSource(route, signal),
  locate: (route, signal) => locateExactCurrentSource(route, signal),
}, signal)
```

`reference` 可以是经过当前 schema 校验的 `AppSourceRoute`，或两种旧引用之一：`hapi-session {hubId,sessionId,namespace?}`、`hapi-display {hostId,displayId}`。namespace 的存在与否也是精确键的一部分；没有 namespace 的链接不能命中一个明确指定 namespace 的记录。display 必须是当时实际记录的完整 ID，不能重新生成哈希、剥离修订后缀或进行模糊匹配。

相同旧键的相同目标会合并，多个不同目标返回 `ambiguous`，没有目标返回 `unmapped`。这两种结果保留本账号的恢复引用，不发起目录查询。一个精确目标会依次执行目标授权、当前来源定位和授权复核；返回的 Host、路径种类、session 及完整 HHPI identity 必须与记录一致。配置变动或来源缺失返回 `unavailable`，不会改用当前 Pane、标题相同的会话或另一个 Host。账号/origin、连接代次失效及取消会丢弃迟到结果。授权拒绝不返回目标或恢复信息。

组合根必须为 `authorize` 和 `locate` 提供现有的、服务端鉴权的目标 Host 服务。客户端检查不能代替服务端对每次读取和写入的授权。恢复引用只包含包和对象主键，读取恢复内容还须独立验证本地包权限；它不是文件路径、下载地址或授权令牌。

别名解析只恢复来源。`resolved.via === 'alias'` 时，调用者不能把旧展示 `seq`、DOM 锚点或旧 pending 审批坐标带入新原生会话。可明确打开最新窗口，并把旧坐标保留在离线恢复对象中；只有另有确切原生 turn/item 证据时才能走原生定位。未知旧链接应展示恢复入口或明确的不可用状态，不访问 Hub，也不隐式选择其他会话。

## X2：文件、附件与编辑草稿

`scripts/migrations/hapi-offline/files.ts` 提供独立的 `createFilesStage(options)`，交给 `runOfflineMigration` 并在请求中声明 `{ id: 'files', version: '1' }`。`options.inputs` 明确选择 browser-export、browser-blobs、document-drafts、artifact-journal、source-resource-journal、session-export、file-receipts 或 notes；`options.binaries` 选择实际二进制 input。附件按原 attachmentId 匹配，官方文件别名还可明确指定 kind 和原始 name；旧上传路径必须同时匹配明确的旧 Hub/会话属主。工具不读取记录中的 source path，不按文件名、标题或 cwd 搜索替代文件。

浏览器显式下载的恢复 JSON 使用 `{ version: 1, origin, createdAt, localStorage: [{key,value}], databases: [{name,version,stores:[{name,records:[{key,value}]}]}] }`；Blob 使用 `{ $hhpiBlob: 1, type, name?, lastModified?, data: base64 }`。先在离线机器上执行：

```sh
node --import tsx scripts/migrations/hapi-offline/files.ts extract-browser --input /private/browser-recovery.json --output /private/fresh-browser-snapshot
```

输出目录必须全新，权限为 `0700`，文件为 `0600`。`browser-export.json` 保留原始下载字节；每个 Blob 写入独立二进制 input，`browser-blobs.json` 记录原 JSON pointer 和 input ID，`snapshot.json` 提供 L1 可选快照。提取命令只打印输入数量、Blob 数量和字节数。失败时保留原导出，使用新的提取目录；领域转换与恢复则沿 L1 原请求继续，不能将另一份导出覆盖到同一恢复包。该过程不把 origin 当账号，也不根据旧键自动关联当前账号或来源。

转换 browser-export 时同时选择 browser-blobs manifest；阶段会实际读取已捕获的二进制，并逐字节核对原 Blob，防止相同大小的错误文件被配到原 pointer。旧 document journal 的脏稿、原始正文及 hash/版本基线、uncertain 状态，以及当前格式的 pending 操作和选择范围全部保留。恢复策略始终是 `recovered-copy`：不能覆盖更新的目标草稿，真正导入前还需读取目标源的当前基线。confirmed、pending、unknown 回执保留原 ID 和状态，只作恢复证据，不重发上传、保存或原生操作。

`options.sessions` 记录明确的旧属主与 machine/engine/nativeId，`options.targets` 经 L1 精确身份索引匹配。一个旧文件键可能记录的是 machineId，因此还可由 `documentOwners` 明确选择该键的原会话；缺少该证据时不猜测。匹配出的 target 只是后续导入候选，当前 Host 授权和来源有效性仍须在真实操作时检查。缺件、重复候选、未知格式和未映射对象保留离线恢复副本；`imported: false` 不会被文件保全成功改变。
