# 超长图输入修复交接

新长图输入路径已上线并通过有界验收。中央 release `0efce146e47ea0090075bd3dca78e6d5af80c91dd9b84609ec664766ec3aaf6e`、HostBuild `6d3f77cf5f6350fd95feb64561a4defbf6590fc2f0e636efab1a5bfa683f6a5a`，产品源码 `f0272aff25e2f14b861bcaef0b2c74c727cb2163`；SDK .29 不变。运行原 daemon 是 Codex 0.162，安装的 CLI 是 0.165；实际床垫会话使用 GPT-6-Astra。

唯一真实 Astra 调用在自造 1216×37686 长图顶部、中部、底部准确读出三处 20px 随机码，10.943s，span `cc9e6b90-9aef-4c96-91df-d61a5aa5a5e7`。答案未放入 prompt；原件正文仍恰一图，正式 api.resource 返回字节 SHA 与 receipt 一致。没有外发用户图、改写用户 thread 或重试旧附件。这是自造小字样例通过，不是床垫商品参数 OCR。

桌面实际官方图只读场景 7.532s passed，span `93f8fa85-0a2a-4100-9ca0-af3091c08838`：正文一张原件、natural 1216×37686，实际点击打开官方原图 overlay；source writes/blocked/pageErrors 均为零。webshot 固定命令对这次实际 DOM 导出截图并实际查看，正文与原图截图 stage=done（约5秒各一张）。截图层为 exported DOM，实际点击与状态来自前一条联网 browser，不混作第二次联网截图验收。官方 overlay 默认 fit 整条长图，视觉上仍细长；这与原文件像素或模型输入缩水分别判断。

原上传全尺寸文件仍为 1216×37686、1216×30029，原 operation 输入指向这两个文件；原生 queue 已缩成 66×2048、83×2048，历史使用相同小图。单加 original detail 只修第一层，Astra 当前配置仍将整张图缩至 194×6000。浏览器 65535 上限不是这次损失位置。

修复仅为新发送在真实 source owner 内建立不可变图页计划，每页不缩放、最多 6000px、128px overlap。上传接口仍一 receipt 一 plain localImage；原 admission payload、旧 operation 与原件不改写。只有 dispatch 展开并保留 original detail，恢复校验已有图页 SHA 后复用。旧队列/历史小图不自动重发或放大冒充恢复。

两张真实 JPEG 私有裁页为 13 页、84,053,568 像素、10,502,652 WebP95 编码字节。16MiB 原生帧限制保持，单项 queue/list 实测响应含封装裕量最大 14,004,796B；两个相同规模 operation 同时排队时，自有 queue-view 合计仅 9,874B。队列页读取逐条且保留 1600 条预算，有派生计划的历史按单 item 读取。完整页 SHA/顺序匹配后返回源端轻量引用，官方 QueueDock/正文显示两张原图并保留交错文字；真实编辑、steer、恢复沿同一规范化核验及 source dispatch。原图读取复用同 session 上传 receipt 索引并校验 SHA/bytes。

验证结果：

- source-targeted 28 passed / 1 明确 opt-in native skip，span `e8cd4503-88d6-421c-9a39-319ecebe2dcc`。
- 恢复 QueueDock consumer 定向 1 passed，span `2adf2f99-bc28-41c6-98be-d546f2deb78b`。
- Host/Client/experience types passed，最终 span `1d693dd1-406a-4425-8120-288e52924ffc`（experience 复用未变的前次结果）。
- 同 binary 0.162 + 实际 Astra cached metadata + 无额外 image feature 的 owned source loopback 43.34s passed，span `41d375a1-49d0-4cb6-ae6b-64845ad5add5`。覆盖双 operation 排队、原 admission 不变和 receipt 重查、queue edit、运行中 queued-steer；13 页在 native queue 与模型请求逐页宽高/SHA相同，顺序与原图覆盖对照通过。外部模型调用 0，用户线程写入 0。采样 history 单项是小条目；原图合并/读取由 source-targeted 覆盖，不把该帧称为完整历史浏览器验收。
- Sharp 0.35.5 实际 packaged 中央 Linux 与两个 Windows consumer native JPEG encode/decode 已过，预检 span `d213c02b-932b-4b32-a8e7-4b4ab378685c`；publisher 在最终 carrier 中复核 direct dependency 和 Linux/Windows native load，见 installed-sharp.json。

整跑 structured-session 文件有 5 条既有 loader 失败：`official-conversation-fixture.ts:54` 通过 require 加载官方 controller client.js，`window is not defined`，span `6d46cb05-1b3a-49a2-b106-e7c8e5e1dc85`。root 在未导入本次 HHPI 修改模块的 `officialChat()` 空调用独立复现。未计通过，也未扩展修测试平台。本次新增 consumer 断言独立通过。

发布全量未全过：publisher 记录 1723 passed / 64 failed / 1 cancelled / 9 skipped，见 release-test-boundaries.json；其另一个最小 helper 提交 `0e172ce7b` 后，Session 24/24、turn-share 5/5 定向通过，不重复 full，也不以定向代替 full pass。产品载体仍为 f0272aff2。

真实读字前首次脚本把公开 `{input:[…]}` 解包成数组，6.247s 在模型前失败，span `0f35344b-0ce6-4225-8f0a-c249a5f90ca3`，模型调用 0。按同一 owned session、已上传 receipt 和已准备 operation 继续唯一真实模型调用；未新建第二线程或重传。

早期一次同 daemon 的 owned idle queue 探针触发原生自动执行，未得到目标队列观察即停止；未写用户 thread。最终通过的双长图证据全部来自隔离 owned source + loopback，不能把两层事实混为零模型执行的同一次实验。

发布范围：中央 local-system codex-native HHPI source 与最小 Client consumer，Windows owned win-native Runner source；中央转发 Windows transport 不读另一 OS 文件。SDK .29、HHPI v1、浏览器上传 schema 不变。精确 17 文件与 SHA 在 acceptance.json 和私有工作目录 freeze.json，发布保护与 Windows 最终状态见 publication.json。旧用户已送小图不会自动恢复，源全尺寸文件仍保留。本次完成状态仅限新长图输入路径；旧上传失败故障不属于这次结论，商品参数 OCR 未验证。
