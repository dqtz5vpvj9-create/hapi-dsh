# 语音听写与实时助手

本实现沿用 HAPI `55166cf8d87814ccfb383b538a8e8c55283bed81` 的语音协议、人格配置、语言目录和上下文提示，将入口挂到官方 DSH 的 `conversation.input.left` 与 `settings.section`。原会话、聊天渲染、输入框、输入队列和审批所有者仍由原 DSH/HAPI 服务负责。

## 已实现的功能

| 功能 | 实际路径与行为 |
| --- | --- |
| 标准听写 | OpenAI、ElevenLabs、Deepgram、Groq、OpenAI-compatible；实际 `MediaRecorder` 生成音频，走原 HAPI `POST /api/voice/transcription` multipart。25 MiB 音频上限，失败录音只保留在内存，用户明确重试才再次上传。 |
| 实时听写 | OpenAI WebRTC 临时凭据与原 SDP 协议；ElevenLabs Scribe 原 SDK 公共连接、16 kHz PCM、手动提交；Deepgram 原 WebSocket 协议和 `Finalize`；browser-local 使用原 `SpeechRecognition.available({ processLocally: true })` 能力探测，不回退到云端识别。 |
| 本地识别准入 | 只有可信桌面平台信息和公开 on-device API 同时存在时显示可用；用户点开始才探测语言包。取消、错误和关闭均释放识别实例。 |
| 插入原输入框 | 捕获官方 `inputActions.captureInsertion()`，用 `insertText` 比较输入框版本并保存原草稿。文字和附件保持原输入所有权；听写不会自行发出任务。若录音期间草稿变化，转录保留供明确插入、复制或丢弃。 |
| 实时语音助手 | ElevenLabs WebRTC、Gemini Live、Qwen Realtime。Gemini/Qwen 通过受 DSH 认证保护的固定 WebSocket 路径进入原 HAPI 代理，保持原 provider 帧、音频格式、工具声明和取消行为。 |
| 偏好与人格 | 原 12 个浏览器偏好键、语言、语音 backend、ElevenLabs 声音目录、Gemini/Qwen 声音选项、主动提示、人格预设、自定义 identity/character/响应长度、ElevenLabs TTS 参数、Gemini affective dialog、有效提示预览。偏好由整个工作区共享。 |
| 凭据设置 | 读取原 Hub 的 masked credential status 和 env/settings 来源；环境变量字段只读。明确保存/清除请求进入原 Hub。长期密钥不写入浏览器持久存储；结果未知时禁止自动重发，要求先读取原状态。 |
| 多窗格麦克风 | 一个共享 owner 协调所有窗格。其他窗格不能隐式夺取；用户可明确停止现有语音后再启动。停止过程尚未完成时不释放占用。最小化对话框继续通话，关闭或移除所属窗格关闭 capture/连接。 |
| 源上下文 | 原生会话验证 Hub、session、machine 身份；普通 DSH 会话读取它自己的公共 `SessionBinding`/`SessionEventSource`。最多 50 条正文，不收集隐藏推理；分段提示有字符上限并显示截断说明。 |
| 任务工具 | `messageCodingAgent` 走当前会话的正常 submission/queue。Gemini/Qwen 保留真实 call ID，重复同一调用读取已有结果；不同调用即使文字相同也允许执行。未知投递只查询源回执，不重新提交。 |
| 审批工具 | 只回答已经告知该语音连接、仍有效的单条可回答请求。结构化问卷、多条歧义请求、失效请求、旧连接和失去源所有权的回调均不能发出审批写操作。 |

语音工具回执表示源接受、排队或结果未知，不表示编码任务已经完成。ElevenLabs React SDK 的公开 `clientTools` 回调不提供 `tool_call_id`；每个实际回调有独立请求标识。实现没有用「整个连接内相同参数永远只执行一次」这种会吞掉合法重复指令的规则。

## 生命周期与边界

