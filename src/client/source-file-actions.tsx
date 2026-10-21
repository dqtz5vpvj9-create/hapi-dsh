/** HAPI source operations contributed to the original DSH Files and Document slots. */
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { CodeBlock } from '@deepseek-ai/dsh-client-ui-primitives'
import { fileAddressFor, pathPartsOf, resolveWorkspacePath } from '@deepseek-ai/dsh-util-workspace-path'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-files/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import type {} from './pane-navigation.ts'
import { remoteValue, type HapiRemoteApi } from '../client-api.ts'
import { MAX_DOCUMENT_BYTES, type NativeWorkbenchApi, type WorkbenchResponse, type WorkbenchSource } from '../workbench-types.ts'
import { SourceFileEdit } from './source-file-edit.ts'
import { SourceFileMutation, sourceFileContains, validSourceFileName } from './source-file-management.ts'
import type { SourceFileMutationJournal } from './source-file-mutation-journal.ts'
import type {} from './workspace-ui.ts'
import { sourcePathAddress } from './source-path-actions.tsx'
import { bytesToBase64, childPath, parentPath, parseWorkbenchChanges, type WorkbenchChange } from './workbench-model.ts'
import { errorMessage } from './controller.ts'

const en = {
  tools: 'Source file tools', edit: 'Edit source file', search: 'Find files', git: 'Git changes', manage: 'Manage files', close: 'Close',
  loading: 'Reading source…', working: 'Working on source…', query: 'Search file names', searchHelp: 'Search the session workspace on its owning Runner.',
  none: 'No matching files.', open: 'Open in official preview', openDirectory: 'Manage directory', staged: 'Staged', unstaged: 'Working tree',
  refresh: 'Refresh from source', noChanges: 'No changes reported by Git.', noDiff: 'No textual diff was returned. Open the file to inspect its current contents.',
  save: 'Save source file', saved: 'Source confirmed the saved revision.', draft: 'Unsaved draft', discard: 'Discard draft', content: 'File contents',
  readOnly: 'This source is read only.', cannotEdit: 'This file is not editable text, exceeds the source edit limit, or has mixed line endings. Use the official preview or download it.',
  uncertain: 'The source result is unconfirmed or changed. No operation will be repeated automatically. Read the current source before taking another action.',
  inspect: 'Inspect current source', current: 'Current source contents', keepDraft: 'Keep draft using this source revision', useCurrent: 'Use current source contents',
  discardAsk: 'Discard the unsaved source file drafts in this view?', mutationDraftAsk: 'This operation affects an unsaved source file draft. Discard that draft and continue?',
  pending: 'A source operation is still in progress. Keep this view until it settles.', review: 'I reviewed the source; start a new action',
  operation: 'Operation', path: 'Source path', destination: 'Destination path', name: 'Name', target: 'Inspect target',
  newFile: 'New file', newDirectory: 'New directory', rename: 'Rename', move: 'Move', copy: 'Copy', delete: 'Delete', upload: 'Upload files',
  execute: 'Apply source operation', completed: 'Source confirmed this operation.', entries: 'Entries affected', inspected: 'Inspected source revision', uploadDirectory: 'Upload directory',
  deleteConfirm: 'Permanently delete this inspected source entry and, for a directory, all its children?',
  invalidName: 'Enter one nonempty file name without separators, control characters, or a drive prefix.',
  invalidDestination: 'Choose a different destination outside the selected entry.', inspectFirst: 'Inspect this target before modifying it.',
  tooLarge: 'Each upload is limited to 64 MiB.', notFound: 'The source path is absent.', unknown: 'No result', partial: 'The source reported partial progress. Inspect the paths before continuing.',
  sourceChanged: 'The displayed source session changed. Open the file from its own session.',
  copyText: 'Copy', copied: 'Copied', code: 'Source', wrap: 'Wrap lines', unwrap: 'Keep columns',
  browserCopy: 'Saved browser draft', inspectBrowser: 'Compare saved browser draft', browserDiscarded: 'The saved browser copy was discarded by another editor.',
  useBrowser: 'Use this saved browser draft', keepBrowser: 'Keep my current draft in this browser', downloadDraft: 'Download current draft',
  useBrowserAsk: 'Replace the current editor text with this saved browser draft? Download your current draft first if you want to keep both.',
  recover: 'Recover source file operation', receipt: 'Saved operation intent', receiptId: 'Operation ID', readReceipt: 'Read saved operation',
  reviewed: 'You acknowledged the current source state locally. The earlier operation still has no confirmed source receipt; reading paths cannot prove it completed.',
  omittedPaths: 'Additional affected paths omitted from the bounded browser receipt',
} as const
const zh: Record<keyof typeof en, string> = {
  tools: '源文件工具', edit: '编辑源文件', search: '查找文件', git: 'Git 改动', manage: '管理文件', close: '关闭',
  loading: '正在读取源端…', working: '正在操作源端…', query: '搜索文件名', searchHelp: '在此会话所属 Runner 的工作目录中搜索。',
  none: '没有匹配文件。', open: '在官方预览中打开', openDirectory: '管理目录', staged: '已暂存', unstaged: '工作目录',
  refresh: '从源端刷新', noChanges: 'Git 未报告改动。', noDiff: '未返回文本差异。可以打开文件查看当前内容。',
  save: '保存源文件', saved: '源端已确认保存后的版本。', draft: '未保存的草稿', discard: '丢弃草稿', content: '文件内容',
  readOnly: '此源会话当前只读。', cannotEdit: '此文件不是可编辑文本、超过源端编辑限制，或使用混合换行符。请使用官方预览或下载。',
  uncertain: '源端结果尚未确认或已发生变化。操作不会自动重发。请先读取当前源状态，再选择下一步。',
  inspect: '核对当前源状态', current: '源端当前内容', keepDraft: '保留草稿并使用此源版本', useCurrent: '使用源端当前内容',
  discardAsk: '丢弃此视图中尚未保存的源文件草稿吗？', mutationDraftAsk: '此操作会影响未保存的源文件草稿。丢弃该草稿后继续吗？',
  pending: '源操作仍在进行，请等待结果后再关闭此视图。', review: '已核对源状态，开始新的操作',
  operation: '操作', path: '源路径', destination: '目标路径', name: '名称', target: '检查目标',
  newFile: '新建文件', newDirectory: '新建目录', rename: '重命名', move: '移动', copy: '复制', delete: '删除', upload: '上传文件',
  execute: '执行源文件操作', completed: '源端已确认此操作。', entries: '影响的条目数', inspected: '已检查的源版本', uploadDirectory: '上传目录',
  deleteConfirm: '永久删除此已检查的源条目吗？目录中的所有子条目也将删除。',
  invalidName: '请输入一个非空名称，不要包含路径分隔符、控制字符或盘符前缀。',
  invalidDestination: '请选择不同且位于所选条目之外的目标路径。', inspectFirst: '修改前请先检查此目标。',
  tooLarge: '每个上传文件最多为 64 MiB。', notFound: '源路径不存在。', unknown: '尚无结果', partial: '源端报告了部分改动。请先检查路径，再继续操作。',
  sourceChanged: '当前显示的源会话已切换，请从文件所属会话打开。',
  copyText: '复制', copied: '已复制', code: '源内容', wrap: '自动换行', unwrap: '保留列宽',
  browserCopy: '浏览器已保存的草稿', inspectBrowser: '对比浏览器保存的草稿', browserDiscarded: '其他编辑器已丢弃浏览器中的保存副本。',
  useBrowser: '采用此浏览器保存草稿', keepBrowser: '在浏览器中保留当前草稿', downloadDraft: '下载当前草稿',
  useBrowserAsk: '用这份浏览器保存草稿替换当前编辑器内容吗？如需保留两份，请先下载当前草稿。',
  recover: '恢复源文件操作', receipt: '已保存的操作意图', receiptId: '操作 ID', readReceipt: '读取已保存的操作',
  reviewed: '已在本地确认你核对了当前源状态。此前操作仍没有源端确认回执；读取路径不能证明该操作已经完成。',
  omittedPaths: '浏览器有界回执中省略的其他受影响路径数量',
}
type Key = keyof typeof en
type Translate = (key: Key) => string
declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { hapiSourceFiles: Key } }

