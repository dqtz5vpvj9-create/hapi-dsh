import { useEffect, useState, useSyncExternalStore } from 'react'
import { buildSourceResumeCommand, copySourceResumeCommand, sourceResumeIdentityFromContext, type SourceResumeIdentity } from './source-resume-command.ts'
import type { SourceNavigationApi, SourceResumeContext } from '../workspace/source-navigation-api.ts'
import type { WorkspaceApplicationIdentity } from './application-identity.ts'

interface ResumeHost { id: string; resumeContext?: SourceNavigationApi['resumeContext'] }
const noIdentity = () => undefined
const noSubscription = () => () => {}

/** Copies a command for the original machine; the authenticated Host supplies its store. */
export function SourceResumeMenu({ identity, target, host, application, chinese = false }: {
    identity: SourceResumeIdentity | null
    target: { hostId: string; sessionId: string }
    host?: ResumeHost | undefined
    application?: Pick<WorkspaceApplicationIdentity, 'getSnapshot' | 'subscribe'> | undefined
    chinese?: boolean
}) {
    const account = useSyncExternalStore(application?.subscribe ?? noSubscription, application?.getSnapshot ?? noIdentity)
    const [loaded, setLoaded] = useState<{ host: ResumeHost; sessionId: string; account: typeof account; context: SourceResumeContext } | null>(null)
    const [error, setError] = useState(false)
    const [copyFailed, setCopyFailed] = useState(false)
    useEffect(() => {
        setLoaded(null); setError(false); setCopyFailed(false)
        if (!identity || !account || account.signal.aborted || !host?.resumeContext || host.id !== target.hostId) return
        const pending = new AbortController(), signal = AbortSignal.any([pending.signal, account.signal])
        const sessionId = target.sessionId
        void host.resumeContext({ sessionId }, signal).then(result => {
            if (signal.aborted || application?.getSnapshot() !== account) return
            if (!result.ok) throw result.error
            setLoaded({ host, sessionId, account, context: result.value })
        }).catch(() => { if (!signal.aborted) setError(true) })
        return () => pending.abort()
    }, [identity?.engine, identity?.nativeId, identity?.machineId, identity?.directory, target.hostId, target.sessionId, host, account, application])
    const current = account && !account.signal.aborted && host?.id === target.hostId && loaded?.host === host
        && loaded.sessionId === target.sessionId && loaded.account === account
    const verified = current ? sourceResumeIdentityFromContext(identity, target.sessionId, loaded.context) : null
    const result = buildSourceResumeCommand(verified)
    const title = result.available ? `${chinese ? '在原机器运行' : 'Run on original machine'}: ${result.machineName ?? result.machineId}\n${result.directory}\n${result.command}`
        : error ? chinese ? '暂时无法读取原来源的恢复信息' : 'The original source resume information is unavailable'
        : !account ? chinese ? '登录后可读取原来源的恢复信息' : 'Sign in to read the original source resume information'
        : verified && result.reason === 'unsupported-platform' ? chinese ? '原来源未报告受支持的系统' : 'The source operating system is not supported'
        : chinese ? '原来源尚未提供可验证的存储目录和恢复信息' : 'The original source store and resume information are not verified'
    return <><button type="button" role="menuitem" disabled={!result.available} title={title} onClick={() => {
        if (!current || account.signal.aborted || application?.getSnapshot() !== account) return
        setCopyFailed(false)
        void copySourceResumeCommand(result, value => navigator.clipboard.writeText(value)).catch(() => setCopyFailed(true))
    }}>{chinese ? '复制恢复命令' : 'Copy resume command'}</button>{copyFailed && <span role="alert">{chinese ? '无法复制恢复命令，请重试' : 'Unable to copy the resume command. Try again.'}</span>}</>
}
