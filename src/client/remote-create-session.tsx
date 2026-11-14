import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { HhpiRemoteApi } from '../hhpi-api.ts'
import type { SourceCatalog, SourceSession } from '../remote/protocol.ts'
import type { SourceStorage } from './remote-storage.ts'
import { RemoteCreationController } from './remote-creation.ts'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { CreationChoice } from './source-create-choice.tsx'
import { readableEngine } from './locales.ts'
import { SourceDirectoryPicker, type SourceDirectoryBrowser } from './source-directory-picker.tsx'

export interface RemoteCreateSessionProps {
  api: HhpiRemoteApi
  access: SourceStorage | undefined
  open(session: SourceSession, isCurrent: () => boolean): void | Promise<void>
  close(): void
  initialSourceId?: string
  initialDirectory?: string
  intent?: string
  language?: string
  createDsh?(): void
  creation?: RemoteCreationController
  catalogState?: CreationCatalogState
  sourceEngine?: string
  sourceLabels?: Readonly<Record<string, string>>
  onBusyChange?(busy: boolean): void
  browseDirectories?: SourceDirectoryBrowser
}
export interface CreationCatalogState { catalog: SourceCatalog | null; loading: boolean; error: string | null; refresh(): Promise<void> }
export function useCreationCatalog(api: Pick<HhpiRemoteApi, 'catalog'> | undefined, language: string): CreationCatalogState {
  const [catalog, setCatalog] = useState<SourceCatalog | null>(null), [loading, setLoading] = useState(!!api), [error, setError] = useState<string | null>(null)
  const current = useRef<AbortController | null>(null)
  const refresh = useCallback(async (): Promise<void> => {
    current.current?.abort()
    if (!api) { setCatalog(null); setLoading(false); setError(null); return }
    const request = new AbortController(); current.current = request
    setLoading(true); setError(null)
    try {
      const result = await api.catalog(request.signal)
      if (request.signal.aborted) return
      if (!result.ok) throw result.error
      setCatalog(result.value)
    } catch {
      if (!request.signal.aborted) setError(language.startsWith('zh') ? '无法加载这台机器的 Agent，请重试。' : 'Agents on this machine could not be loaded. Retry to reconnect.')
    } finally { if (!request.signal.aborted) setLoading(false) }
  }, [api, language])
  useEffect(() => { setCatalog(null); void refresh(); return () => current.current?.abort() }, [refresh])
  return { catalog, loading, error, refresh }
}
/** A native source is selected before its directory; defaults remain source-owned. */
export function RemoteCreateSessionForm({ api, access, open, close, initialSourceId, initialDirectory, intent, language = 'en', creation: suppliedCreation, createDsh, catalogState, sourceEngine, sourceLabels, onBusyChange, browseDirectories }: RemoteCreateSessionProps) {
  const zh = language.startsWith('zh'), text = (en: string, cn: string): string => zh ? cn : en
  const creation = useMemo(() => suppliedCreation ?? new RemoteCreationController(api, access, intent ? { intent } : {}), [api, access?.scope, access?.storage, intent, suppliedCreation])
  const state = useSyncExternalStore(creation.subscribe, creation.getSnapshot)
  const ownCatalog = useCreationCatalog(catalogState ? undefined : api, language)
  const { catalog, loading: catalogLoading, error: catalogError, refresh: loadCatalog } = catalogState ?? ownCatalog
  const [sourceId, setSourceId] = useState(initialSourceId ?? ''), [directory, setDirectory] = useState(initialDirectory ?? '')
  const [error, setError] = useState<string | null>(null), [opening, setOpening] = useState(false), [newAttempt, setNewAttempt] = useState(state.record?.phase === 'accepted')
  const generation = useRef(0), submittedInView = useRef(false)
  useEffect(() => { ++generation.current; return () => { ++generation.current; if (!suppliedCreation) creation.dispose() } }, [creation, suppliedCreation])
  useEffect(() => {
    if (!catalog || state.record && !['accepted', 'rejected'].includes(state.record.phase)) return
    const candidates = catalog.sources.filter(source => !sourceEngine || source.engine === sourceEngine)
    if (candidates.some(source => source.id === sourceId)) return
    const next = candidates.find(source => source.create && source.online)?.id ?? ''
    if (sourceId !== next) { setSourceId(next); if (sourceId) setDirectory('') }
  }, [catalog, sourceEngine, sourceId, state.record?.phase])
  useEffect(() => { onBusyChange?.(state.busy || opening); return () => onBusyChange?.(false) }, [state.busy, opening, onBusyChange])
  useEffect(() => {
    if (!state.record) return
    if (state.record.phase === 'accepted' && !submittedInView.current) { setNewAttempt(true); return }
    if (newAttempt) return
    setSourceId(state.record.source.id); setDirectory(state.record.request.cwd ?? '')
  }, [state.record?.request.operationId])
  const unresolved = !!state.record && !['accepted', 'rejected'].includes(state.record.phase)
  const locked = state.loading || state.busy || unresolved || state.record?.phase === 'accepted' && !newAttempt
  const source = catalog?.sources.find(item => item.id === sourceId)
  const sources = catalog?.sources.filter(item => !sourceEngine || item.engine === sourceEngine) ?? []
  const directories = source ? [...new Set(catalog?.sessions.filter(item => item.machineId === source.machineId && item.sourceId === source.id
    && item.engine === source.engine && item.cwd?.trim()).sort((a, b) => b.updatedAt - a.updatedAt).map(item => item.cwd!) ?? [])] : []
  const finish = async (): Promise<void> => {
    const current = generation.current
    setOpening(true); setError(null)
    try {
      const session = await creation.resolveTarget()
      const operationId = creation.getSnapshot().record?.request.operationId
      if (generation.current !== current) return
      await open(session, () => generation.current === current)
      if (!operationId || !await creation.completeOpened(operationId, session.id)) return
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
    submittedInView.current = true
    void creation.start(source, directory, newAttempt || state.record?.phase === 'rejected').then(result => {
      if (generation.current === current && result) {
        setNewAttempt(false)
        if (result.phase === 'accepted') return finish()
      }
    })
  }}>
    {catalog?.sources.length || state.record ? <>
      {sources.length > 1 && <CreationChoice label={text('Connection', '连接')} value={sourceId} disabled={locked}
        placeholder={catalogLoading ? text('Loading sources…', '正在加载来源…') : text('Choose a source', '选择来源')}
        options={[
          ...(state.record && !catalog?.sources.some(item => item.id === state.record!.source.id)
            ? [{ id: state.record.source.id, label: readableEngine(state.record.source.engine), disabled: true }] : []),
          ...sources.map(item => ({ id: item.id, disabled: !item.online || !item.create,
            label: `${readableEngine(item.engine)} · ${sourceLabels?.[item.id] || item.id}${!item.online ? text(' (offline)', '（离线）') : !item.create ? text(' (creation unavailable)', '（无法新建）') : ''}` })),
        ]} onChange={next => { setSourceId(next); setDirectory(''); setError(null) }}/>}
      {source && <SourceDirectoryPicker key={JSON.stringify([source.machineId, source.id, source.engine])} source={{ machineId: source.machineId, sourceId: source.id, engine: source.engine }}
        value={directory} disabled={locked} language={language} {...(browseDirectories ? { browse: browseDirectories } : {})} onChange={setDirectory}/>}
      {!!directories.length && <CreationChoice label={text('Recent directories on this Agent', '此 Agent 的最近目录')} value={directories.includes(directory) ? directory : ''} disabled={locked}
        placeholder={text('Choose a directory', '选择目录')} options={directories.map(path => ({ id: path, label: path }))} onChange={setDirectory}/>}
      {catalog && !catalog.sources.some(item => item.online && item.create) && !state.record
        && <p role="status">{text('No source on this Host is available for creation. Choose another Host or refresh after reconnecting.', '此机器暂无可新建的来源。请选择其他机器，或连接后刷新。')}</p>}
    </> : !error && <p role="status">{catalogLoading ? text('Loading sources…', '正在加载来源…')
      : text('This Host has no available native sources. Create a DSH conversation here, or choose another Host.', '此机器暂无可用的原生来源。可在此机器新建 DSH 聊天，或选择其他机器。')}</p>}
    {state.record && !newAttempt && ['dispatching', 'confirming'].includes(state.record.phase)
      && <p role="status">{text('The creation result is not confirmed yet. Check the original result before trying again.', '创建结果尚未确认，请先检查原请求结果。')}</p>}
    {(error || catalogError || state.error) && <p role="alert">{error || catalogError || text('Creation is unavailable. Check the directory and reconnect this Host before retrying.', '暂时无法创建，请检查工作目录并重新连接此机器后重试。')}</p>}
    <div className="hapi-button-row">
      <Button type="button" onClick={() => { ++generation.current; close() }}>{text('Cancel', '取消')}</Button>
      {(!catalogState && !catalogLoading || catalogError) && <Button type="button" onClick={() => { void loadCatalog() }}>{text('Retry', '重试')}</Button>}
      {catalog && catalog.sources.length === 0 && !state.record && createDsh
        && <Button type="button" variant="primary" onClick={createDsh}>{text('New DSH conversation', '新建 DSH 聊天')}</Button>}
      {unresolved && state.record?.phase !== 'prepared' && <Button type="button" disabled={state.busy || opening} onClick={() => { void recover() }}>{text('Check original result', '检查原请求结果')}</Button>}
      {state.record?.phase === 'accepted' && !newAttempt && <>
        <Button type="button" disabled={opening} onClick={() => { void finish() }}>{text('Open created conversation', '打开已创建的会话')}</Button>
        <Button type="button" disabled={opening} onClick={() => { setNewAttempt(true); setError(null) }}>{text('Create another conversation', '新建另一个会话')}</Button>
      </>}
      {state.record?.phase === 'accepted' && newAttempt && <Button type="button" disabled={opening} onClick={() => { void finish() }}>{text('Open last created conversation', '打开上次创建的聊天')}</Button>}
      {(!!catalog?.sources.length || !!state.record) && (!state.record || newAttempt || state.record.phase === 'prepared' || state.record.phase === 'rejected') && <Button variant="primary" type="submit" disabled={state.loading || state.busy || opening || !source?.online || !source.create || !directory.trim()}>{state.busy ? text('Creating…', '正在创建…') : text('Create', '创建')}</Button>}
    </div>
  </form>
}