const css = `
.hapi-source-actions{display:inline-flex;align-items:center;gap:4px}.hapi-source-actions>button{font:inherit;color:inherit;border:1px solid var(--hapi-border,var(--dsw-alias-border-main,#d8dedf));background:transparent;border-radius:5px;min-height:28px;padding:3px 7px;cursor:pointer;white-space:nowrap}
.hapi-source-dialog{box-sizing:border-box;width:min(860px,calc(100vw - 24px));max-height:calc(100dvh - 32px);padding:0;border:1px solid var(--hapi-border,var(--dsw-alias-border-main,#d8dedf));border-radius:10px;background:var(--hapi-bg,var(--dsw-alias-bg-layer-1,#fff));color:var(--hapi-fg,var(--dsw-alias-label-primary,#22272c));box-shadow:0 16px 64px #0004;font:13px/1.5 system-ui,sans-serif;overflow:auto}.hapi-source-dialog::backdrop{background:#0005}.hapi-source-dialog *{box-sizing:border-box}.hapi-source-dialog header{position:sticky;top:0;z-index:2;display:flex;gap:10px;align-items:center;padding:12px 16px;background:inherit;border-bottom:1px solid var(--hapi-border,#d8dedf)}.hapi-source-dialog h2{font-size:15px;margin:0;flex:1;min-width:0}.hapi-source-dialog button,.hapi-source-dialog input,.hapi-source-dialog select{font:inherit;color:inherit;border:1px solid var(--hapi-border,#d8dedf);background:var(--hapi-muted,var(--dsw-alias-bg-layer-2,#f6f7f8));border-radius:5px;min-height:32px;padding:5px 8px}.hapi-source-dialog button{cursor:pointer}.hapi-source-dialog button:disabled{opacity:.5;cursor:default}.hapi-source-dialog button:hover:not(:disabled){background:var(--hapi-hover,var(--dsw-alias-bg-layer-3,#eef2f1))}.hapi-source-dialog button[aria-pressed=true]{border-color:var(--hapi-accent,#359b6c)}.hapi-source-dialog nav,.hapi-source-bar{display:flex;gap:7px;align-items:center;flex-wrap:wrap;padding:10px 16px}.hapi-source-dialog nav{border-bottom:1px solid var(--hapi-border,#d8dedf)}.hapi-source-body{padding:12px 16px;min-height:160px}.hapi-source-path{font:12px/1.5 ui-monospace,monospace;overflow-wrap:anywhere;opacity:.75;margin:0 0 10px}.hapi-source-help{opacity:.75;margin:8px 0}.hapi-source-error{padding:9px;background:color-mix(in srgb,var(--hapi-danger,#b53232) 10%,transparent);color:var(--hapi-danger,#b53232);white-space:pre-wrap;overflow-wrap:anywhere;border-radius:5px}.hapi-source-warning{padding:9px;border:1px solid var(--dsw-static-orange-500,#c88a32);border-radius:5px}.hapi-source-form{display:grid;gap:10px}.hapi-source-form label{display:grid;gap:5px}.hapi-source-form input{width:100%;min-width:0}.hapi-source-editor{width:100%;min-height:280px;max-height:55dvh;resize:vertical;font:13px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;tab-size:4;border:1px solid var(--hapi-border,#d8dedf);border-radius:5px;background:var(--hapi-bg,var(--dsw-alias-bg-layer-1,#fff));color:inherit;padding:12px;white-space:pre;overflow:auto}.hapi-source-list{list-style:none;padding:0;margin:10px 0;max-height:48dvh;overflow:auto}.hapi-source-list li{display:flex;align-items:center;gap:8px;border-bottom:1px solid var(--hapi-border,#d8dedf);padding:6px 0;overflow-wrap:anywhere}.hapi-source-list li>button{min-width:0;text-align:left;flex:1}.hapi-source-list small{white-space:nowrap;opacity:.7}.hapi-source-diff{max-height:55dvh;overflow:auto}.hapi-source-revision{font:11px/1.4 ui-monospace,monospace;overflow-wrap:anywhere;opacity:.75}.hapi-source-danger{color:var(--hapi-danger,#b53232)!important}.hapi-source-status{display:block;margin:8px 0}.hapi-source-row{display:flex;align-items:center;gap:7px;flex-wrap:wrap}.hapi-source-row input{min-width:100px;flex:1}.hapi-source-dialog [data-code-block-banner]{position:static}.hapi-source-dialog footer{padding:8px 16px 14px;display:flex;justify-content:flex-end;gap:8px}@media(max-width:600px){.hapi-source-dialog{width:calc(100vw - 12px);max-height:calc(100dvh - 12px)}.hapi-source-dialog nav{gap:4px;padding:8px}.hapi-source-body{padding:10px}.hapi-source-editor{font-size:16px;min-height:220px}.hapi-source-form input{font-size:16px}}
`
const sourceKey = (source: WorkbenchSource): string => JSON.stringify([source.sourceHubId, source.sourceSessionId, source.machineId])
type Mode = 'edit' | 'search' | 'git' | 'manage'

