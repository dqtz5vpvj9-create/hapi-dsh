# 10:38 上传失败续片：原故障仍未定位，诊断绑定已修复上线

本次原用户上传失败仍为 **unknown / incomplete**。已确认并修复的是客户端诊断回调的 Cordis 服务注入：parent 插件只声明 `remote`，回调却从 parent 读取 `remote.hapi`；child 声明不能授权 parent，因此真实客户端错误报告会静默丢失。补齐 parent 的 `remote.hapi` 后，源码 `16cb3d6fd` 已在中央上线，HostBuild `bfe882f3f3126c9cbf4a786f5f09ddcf881e9ce19030ec8f86d00b5d2a82e1eb`，release `eb94c2411d3e5332f1d24c233ac9ba5cd45c30c55cdbdf305ac7233673c01a0e`。SDK、Windows及长图输入逻辑未改。发布保护见 [publication.json](publication.json)。

## 真实事件边界

10:39 读取当前开发源记录时，没有 10:38 新 begin；该源最近实际完成回执在 09:30:28.143806Z，received 等于 declaredBytes、finished/applied。原生产 stderr 此时仅有上一轮 `build=development` 合成诊断一条。这不能证明用户没发请求或页面一定旧版；本轮已证实客户端诊断绑定本身有缺陷。Nginx关闭 access log，现场 error log 无该分钟上传/413/timeout记录；publisher 后来的无效 chunk 探针502与其自己的时刻吻合，不能当用户失败。相关上传路由及桥接字节未随长图版本变化。

现有附件IDB只保存原件/准备字节、上传operation及草稿，不持久化原错误对象或错误阶段；无法事后从这些存储恢复原异常。没有用户原页面的执行中 main revision、原错误对象、IndexedDB草稿/准备字节与请求时间线；不能由新 bootstrap 或另一个浏览器推断这些信息。未刷新、重传、移除或发送用户附件。

## 已交付与实际浏览器结果

- 诊断定向 6/6、Client types 通过；精确 span 见 [acceptance.json](acceptance.json)。此前真实官方 picker 选择自有损坏 PNG 会显示 error 而诊断为0，复现了缺口。该旧脚本错误地 exit0，但 JSON `passed=false` 已保留，未算通过。
- 保持同一隔离旧页面的损坏文件和未发送草稿跨部署。激活后4秒观察窗内没有自动报告，文件、草稿和原 operation 均在。随后实际点击 Settings「通知与安装→保存草稿并刷新工作区」，恢复后原 File SHA/bytes、operation 和草稿完全相同，真实客户端报告 `image-preparation/InvalidStateError` 与 `composer-error` 各一条，HTTP200且生产 stderr 已读回。0源上传/任务写入。总79.188秒含跨发布被动等待，激活后实际8.524秒。4秒未报告不等于永不自动HMR；不能承诺部署就已接管用户原页面。见 [retained-page.json](retained-page.json)、[client-sink.json](client-sink.json)。
- 一次实际双长图选图：自有 PNG 1216×37686、1216×30029（5,154,526和4,112,370字节），经官方附件入口、完整准备、草稿checkpoint、分块上传、finish applied×2，官方 ready×2。浏览器8.726秒，40次新owned源上传写入（begin/chunk/finish），0错误、0诊断、0任务写入，未发送消息或调用模型。第一次素材准备使用旧Sharp路径失败，第二文件不存在，setFiles之前ENOENT、0源写入；保留失败后生成素材，再执行这一次实际双图检查。见 [dual-long-picker.json](dual-long-picker.json)。

桌面自有长图通过，不证明用户原图、原设备或原页状态已恢复。源码仍在决定直传原字节前完整 `createImageBitmap`，两张同尺寸RGBA约329MB，存在内存风险；本轮没有证据将其归因为用户失败，也没有改变压缩或准备逻辑。官方当前浏览器API没有可直接复用、保证不解码的尺寸读取入口；未为此加入私有依赖或新框架。

新run `hhpi-upload-recurrence-20261112-1038` 续接旧run `hhpi-upload-recurrence-20261112`；旧closed/incomplete记录不变。本次诊断修复完成不等于原上传故障完成。若收到自然发生的真实客户端阶段事件，再沿该阶段定位；没有事件时保留上述具体缺失，不编造根因。
