/** Same-popover secondary page: source reads never replace the conversation or composer. */
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import type { HhpiRemoteApi } from '../hhpi-api.ts'
import type { RemoteSourceSession } from './remote-sessions.ts'
import { RemoteNativeServices, type NativeServiceIssue, type NativeServicesAccess } from './remote-native-services-state.ts'

export function RemoteNativeServicesPanel({ session, api, chinese, back, captureAccess }: {
  session: RemoteSourceSession; api: Pick<HhpiRemoteApi, 'nativeCall'>; chinese: boolean; back(): void; captureAccess(): NativeServicesAccess
}) {
  const tr = (en: string, zh: string): string => chinese ? zh : en
  const controller = useMemo(() => new RemoteNativeServices(session, api, captureAccess), [session, api, captureAccess])
  const backButton = useRef<HTMLButtonElement>(null)
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  useEffect(() => { void controller.refresh(); return () => controller.dispose() }, [controller])
  useEffect(() => { backButton.current?.focus({ preventScroll: true }) }, [controller])
  const issue = (value: NativeServiceIssue): string => ({
    unsupported: tr('This source does not provide this view.', '此来源未提供这项查看能力。'),
    offline: tr('The source is offline. Reconnect and refresh.', '来源已离线，连接恢复后可刷新。'),
    denied: tr('This source has not authorized this read. Reconnect with the correct account.', '此来源未授权读取，请以正确账号重新连接。'),
    invalid: tr('The source returned an incompatible result. Refresh or check the source connection.', '来源返回的内容不兼容，可刷新或检查来源连接。'),
    unavailable: tr('This source read did not finish. Your conversation is kept; refresh to try again.', '本次来源读取未完成，会话已保留，可刷新重试。'),
  }[value])
  const runtime = (value: string | null): string => ({
    notStarted: tr('Not started', '尚未启动'), starting: tr('Connecting', '正在连接'), connected: tr('Connected', '已连接'),
    authenticationRequired: tr('Authorization required', '需要授权'), failed: tr('Connection failed', '连接失败'), cancelled: tr('Cancelled', '已取消'), disabled: tr('Disabled', '已停用'),
  }[value ?? ''] ?? tr('Connection state not reported', '连接状态未报告'))
  const auth = (value: string): string => ({ unknown: tr('Authorization state unknown', '授权状态未知'), unsupported: tr('OAuth unsupported', '不支持 OAuth'),
    notLoggedIn: tr('Not logged in', '未登录'), bearerToken: tr('Token configured', '已配置令牌'), oAuth: tr('OAuth', 'OAuth 授权') }[value] ?? value)
  return <div className="hapi-native-actions">
    <button ref={backButton} type="button" aria-label={tr('Back to conversation actions', '返回会话操作')} onClick={back}><span aria-hidden="true">← </span>{tr('Back to conversation actions', '返回会话操作')}</button>
    <h3>{tr('Source connections & background work', '源连接与后台任务')}</h3>
    {!state.current ? <p role="status">{tr('This account or source changed. Close this menu and reopen the conversation.', '账号或来源已改变，请关闭菜单后重新打开会话。')}</p> : <>
      <section className="hapi-native-actions" aria-label={tr('MCP connections', 'MCP 连接')}>
        <h4>{tr('MCP connections', 'MCP 连接')}</h4>
        <button type="button" disabled={state.mcp.loading} onClick={() => { void controller.read('mcp') }}>{tr('Refresh connections', '刷新连接')}</button>
        {state.mcp.loading && <p role="status">{tr('Reading source connections…', '正在读取来源连接…')}</p>}
        {state.mcp.issue && <p role="status">{issue(state.mcp.issue)}</p>}
        {state.mcp.issue && state.mcp.rows.length > 0 && <p>{tr('Showing the last successful read.', '以下保留上次读取结果。')}</p>}
        {state.mcp.loaded && !state.mcp.rows.length && !state.mcp.issue && <p>{tr('This conversation source returned no MCP servers.', '此会话来源未返回 MCP 服务。')}</p>}
        {state.mcp.rows.map(server => <article key={server.name} style={{ overflowWrap: 'anywhere' }}>
          <strong>{server.title || server.name}</strong>
          <p>{runtime(server.runtimeStatus)} · {auth(server.authStatus)} · {tr(`${server.toolCount} tools`, `${server.toolCount} 项工具`)}</p>
          {(server.runtimeStatus === 'authenticationRequired' || server.authStatus === 'notLoggedIn') && <p>{tr('Complete authorization in Codex on this source machine, then refresh here.', '请在该来源机器的 Codex 中完成授权，再回此处刷新。')}</p>}
          {server.toolsUnavailable && <p>{tr('The source could not read this service’s tools. Check its connection and refresh.', '来源暂未读到该服务的工具，请检查连接后刷新。')}</p>}
        </article>)}
        {state.mcp.nextCursor && <button type="button" disabled={state.mcp.loading} onClick={() => { void controller.read('mcp', true) }}>{tr('More connections', '更多连接')}</button>}
      </section>
      <section className="hapi-native-actions" aria-label={tr('Codex background processes', 'Codex 后台进程')}>
        <h4>{tr('Codex background processes', 'Codex 后台进程')}</h4>
        <button type="button" disabled={state.background.loading} onClick={() => { void controller.read('background') }}>{tr('Refresh background work', '刷新后台任务')}</button>
        {state.background.loading && <p role="status">{tr('Reading background work…', '正在读取后台任务…')}</p>}
        {state.background.issue && <p role="status">{issue(state.background.issue)}</p>}
        {state.background.issue && state.background.rows.length > 0 && <p>{tr('Showing the last successful read.', '以下保留上次读取结果。')}</p>}
        {state.background.loaded && !state.background.rows.length && !state.background.issue && <p>{tr('This conversation returned no background processes.', '此会话未返回后台进程。')}</p>}
        {state.background.rows.map(process => <article key={process.processId} style={{ overflowWrap: 'anywhere' }}>
          <strong>{process.command.split('\n')[0]?.slice(0, 160) || tr('Background process', '后台进程')}</strong>
          <p>{process.cwd}</p>
          {(process.cpuPercent !== null || process.rssKb !== null) && <p>{[process.cpuPercent !== null ? `CPU ${process.cpuPercent}%` : '', process.rssKb !== null ? `${Math.round(process.rssKb / 1024)} MiB` : ''].filter(Boolean).join(' · ')}</p>}
          <details><summary>{tr('Process details', '进程详情')}</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{process.command}</pre>
            <p>{tr('Process', '进程')} {process.osPid ?? process.processId}</p></details>
        </article>)}
        {state.background.nextCursor && <button type="button" disabled={state.background.loading} onClick={() => { void controller.read('background', true) }}>{tr('More background work', '更多后台任务')}</button>}
      </section>
    </>}
  </div>
}