class SourceActions {
  readonly edits = new Map<string, SourceFileEdit>()
  readonly mutations = new Map<string, SourceFileMutation>()
  private readonly listeners = new Set<() => void>()
  private version = 0
  private work = 0
  private preparedVersion = -1
  private readonly subscriptions: Array<() => void> = []
  constructor(readonly api: NativeWorkbenchApi, private readonly t: Translate, private readonly journal: SourceFileMutationJournal) {}
  getSnapshot = (): number => this.version
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private changed = (): void => { this.version++; for (const listener of this.listeners) listener() }
  beginWork(): () => void { this.work++; this.changed(); return () => { this.work--; this.changed() } }
  editor(source: WorkbenchSource, path: string): SourceFileEdit {
    const key = `${sourceKey(source)}\0${path}`
    let editor = this.edits.get(key)
    if (!editor) { editor = new SourceFileEdit(this.api, source, path); this.subscriptions.push(editor.subscribe(this.changed)); this.edits.set(key, editor) }
    return editor
  }
  mutation(source: WorkbenchSource): SourceFileMutation {
    const key = sourceKey(source)
    let mutation = this.mutations.get(key)
    if (!mutation) { mutation = new SourceFileMutation(this.api, source, this.journal); this.subscriptions.push(mutation.subscribe(this.changed)); this.mutations.set(key, mutation) }
    return mutation
  }
  get pending(): boolean { return this.work > 0 || [...this.edits.values()].some(edit => edit.getSnapshot().busy === 'save') || [...this.mutations.values()].some(mutation => mutation.getSnapshot().busy) }
  get unresolved(): boolean { return [...this.mutations.values()].some(mutation => mutation.getSnapshot().uncertain) }
  get dirty(): boolean { return [...this.edits.values()].some(edit => edit.dirty) }
  get preparedForReload(): boolean { return this.preparedVersion === this.version && !this.pending && !this.unresolved }
  async prepareReload(): Promise<void> {
    if (this.pending) throw new Error(this.t('pending'))
    if (this.unresolved) throw new Error(this.t('uncertain'))
    await Promise.all([...this.edits.values()].map(edit => edit.checkpoint()))
    this.preparedVersion = this.version
  }
  beforeClose = (): boolean => {
    if (this.pending) { window.alert(this.t('pending')); return false }
    if (this.unresolved) { window.alert(this.t('uncertain')); return false }
    if (!this.dirty) return true
    if (!window.confirm(this.t('discardAsk'))) return false
    for (const edit of this.edits.values()) edit.discard()
    return true
  }
  beforeMutation(source: WorkbenchSource, path: string): boolean {
    const affected = [...this.edits.values()].filter(edit => sourceKey(edit.source) === sourceKey(source) && sourceFileContains(path, edit.path))
    if (affected.some(edit => edit.getSnapshot().busy === 'save')) throw new Error(this.t('pending'))
    if (affected.some(edit => edit.dirty) && !window.confirm(this.t('mutationDraftAsk'))) return false
    for (const edit of affected) edit.discard()
    return true
  }
  dispose(): void { for (const unsubscribe of this.subscriptions) unsubscribe(); for (const mutation of this.mutations.values()) mutation.dispose(); this.listeners.clear() }
}

