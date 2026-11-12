import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { HhpiRemoteApi } from '../hhpi-api.ts'
import type { SourceCatalog, SourceSession } from '../remote/protocol.ts'
import type { SourceStorage } from './remote-storage.ts'
import { RemoteCreationController } from './remote-creation.ts'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import { CreationChoice } from './source-create-choice.tsx'
import { readableEngine } from './locales.ts'

export interface RemoteCreateSessionProps {
  api: HhpiRemoteApi
  access: SourceStorage | undefined
  open(session: SourceSession): void | Promise<void>
  close(): void
  initialSourceId?: string
  initialDirectory?: string
  intent?: string
  language?: string
  createDsh?(): void
  creation?: RemoteCreationController
}
/** A native source is selected before its directory; defaults remain source-owned. */
export function RemoteCreateSessionForm({ api, access, open, close, initialSourceId, initialDirectory, intent, language = 'en', creation: suppliedCreation, createDsh }: RemoteCreateSessionProps) {
  const zh = language.startsWith('zh'), text = (en: string, cn: string): string => zh ? cn : en
  const creation = useMemo(() => suppliedCreation ?? new RemoteCreationController(api, access, intent ? { intent } : {}), [api, access?.scope, access?.storage, intent, suppliedCreation])
  const state = useSyncExternalStore(creation.subscribe, creation.getSnapshot)
  const [catalog, setCatalog] = useState<SourceCatalog | null>(null), [catalogLoading, setCatalogLoading] = useState(true)
  const catalogRead = useRef<AbortController | null>(null)
  const [sourceId, setSourceId] = useState(initialSourceId ?? ''), [directory, setDirectory] = useState(initialDirectory ?? '')
  const [error, setError] = useState<string | null>(null), [opening, setOpening] = useState(false), [newAttempt, setNewAttempt] = useState(false)
  const generation = useRef(0), fieldsId = useId()
  useEffect(() => { ++generation.current; return () => { ++generation.current; if (!suppliedCreation) creation.dispose() } }, [creation, suppliedCreation])
  const loadCatalog = useCallback(async (): Promise<void> => {
    catalogRead.current?.abort()
    const request = new AbortController(); catalogRead.current = request
    setCatalogLoading(true); setError(null)
    try {
      const result = await api.catalog(request.signal)
      if (request.signal.aborted) return
      if (!result.ok) throw result.error
      setCatalog(result.value)
      setSourceId(current => current || result.value.sources.find(source => source.create && source.online)?.id || '')
    } catch {
      if (!request.signal.aborted) setError(zh ? '无法加载此机器的来源，请刷新后重试。' : 'Sources on this Host could not be loaded. Refresh to retry.')
    } finally { if (!request.signal.aborted) setCatalogLoading(false) }
  }, [api, zh])
  useEffect(() => { void loadCatalog(); return () => catalogRead.current?.abort() }, [loadCatalog])
  useEffect(() => {
    if (!state.record || newAttempt) return
    setSourceId(state.record.source.id); setDirectory(state.record.request.cwd ?? '')
  }, [state.record?.request.operationId])
  const unresolved = !!state.record && !['accepted', 'rejected'].includes(state.record.phase)
  const locked = state.loading || state.busy || unresolved || state.record?.phase === 'accepted' && !newAttempt
  const source = catalog?.sources.find(item => item.id === sourceId)
  const finish = async (): Promise<void> => {
    const current = generation.current
    setOpening(true); setError(null)
    try {
      const session = await creation.resolveTarget()
      if (generation.current !== current) return
      await open(session)
      if (generation.current === current) close()
    } catch (reason) { if (generation.current === current) setError(text('The created conversation could not be opened. Retry opening it; it will not be created twice.', '已创建的会话暂时无法打开，请重试打开，不会重复创建。')) }
    finally { if (generation.current === current) setOpening(false) }
  }
  const recover = async (): Promise<void> => {
    const current = generation.current
    const result = await creation.recover()
    if (generation.current === current && result) {
      setNewAttempt(false)
      if (result.phase === 'accepted') await finish()
    }
  }
  return <form className="hapi-native-create hhpi-native-create" onSubmit={event => {
    event.preventDefault()
    if (state.busy || state.loading || unresolved && state.record?.phase !== 'prepared' || !source?.online || !source.create || !directory.trim() || opening) return
    setError(null)
    const current = generation.current
    void creation.start(source, directory, newAttempt || state.record?.phase === 'rejected').then(result => {
      if (generation.current === current && result) {
        setNewAttempt(false)
        if (result.phase === 'accepted') return finish()
      }
    })
  }}>
    {catalog?.sources.length || state.record ? <>
      <CreationChoice label={text('Source', '来源')} value={sourceId} disabled={locked}
        placeholder={catalogLoading ? text('Loading sources…', '正在加载来源…') : text('Choose a source', '选择来源')}
        options={[
          ...(state.record && !catalog?.sources.some(item => item.id === state.record!.source.id)
            ? [{ id: state.record.source.id, label: `${readableEngine(state.record.source.engine)} · ${state.record.source.id}`, disabled: true }] : []),
          ...(catalog?.sources.map(item => ({ id: item.id, disabled: !item.online || !item.create,
            label: `${readableEngine(item.engine)} · ${item.id}${!item.online ? text(' (offline)', '（离线）') : !item.create ? text(' (creation unavailable)', '（无法新建）') : ''}` })) ?? []),
        ]} onChange={next => { setSourceId(next); setDirectory(''); setError(null) }}/>
      <label className="hhpi-create-field" htmlFor={`${fieldsId}-directory`}>{text('Working directory', '工作目录')}
        <Input id={`${fieldsId}-directory`} value={directory} disabled={locked} required placeholder={text('Directory on this source', '此来源上的工作目录')}
          onChange={event => setDirectory(event.currentTarget.value)}/>
      </label>
      {catalog && !catalog.sources.some(item => item.online && item.create) && !state.record
        && <p role="status">{text('No source on this Host is available for creation. Choose another Host or refresh after reconnecting.', '此机器暂无可新建的来源。请选择其他机器，或连接后刷新。')}</p>}
    </> : !error && <p role="status">{catalogLoading ? text('Loading sources…', '正在加载来源…')
      : text('This Host has no available native sources. Create a DSH conversation here, or choose another Host.', '此机器暂无可用的原生来源。可在此机器新建 DSH 聊天，或选择其他机器。')}</p>}
    {state.record && !newAttempt && ['dispatching', 'confirming'].includes(state.record.phase)
      && <p role="status">{text('The creation result is not confirmed yet. Check the original result before trying again.', '创建结果尚未确认，请先检查原请求结果。')}</p>}
    {(error || state.error) && <p role="alert">{error || text('Creation is unavailable. Check the directory and reconnect this Host before retrying.', '暂时无法创建，请检查工作目录并重新连接此机器后重试。')}</p>}
    <div className="hapi-button-row">
      <Button type="button" onClick={close}>{text('Cancel', '取消')}</Button>
      {!catalogLoading && <Button type="button" onClick={() => { void loadCatalog() }}>{text('Refresh sources', '刷新来源')}</Button>}
      {catalog && catalog.sources.length === 0 && !state.record && createDsh
        && <Button type="button" variant="primary" onClick={createDsh}>{text('New DSH conversation', '新建 DSH 聊天')}</Button>}
      {unresolved && state.record?.phase !== 'prepared' && <Button type="button" disabled={state.busy || opening} onClick={() => { void recover() }}>{text('Check original result', '检查原请求结果')}</Button>}
      {state.record?.phase === 'accepted' && !newAttempt && <>
        <Button type="button" disabled={opening} onClick={() => { void finish() }}>{text('Open created conversation', '打开已创建的会话')}</Button>
        <Button type="button" disabled={opening} onClick={() => { setNewAttempt(true); setError(null) }}>{text('Create another conversation', '新建另一个会话')}</Button>
      </>}
      {(!!catalog?.sources.length || !!state.record) && (!state.record || newAttempt || state.record.phase === 'prepared' || state.record.phase === 'rejected') && <Button variant="primary" type="submit" disabled={state.loading || state.busy || opening || !source?.online || !source.create || !directory.trim()}>{state.busy ? text('Creating…', '正在创建…') : text('Create', '创建')}</Button>}
    </div>
  </form>
}