标准录音、PCM capture、WebRTC、Deepgram socket、浏览器本地识别和 ElevenLabs 连接都有独立取消所有者。已经取消的异步麦克风授权即使晚到，也立即停止全部 tracks，不恢复录音。旧连接迟到的 transcript、工具和 disconnect 事件不能控制后继连接。ElevenLabs Scribe 的发送、提交、事件和关闭绑定到 `getConnection()` 返回的公开连接实例，不依赖 hook 中可能被旧 CLOSE 清空的共享引用。

原生侧链和不可控制的来源不提供语音任务入口。普通远端 DSH 使用其自身会话的读取和提交能力，语音服务凭据仍来自主 Hub。插件不会把源路径交给主机执行，也不会把 HAPI 的认证 token 塞入浏览器代理 URL。

原生会话投影可晚于输入框挂载。控制器在用户明确开始通话时读取最新的已绑定源身份，并在该连接内固定此 owner；连接建立后的 React 更新不能把旧工具回调切到另一会话。没有完整来源时仍拒绝启动，不把空身份当作普通 DSH 会话。

语音按钮需要浏览器支持相应的麦克风、MediaRecorder/WebRTC/Web Audio 或 on-device API。网络协议和能力错误会明确显示；不会用模拟识别、静默降级或自动重连写请求假装服务可用。

## 已运行验证

`tests/hapi-source-voice.test.ts` 运行真实本地 HTTP/WebSocket wire fixture，覆盖源身份、masked settings、multipart 音频、一次性失败写请求、前缀路径与代理认证。`tests/client-voice-tools.test.ts` 和 `tests/client-voice-runtime.test.ts` 的 14 项回归通过，覆盖任务/审批去重、未知回执、迟到授权、capture 取消、浏览器本地准入、SDK 关闭期间占用、Scribe 连接归属、转录边界，以及身份迟到和运行中不切换来源。

`e2e/voice-plugins.spec.ts` 在未修改的官方 DSH Web profile 与 Chromium 156 中运行：

- 标准录音、实际音频 bytes 上传、原输入框已有草稿保留、转录插入、凭据更新失败不重放、长期密钥不进入 localStorage、全部麦克风 tracks 关闭，已通过。
- browser-local 协议 fixture 下验证首次点击才探测、`processLocally: true`、输入框并发编辑导致保留转录、用户再明确插入、没有音频上传或自动发送任务，已通过。
- Gemini/Qwen 原协议 fixture 的完整跨窗格流程已通过（22.0 秒）：原生源上下文、精确审批、真实 call ID 去重、不同 ID 的相同指令、显式麦克风交接和关闭窗格释放；随后进入普通远端 DSH，语音只读取该远端的真实 Session 历史、通过该 graph 的正常 submission 提交，原 HAPI 会话写入计数不变。最后关闭连接后全部 tracks 释放，浏览器无 `pageerror`。

上述实时助手用例与两条通知回归在同一冻结构建上联合运行，**3 项全部通过**。已人工查看最终远端 Conversation 与通知设置截图；源会话、官方消息渲染和统一侧栏均保留。

这些是明确的 provider/麦克风协议 fixture。没有使用真实第三方语音账户，也没有把合成麦克风、on-device API fixture 或模拟 provider 响应当成真实语音质量、第三方账户认证、真实 ElevenLabs WebRTC 或物理移动设备验收。

## 代码和原始来源

- 源 API 与认证代理：`src/hapi/source-voice.ts`、`src/voice-types.ts`。
- 官方组件入口、连接与录音：`src/client/source-voice/`。
- 原协议、上下文和人格：`src/voice/`；逐文件原路径及修改范围见 `src/voice/UPSTREAM.md`。
- HAPI 原版：`web/src/hooks/useDictation.ts`、`web/src/realtime/`、`hub/src/web/routes/voice.ts`、`shared/src/voice.ts`。
- ElevenLabs SDK 保持 npm 原版 `@elevenlabs/react@0.13.0` 与其原依赖；项目不读取 protected 字段、不修改 SDK 原型。