function SourceCode({ code, diff = false, t }: { code: string; diff?: boolean; t: Translate }) {
  return <CodeBlock code={code} lang={diff ? 'diff' : undefined} copyLabel={t('copyText')} copiedLabel={t('copied')}
    toolbarLabels={{ codeLabel: t('code'), wrapLabel: t('wrap'), unwrapLabel: t('unwrap') }}/>
}
function SourceDialog({ title, busy, close, t, children }: { title: string; busy: boolean; close: () => void; t: Translate; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null), id = useId()
  useEffect(() => { const dialog = ref.current!; dialog.showModal(); return () => { dialog.close() } }, [])
  return <dialog ref={ref} className="hapi-source-dialog" aria-labelledby={id} onCancel={event => { event.preventDefault(); if (!busy) close() }}>
    <header><h2 id={id}>{title}</h2><button type="button" disabled={busy} aria-label={t('close')} onClick={close}>×</button></header>
    {children}
  </dialog>
}
function SourceEdit({ editor, writable, t }: { editor: SourceFileEdit; writable: boolean; t: Translate }) {
  const state = useSyncExternalStore(editor.subscribe, editor.getSnapshot)
  useEffect(() => { void editor.load() }, [editor])
  return <div className="hapi-source-body">
    <p className="hapi-source-path">{editor.path}</p>
    {state.busy && <p role="status">{state.busy === 'save' ? t('working') : t('loading')}</p>}
    {state.error && <p className="hapi-source-error" role="alert">{state.error}</p>}
    {state.error && <button type="button" disabled={!!state.busy} onClick={() => { void editor.inspectBrowserDraft() }}>{t('inspectBrowser')}</button>}
    {state.base && !editor.writable && <p>{t('cannotEdit')}</p>}
    {typeof state.base?.text === 'string' && <>
      <textarea className="hapi-source-editor" aria-label={t('content')} value={state.text} spellCheck={false} autoCapitalize="none" autoCorrect="off"
        readOnly={!writable || !editor.writable} onChange={event => editor.edit(event.target.value)}
        onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); if (writable) void editor.save() } }}/>
      <div className="hapi-source-row"><button type="button" disabled={!writable || !editor.writable || !editor.dirty || !!state.busy || state.uncertain} onClick={() => { void editor.save() }}>{t('save')}</button>
        <button type="button" disabled={!editor.dirty || !!state.busy} onClick={() => { if (window.confirm(t('discardAsk'))) editor.discard() }}>{t('discard')}</button>
        <button type="button" onClick={() => {
          const url = URL.createObjectURL(new Blob([state.text], { type: 'text/plain;charset=utf-8' })), anchor = document.createElement('a');
          anchor.href = url; anchor.download = `${state.base?.fileName ?? 'file'}.draft.txt`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 30_000);
        }}>{t('downloadDraft')}</button>
        <span role="status">{state.saved ? t('saved') : editor.dirty ? t('draft') : ''}</span></div>
    </>}
    {state.browserDraft !== undefined && <section><h3>{t('browserCopy')}</h3>
      {state.browserDraft === null ? <p>{t('browserDiscarded')}</p> : <div className="hapi-source-diff"><SourceCode code={state.browserDraft.text} t={t}/></div>}
      <div className="hapi-source-row"><button type="button" disabled={!!state.busy} onClick={() => { void editor.resolveBrowserDraft(false) }}>{t('keepBrowser')}</button>
        <button type="button" disabled={!!state.busy || !state.browserDraft} onClick={() => { if (window.confirm(t('useBrowserAsk'))) void editor.resolveBrowserDraft(true) }}>{t('useBrowser')}</button></div></section>}
    {state.uncertain && <div className="hapi-source-warning"><p>{t('uncertain')}</p><button type="button" disabled={!!state.busy} onClick={() => { void editor.inspect() }}>{t('inspect')}</button></div>}
    {state.current && <section><h3>{t('current')}</h3><p className="hapi-source-revision">{state.current.hash ?? ''}</p>
      {state.current.text === null ? <p>{t('cannotEdit')}</p> : <div className="hapi-source-diff"><SourceCode code={state.current.text} t={t}/></div>}
      <div className="hapi-source-row"><button type="button" disabled={!!state.busy || !state.current.writable || !writable} onClick={() => editor.acceptCurrent(true)}>{t('keepDraft')}</button>
        <button type="button" disabled={!!state.busy} onClick={() => editor.acceptCurrent(false)}>{t('useCurrent')}</button></div></section>}
  </div>
}

function SourceSearch({ api, source, open, t }: { api: NativeWorkbenchApi; source: WorkbenchSource; open: (path: string, directory?: boolean) => void; t: Translate }) {
  const [query, setQuery] = useState(''), [files, setFiles] = useState<WorkbenchResponse<'nativeFileSearch'>['files']>([])
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    const timer = setTimeout(() => {
      setBusy(true); setError(null)
      void api.nativeFileSearch({ source, query, limit: 500 }).then(remoteValue).then(result => {
        if (!result.success) throw new Error(result.error || 'The source could not search its files')
        if (alive) setFiles(result.files)
      }).catch(error => { if (alive) setError(errorMessage(error)) }).finally(() => { if (alive) setBusy(false) })
    }, 250)
    return () => { alive = false; clearTimeout(timer) }
  }, [api, source, query])
  return <div className="hapi-source-body"><div className="hapi-source-form"><label>{t('query')}<input autoFocus value={query} onChange={event => setQuery(event.target.value)} spellCheck={false}/></label></div>
    <p className="hapi-source-help">{t('searchHelp')}</p>{busy && <p role="status">{t('loading')}</p>}{error && <p role="alert" className="hapi-source-error">{error}</p>}
    <ul className="hapi-source-list">{files.map(file => <li key={file.fullPath}><button type="button" title={file.fullPath} onClick={() => open(file.fullPath, file.fileType === 'folder')}>{file.filePath || file.fullPath}</button><small>{file.fileType === 'folder' ? '▸' : ''}</small></li>)}</ul>
    {!busy && !files.length && <p>{t('none')}</p>}
  </div>
}

function SourceGit({ api, source, cwd, path, open, t }: { api: NativeWorkbenchApi; source: WorkbenchSource; cwd: string; path: string; open: (path: string) => void; t: Translate }) {
  const [changes, setChanges] = useState<ReturnType<typeof parseWorkbenchChanges> | null>(null), [selected, setSelected] = useState<WorkbenchChange | null>(null)
  const [diff, setDiff] = useState<string | null>(null), [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false), [revision, setRevision] = useState(0)
  useEffect(() => {
    let alive = true; setBusy(true); setError(null)
    void Promise.all([api.nativeGit({ source, kind: 'status' }), api.nativeGit({ source, kind: 'numstat', staged: true }), api.nativeGit({ source, kind: 'numstat', staged: false })])
      .then(values => values.map(remoteValue)).then(([status, staged, unstaged]) => {
        if (!status?.success || !staged?.success || !unstaged?.success) throw new Error([status, staged, unstaged].find(value => !value?.success)?.error ?? status?.stderr ?? 'Git could not read the source workspace')
        if (alive) { const result = parseWorkbenchChanges(status.stdout ?? '', staged.stdout ?? '', unstaged.stdout ?? ''); setChanges(result); setSelected(result.changes.find(change => resolveWorkspacePath(cwd, change.path) === path) ?? null) }
      }).catch(error => { if (alive) setError(errorMessage(error)) }).finally(() => { if (alive) setBusy(false) })
    return () => { alive = false }
  }, [api, source, cwd, path, revision])
  useEffect(() => {
    let alive = true; setDiff(null)
    if (selected) void api.nativeGit({ source, kind: 'diff', path: selected.path, staged: selected.staged }).then(remoteValue).then(result => {
      if (!result.success) throw new Error(result.error ?? result.stderr ?? 'The source diff could not be read')
      if (alive) setDiff(result.stdout ?? '')
    }).catch(error => { if (alive) setError(errorMessage(error)) })
    return () => { alive = false }
  }, [api, source, selected])
  return <div className="hapi-source-body"><div className="hapi-source-row"><button type="button" disabled={busy} onClick={() => setRevision(value => value + 1)}>{t('refresh')}</button><span>{changes?.branch}</span></div>
    {busy && <p role="status">{t('loading')}</p>}{error && <p className="hapi-source-error" role="alert">{error}</p>}
    <ul className="hapi-source-list">{changes?.changes.map(change => <li key={`${change.staged}:${change.path}`}><button type="button" aria-pressed={selected === change} onClick={() => setSelected(change)}>{change.path}</button>
      <small>{change.staged ? t('staged') : t('unstaged')} · {change.status}{change.added === undefined ? '' : ` +${change.added}`}{change.removed === undefined ? '' : ` −${change.removed}`}</small></li>)}</ul>
    {changes && !changes.changes.length && <p>{t('noChanges')}</p>}
    {selected && <section><div className="hapi-source-row"><strong>{selected.path}</strong><button type="button" onClick={() => open(resolveWorkspacePath(cwd, selected.path))}>{t('open')}</button></div>
      {diff === null ? <p role="status">{t('loading')}</p> : diff ? <div className="hapi-source-diff"><SourceCode code={diff} diff t={t}/></div> : <p>{t('noDiff')}</p>}</section>}
  </div>
}

type ManageAction = 'create-file' | 'create-directory' | 'rename' | 'move' | 'copy' | 'delete'
const actionKey: Record<ManageAction, Key> = { 'create-file': 'newFile', 'create-directory': 'newDirectory', rename: 'rename', move: 'move', copy: 'copy', delete: 'delete' }
function SourceManage({ actions, source, cwd, path, directory, writable, open, t }: {
  actions: SourceActions; source: WorkbenchSource; cwd: string; path: string; directory: boolean; writable: boolean; open: (path: string, directory?: boolean) => void; t: Translate;
}) {
  const mutation = useMemo(() => actions.mutation(source), [actions, source]), state = useSyncExternalStore(mutation.subscribe, mutation.getSnapshot)
  const [action, setAction] = useState<ManageAction>(directory ? 'create-file' : 'rename'), [target, setTarget] = useState(path), [value, setValue] = useState('')
  const [entry, setEntry] = useState<WorkbenchResponse<'nativeFileInspect'>['entry']>(), [inspectedPath, setInspectedPath] = useState('')
  const [reading, setReading] = useState(false), [uploading, setUploading] = useState(false), [error, setError] = useState<string | null>(null)
  const [uploadTarget, setUploadTarget] = useState(directory ? path : parentPath(path))
  const uploadInput = useRef<HTMLInputElement>(null), creating = action === 'create-file' || action === 'create-directory'
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; void mutation.load(); return () => { mounted.current = false } }, [mutation])
  const selectedPath = resolveWorkspacePath(cwd, target), parent = directory ? path : parentPath(path)
  const inspect = async (): Promise<void> => {
    if (reading || state.busy) return
    const inspected = selectedPath; setReading(true); setError(null); setEntry(undefined); setInspectedPath('')
    try {
      const result = remoteValue(await actions.api.nativeFileInspect({ source, path: inspected }))
      if (!result.success || !result.entry) throw new Error(result.error ?? result.code ?? t('unknown'))
      setEntry(result.entry); setInspectedPath(inspected)
    } catch (error) { setError(errorMessage(error)) }
    finally { setReading(false) }
  }
  const submit = async (): Promise<void> => {
    if (!writable || mutation.blocked || uploading || reading) return
    setError(null)
    try {
      if (creating) {
        if (!validSourceFileName(value)) throw new Error(t('invalidName'))
        const newPath = childPath(selectedPath, value)
        if (await mutation.manage({ action, path: newPath }) && mounted.current) { setValue(''); open(newPath, action === 'create-directory') }
        return
      }
      if (!entry || inspectedPath !== selectedPath) throw new Error(t('inspectFirst'))
      if (action === 'delete') {
        if (!window.confirm(`${t('deleteConfirm')}\n${entry.path}\n${t('entries')}: ${entry.entryCount}`) || !actions.beforeMutation(source, selectedPath)) return
        if (await mutation.manage({ action, path: selectedPath, expectedRevision: entry.revision, recursive: entry.type === 'directory' }) && mounted.current) { setEntry(undefined); setInspectedPath('') }
        return
      }
      if (action === 'rename' && !validSourceFileName(value)) throw new Error(t('invalidName'))
      const destination = action === 'rename' ? childPath(parentPath(selectedPath), value) : resolveWorkspacePath(cwd, value)
      if (!value.trim() || sourceFileContains(selectedPath, destination)) throw new Error(t('invalidDestination'))
      if (action !== 'copy' && !actions.beforeMutation(source, selectedPath)) return
      if (await mutation.manage({ action, path: selectedPath, destination, expectedRevision: entry.revision }) && mounted.current) { setEntry(undefined); setInspectedPath(''); open(destination, entry.type === 'directory') }
    } catch (error) { setError(errorMessage(error)) }
  }
  const upload = async (files: FileList | null): Promise<void> => {
    if (!files?.length || mutation.blocked || !writable || uploading) return
    setUploading(true); setError(null)
    const finish = actions.beginWork()
    try {
      for (const file of Array.from(files)) {
        if (!mounted.current) break
        if (!validSourceFileName(file.name)) throw new Error(t('invalidName'))
        if (file.size > MAX_DOCUMENT_BYTES) throw new Error(t('tooLarge'))
        const content = bytesToBase64(new Uint8Array(await file.arrayBuffer()))
        if (!mounted.current) break
        if (!await mutation.upload(childPath(resolveWorkspacePath(cwd, uploadTarget), file.name), content)) break
      }
    } catch (error) { setError(errorMessage(error)) }
    finally { finish(); setUploading(false); if (uploadInput.current) uploadInput.current.value = '' }
  }
  const disabled = !writable || mutation.blocked || uploading || reading
  return <div className="hapi-source-body">
    {!writable && <p>{t('readOnly')}</p>}
    {!state.loaded && <p role="status">{t('loading')}</p>}
    {state.request && <section aria-label={t('receipt')} data-source-file-operation={state.operationId ?? undefined}>
      <strong>{t('receipt')}: {state.request.action}</strong><p className="hapi-source-revision">{t('receiptId')}: {state.operationId}</p>
      <p className="hapi-source-path">{state.request.path}{'destination' in state.request ? ` → ${state.request.destination}` : ''}</p>
      {state.phase === 'reviewed' && !state.result?.success && <p className="hapi-source-help">{t('reviewed')}</p>}
    </section>}
    <form className="hapi-source-form" onSubmit={event => { event.preventDefault(); void submit() }}>
      <label>{t('operation')}<select value={action} disabled={disabled} onChange={event => {
        const next = event.target.value as ManageAction; setAction(next); setValue(next === 'rename' ? pathPartsOf(selectedPath).name : ''); setError(null)
        if (next === 'create-file' || next === 'create-directory') setTarget(parent)
      }}>{(Object.keys(actionKey) as ManageAction[]).map(key => <option key={key} value={key}>{t(actionKey[key])}</option>)}</select></label>
      <label>{t('path')}<input value={target} disabled={disabled} onChange={event => { setTarget(event.target.value); setEntry(undefined); setInspectedPath('') }} spellCheck={false} autoCapitalize="none" autoCorrect="off"/></label>
      {!creating && <div className="hapi-source-row"><button type="button" disabled={state.busy || uploading || reading} onClick={() => { void inspect() }}>{t('target')}</button>{reading && <span role="status">{t('loading')}</span>}</div>}
      {entry && <div><p className="hapi-source-path">{entry.path} · {entry.type} · {entry.size} B · {t('entries')}: {entry.entryCount}</p><p className="hapi-source-revision">{t('inspected')}: {entry.revision}</p></div>}
      {action !== 'delete' && <label>{creating || action === 'rename' ? t('name') : t('destination')}<input value={value} disabled={disabled} onChange={event => setValue(event.target.value)} spellCheck={false} autoCapitalize="none" autoCorrect="off"/></label>}
      <label>{t('uploadDirectory')}<input value={uploadTarget} disabled={disabled} onChange={event => setUploadTarget(event.target.value)} spellCheck={false} autoCapitalize="none" autoCorrect="off"/></label>
      <div className="hapi-source-row"><button type="submit" className={action === 'delete' ? 'hapi-source-danger' : undefined} disabled={disabled || !creating && (!entry || inspectedPath !== selectedPath) || action !== 'delete' && !value.trim()}>{t('execute')}</button>
        <button type="button" disabled={disabled} onClick={() => uploadInput.current?.click()}>{t('upload')}</button><input ref={uploadInput} type="file" multiple hidden aria-label={t('upload')} onChange={event => { void upload(event.target.files) }}/></div>
    </form>
    {(state.busy || uploading) && <p role="status">{t('working')}</p>}
    {(error || state.error) && <p className="hapi-source-error" role="alert">{error || state.error}</p>}
    {state.storageError && <button type="button" disabled={state.busy} onClick={() => { void mutation.load() }}>{t('readReceipt')}</button>}
    {state.result?.success && <p role="status" className="hapi-source-status">{t('completed')}</p>}
    {(state.result?.commit || state.result?.deletedPaths?.length) && !state.result.success && <div className="hapi-source-warning"><p>{t('partial')}</p><pre>{JSON.stringify(state.result.commit ?? state.result.deletedPaths, null, 2)}</pre></div>}
    {state.omittedPaths > 0 && <p>{t('omittedPaths')}: {state.omittedPaths}</p>}
    {state.uncertain && <div className="hapi-source-warning"><p>{t('uncertain')}</p><button type="button" disabled={state.busy} onClick={() => { void mutation.inspect() }}>{t('inspect')}</button>
      {state.observed && <><ul>{state.observed.map(row => <li key={row.path}><span className="hapi-source-path">{row.path}</span>: {row.result.entry ? `${row.result.entry.type} · ${row.result.entry.size} B · ${row.result.entry.revision}` : row.result.code === 'not-found' ? t('notFound') : row.result.error || row.result.code || t('unknown')}</li>)}</ul>
        <button type="button" disabled={!state.canReview || state.storageError !== null} onClick={() => { void mutation.review().then(reviewed => { if (reviewed && mounted.current) { setEntry(undefined); setInspectedPath('') } }) }}>{t('review')}</button></>}
    </div>}
  </div>
}

type ActionProps = PropsRuntime<'sidebar.right.tab.files.actions'>
function SourceTools({ ctx, actions, props, directory, t }: { ctx: Context; actions: SourceActions; props: ActionProps; directory: boolean; t: Translate }) {
  const native = props.useProjection('hapi'), observed = props.useProjection('hapiObserved'), projection = native ?? observed
  const identity = sourcePathAddress(projection)
  const source = useMemo(() => identity, [identity?.sourceSessionId, identity?.sourceHubId, identity?.machineId])
  useSyncExternalStore(listener => ctx.locale.subscribe(listener), () => ctx.locale.getSnapshot())
  useSyncExternalStore(actions.subscribe, actions.getSnapshot)
  const [mode, setMode] = useState<Mode | null>(null), [error, setError] = useState<string | null>(null)
  const [manageTarget, setManageTarget] = useState<{ path: string; directory: boolean } | null>(null)
  const mutation = useMemo(() => source && !observed?.sidechain ? actions.mutation(source) : null, [actions, source, observed?.sidechain])
  useEffect(() => { if (mutation) void mutation.load() }, [mutation])
  useEffect(() => { setMode(null); setError(null); setManageTarget(null) }, [source, props.absolutePath, props.sessionId])
  if (!source || !projection || observed?.sidechain) return null
  const writable = projection.readOnly === false, cwd = ctx.sessions.list.getSnapshot().byId[props.sessionId]?.cwd ?? ''
  const open = (path: string, directory = false): void => {
    if (ctx.sidebarRight.mounted.getSnapshot() !== props.sessionId) { setError(t('sourceChanged')); return }
    // The official Files page deliberately has no resource address: its tree
    // belongs to the Session cwd. Keep directory management at its explicit
    // source path instead of claiming openResource can navigate that tree.
    if (directory) { setManageTarget({ path, directory: true }); setMode('manage'); return }
    const address = fileAddressFor(props.sessionId, cwd, path)
    ctx.sidebarRight.openResource(address)
    setMode(null)
  }
  const close = (): void => { if (!actions.pending) setMode(null) }
  return <span className="hapi-source-actions">
    {!directory && <button type="button" title={t('edit')} aria-label={t('edit')} disabled={!writable} onClick={() => setMode('edit')}>✎</button>}
    <button type="button" aria-label={t('tools')} title={t('tools')} onClick={() => setMode(directory ? 'search' : 'manage')}>⋯</button>
    {mutation && (mutation.getSnapshot().uncertain || mutation.getSnapshot().storageError || mutation.getSnapshot().busy) && <button type="button" onClick={() => setMode('manage')}>{t('recover')}</button>}
    {mode && <SourceDialog title={t('tools')} busy={actions.pending} close={close} t={t}>
      <nav aria-label={t('tools')}>{(['search', 'git', 'manage', ...(!directory ? ['edit' as const] : [])] as Mode[]).map(item => <button type="button" key={item} aria-pressed={mode === item} disabled={actions.pending || item === 'edit' && !writable} onClick={() => setMode(item)}>{t(item)}</button>)}</nav>
      {error && <p role="alert" className="hapi-source-error">{error}</p>}
      {mode === 'edit' && <SourceEdit editor={actions.editor(source, props.absolutePath)} writable={writable} t={t}/>}
      {mode === 'search' && <SourceSearch api={actions.api} source={source} open={open} t={t}/>}
      {mode === 'git' && <SourceGit api={actions.api} source={source} cwd={cwd} path={props.absolutePath} open={open} t={t}/>}
      {mode === 'manage' && <SourceManage key={manageTarget?.path ?? props.absolutePath} actions={actions} source={source} cwd={cwd} path={manageTarget?.path ?? props.absolutePath} directory={manageTarget?.directory ?? directory} writable={writable} open={open} t={t}/>}
      <footer><button type="button" disabled={actions.pending} onClick={close}>{t('close')}</button></footer>
    </SourceDialog>}
  </span>
}

/** Only public list seats and the optional pane-close capability; no view replacement. */
export function installSourceFileActions(ctx: Context, api: HapiRemoteApi): () => void {
  const unlocale = ctx.locale.register('hapiSourceFiles', { en, zh }), t = ctx.locale.bind('hapiSourceFiles')
  const style = document.createElement('style'); style.dataset.hapiSourceFileActions = ''; style.textContent = css; document.head.append(style)
  const disposers: Array<() => void> = [unlocale, () => style.remove()]
  const owner = ctx.inject(['hapiWorkspaceUi'], current => {
  const actions = new SourceActions(api, t, current.hapiWorkspaceUi.sourceFileMutations)
  const scoped: Array<() => void> = [() => actions.dispose()]
  const Files = (props: ActionProps) => <SourceTools ctx={ctx} actions={actions} props={props} directory t={t}/>
  const Document = (props: PropsRuntime<'sidebar.right.tab.document.actions'>) => <SourceTools ctx={ctx} actions={actions} props={props} directory={false} t={t}/>
  scoped.push(ctx.slots.inject('sidebar.right.tab.files.actions', () => ctx.slots.register({ name: 'sidebar.right.tab.files.actions', id: 'hapi.source-file-tools', order: 50 }, Files)))
  scoped.push(ctx.slots.inject('sidebar.right.tab.document.actions', () => ctx.slots.register({ name: 'sidebar.right.tab.document.actions', id: 'hapi.source-file-tools', order: 50 }, Document)))
  const guard = ctx.inject(['hapiWorkspacePane'], current => { current.effect(() => current.hapiWorkspacePane.registerCloseGuard(actions.beforeClose)) })
  scoped.push(() => { void guard.dispose() })
  scoped.push(current.hapiWorkspaceUi.updates.register('Source file editors', () => actions.prepareReload()))
  scoped.push(current.hapiWorkspaceUi.updates.register('Source file editors', () => { if (!actions.preparedForReload) throw new Error('A source file editor changed while saving. Try the update again.') }, 'verify'))
  const leave = (event: BeforeUnloadEvent): void => { if (!actions.preparedForReload && (actions.dirty || actions.pending || actions.unresolved)) { event.preventDefault(); event.returnValue = '' } }
  window.addEventListener('beforeunload', leave); scoped.push(() => window.removeEventListener('beforeunload', leave))
  return () => { for (const dispose of scoped.reverse()) dispose() }
  })
  disposers.push(() => { void owner.dispose() })
  return () => { for (const dispose of disposers.reverse()) dispose() }
}
