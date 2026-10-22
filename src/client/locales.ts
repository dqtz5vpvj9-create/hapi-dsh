export const en = {
    sourceStateView: 'Source state', sourceStateHelp: 'Connection, identity and delivery reported by the original HAPI Runner. These facts do not imply that the engine is running.', sourceStateUnavailable: 'No source state is available in this session window.', sourceHub: 'Source Hub', sourceSession: 'Source session', sourceThread: 'Native thread', sourceExecution: 'Native execution state',
    originalConversation: 'Original conversation', technicalDetails: 'Technical details',
    sourceLoading: 'Reading the original conversation. The catalog is still syncing; this conversation is being loaded first.',
    sourceNotFound: 'The source Hub has not found this conversation. Its saved reference is preserved; you can retry after checking the source.',
    sourceRemoved: 'The source Hub reports that this conversation was removed. Its saved workspace position and original reference are preserved.',
    sourceDenied: 'The source Hub denied access to this conversation. Check the current account’s access before retrying.',
    sourceTransport: 'The source Hub could not be reached. Your workspace is preserved; retry when the connection is available.',
    sourceNotReady: 'The original conversation was found, but its display connection is not ready yet. Retry to continue opening the same conversation.',
    sourceAmbiguous: 'More than one source matches this saved reference. A conversation cannot be selected safely; check the source Hub identity.',
    sourceIdentityMismatch: 'The source identity does not match this saved conversation. Opening was stopped to protect its original ownership.',
    sourceResolveFailed: 'The original conversation could not be loaded. Its saved reference is preserved; see the details or retry.',
    sidebarOptions: 'List options', floatActiveSessions: 'Group connected sessions above folders', activeSessionsOnly: 'Active sessions only', sessionPreviewLimit: 'Sessions per folder preview',
    pinnedGroup: 'Pinned', inProgressGroup: 'In progress', activeGroup: 'Active', pendingGroup: 'Pending', idleGroup: 'Idle connections', showMoreSessions: 'Show more sessions', showFewerSessions: 'Show fewer sessions',
    today: 'Today', yesterday: 'Yesterday', dateRange: 'Date range', dateFrom: 'From date', dateThrough: 'Through date', clearDateRange: 'Clear date range',
    openSearch: 'Search conversations', clearSearch: 'Clear search', closeDateRange: 'Close date range', previousMonth: 'Previous month', nextMonth: 'Next month',
    pickStartDate: 'Choose a start date', pickEndDate: 'Choose an end date', sessionActivityDate: 'Conversation activity',
    mobileStatusMode: 'Mobile row status', standardStatus: 'Standard', detailedStatus: 'Detailed',
    timeJustNow: 'Now', timeMinutesAgo: '{n}m ago', timeHoursAgo: '{n}h ago', timeDaysAgo: '{n}d ago',
    fastServiceTier: 'Fast service tier', todoProgress: 'Tasks: {completed}/{total}', pendingRequestCount: '{n} pending requests', backgroundTaskCount: '{n} background tasks', scheduledMessageCount: '{n} scheduled messages',
    firstTask: 'First task', firstTaskOptional: 'Optional — create an empty session, or describe the first task.', firstTaskAttachments: 'Task attachments', removeTaskAttachment: 'Remove', firstTaskConfirmed: 'The original source confirmed the first task.', firstTaskPending: 'The session exists. Its first task is waiting for source confirmation.', retryFirstTask: 'Retry the same first task',
    browsePath: 'Browse path', parentDirectory: 'Parent folder', showHiddenFiles: 'Hidden folders', filterDirectories: 'Filter folders', showMoreDirectories: 'Show more folders', chooseDirectory: 'Use this folder', directoryOutsideRoots: 'This directory is outside the Runner’s allowed workspace roots.', worktreeDirectoryMissing: 'A worktree requires an existing source project directory.', confirmCreateDirectory: 'This directory does not exist. Select Create again to allow the Runner to create it.', directoryUnconfirmed: 'The Runner did not confirm whether this directory exists. Check the connection and retry.',
    sourceDownload: 'Download source file', sourceDownloading: 'Downloading…', sourcePathHelp: 'This file belongs to the source machine. Download a copy to open it locally.',
    sourceEngines: 'HAPI engines', sourceCreateHelp: 'Start an original HAPI Runner session. Its engine keeps control of models, permissions, and execution.',
    sourceCustomModel: 'Enter a source model ID', sourceModelPreset: 'HAPI preset', sourceModelVariant: 'Model reasoning variant',
    sourceCursorChooseVariant: 'Choose an exact model variant', sourceCursorSelectionRequired: 'Choose a variant for this Cursor model before creating the session.',
    sourceCursorSelectionUnavailable: 'This model is no longer in the selected Runner’s catalog. Choose an available model, refresh the catalog, or explicitly enter a source model ID.',
    sourceStartingMode: 'Start control', sourceStartRemote: 'Remote control', sourceStartPty: 'Local terminal (PTY)', sourceEngineUnavailable: 'This engine is unavailable on this Runner.',
    sourceCreationHistory: 'Runner launch receipts', sourceCreationUnknown: 'This launch keeps its original request ID. Check or recover its source receipt before starting it again.',
    sourceForkUnavailable: 'The original source fork is not available for this session.',
    sourceRejected: 'Source rejected the setting',
    sourceStatus: 'Source connection', sourceLocallyControlled: 'This session is controlled locally. Switch to remote control to send.', sourceReconnecting: 'Reconnecting to the source Runner', sourceReadOnly: 'The source session is read only', sourceControlled: 'Local control', takeRemoteControl: 'Switch to remote control', sourceSettings: 'Source settings', sourceUnreportedValue: 'Not reported by the source', sourceCopilotMode: 'Copilot agent mode', sourceApplied: 'Source setting confirmed', sourceSubmitted: 'Submitted; waiting for source confirmation', sourceUnknown: 'Outcome unknown; check source state', sourceSettingCheck: 'Check source state', sourceCollaboration: 'Collaboration mode', sourceServiceTier: 'Service tier',
    pluginViews: 'Plugin views', pluginViewsBeside: 'Plugin views in a new pane', openInWorkspacePane: 'Open in workspace pane',
    nativeHistory: 'Native history and accounts', sessionTools: 'Session tools', machines: 'Machines', online: 'Online',
    projectFiles: 'Project files', terminal: 'Terminal', closeFiles: 'Close file browser',
    closeUnsavedDocument: 'This document has unsaved changes. Close its view? Its draft stays in this browser until you save or reset it.',
    previousQuestion: 'Previous question', nextQuestion: 'Next question', skipQuestion: 'Skip', otherOption: 'None of the above', requiredAnswer: 'Answer this question before continuing.',
    confirmNativeUrl: 'Choose the native confirmation option before opening this link.', popupBlocked: 'Your browser blocked the link. Allow this popup, then submit again.',
    tokenUsage: 'Token usage', tokenBudget: 'Token budget', windowList: 'Switch window', openConversation: 'Open conversation', newPane: 'New pane', moveToNewWindow: 'Move to a new window', backToWorkspace: 'Back to workspace',
    recent: 'Recent', folders: 'Folders', all: 'All', attention: 'Needs attention', unread: 'Unread', markRead: 'Mark as read', markUnread: 'Mark as unread', markAllRead: 'Mark all as read',
    waitingPermission: 'Waiting for approval', waitingInput: 'Waiting for input', background: 'Background tasks', activityError: 'Execution error', compacting: 'Compacting context', offline: 'Offline',
    unknownFolder: 'No directory', subagents: 'Subagents', folderUp: 'Move folder up', folderDown: 'Move folder down', newHere: 'New session here', copyDirectory: 'Copy directory',
    allChats: 'All conversations', search: 'Search title, folder, or machine…', allEngines: 'All engines', allMachines: 'All machines',
    sessions: 'conversations', noSessions: 'No conversations match this view.', loading: 'Loading conversations…', refresh: 'Refresh',
    newSession: 'New conversation', splitHorizontal: 'Split left / right', splitVertical: 'Split top / bottom', newWindow: 'New window',
    closePane: 'Close pane', closeWindow: 'Close window', restoreWindow: 'Restore closed window', renameWindow: 'Rename window',
    zoom: 'Zoom pane', unzoom: 'Show all panes', shortcuts: 'Workspace shortcuts', window: 'Window', pane: 'Pane',
    chooseSession: 'Choose a conversation from the sidebar', emptyHelp: 'Open any machine or engine here, or split this pane to work side by side.',
    openFailed: 'This conversation could not be opened.', retry: 'Retry', dismiss: 'Dismiss', local: 'Saved on this browser',
    saving: 'Saving workspace…', saved: 'Workspace saved', failed: 'Workspace could not be saved',
    running: 'Running', idle: 'Idle', rename: 'Rename', archive: 'Archive', unarchive: 'Restore conversation', archived: 'Archived',
    showArchived: 'Show archived conversations', pin: 'Pin', unpin: 'Unpin', fork: 'Fork conversation', copyId: 'Copy session ID',
    openCurrent: 'Open in current pane', openBelow: 'Open below this pane', copySourceId: 'Copy HAPI session ID', copyNativeId: 'Copy original session ID', copyDisplayId: 'Copy serving DSH session ID',
    nativeIdUnavailable: 'The original session ID is not available yet.', pinProject: 'Pin to project', unpinProject: 'Unpin from project', pinGlobal: 'Pin globally', unpinGlobal: 'Unpin globally',
    restartSession: 'Restart conversation', deleteSession: 'Delete conversation', exportSession: 'Export conversation', migrateSession: 'Migrate Codex home', editSummary: 'Edit summary',
    openBeside: 'Open beside this pane', actions: 'Conversation actions', moveTo: 'Move pane to window', cancel: 'Cancel', save: 'Save',
    resize: 'Resize split', resizeHelp: 'Drag or use arrow keys to resize.', prefix: 'Prefix: Ctrl B', prefixReady: 'Ctrl B · waiting for key',
    shortcutHint: 'Press Ctrl B, then a key. Escape cancels.', name: 'Name', showSidebar: 'Show all conversations',
    unsaved: 'Workspace changes could not be saved', previousWindow: 'Previous window', nextWindow: 'Next window',
    nextPane: 'Next pane', focusDirection: 'Focus pane in direction', windowNumber: 'Select window 1–9', closeHelp: 'Closing a pane releases its view. Execution keeps running.',
    machine: 'Machine', engine: 'Engine', copyFailed: 'Copy failed', selected: 'Selected', more: 'More',
    nativeRequests: 'Native requests', nativeDelivery: 'Native delivery', awaitingConfirmation: 'Waiting for native confirmation',
    approve: 'Approve', deny: 'Deny', approveSession: 'Approve for this session', abort: 'Abort', submit: 'Submit answer',
    steer: 'Send as steering', cancelQueued: 'Cancel queued message', retryDelivery: 'Retry delivery', answer: 'Your answer',
    nativeStatus: 'Codex native connection', acknowledged: 'Answer sent; waiting for source confirmation',
    nativeReconnecting: 'Codex is not connected. Your draft is preserved.', nativeResumeToSend: 'Resume this native Codex session to send messages.', nativeReadOnly: 'This native Codex session is read-only.',
    keepLocal: 'Keep this layout', useServer: 'Use server layout', nativeNew: 'New Codex session', directory: 'Working directory',
    codexHome: 'Codex home', launchAccount: 'Codex account', launchKeyProfile: 'Codex key profile', model: 'Model', reasoning: 'Reasoning effort', defaultOption: 'Runner default', machineOffline: 'Offline',
    nativeCreateHelp: 'Create a native Codex thread on a connected HAPI runner.', create: 'Create', noMachines: 'No HAPI runners are connected.',
    workingTree: 'New Git worktree', worktreeName: 'Worktree name', created: 'Session created', resume: 'Resume native session',
    nativeForkUnavailable: 'Native fork is not available on this Host',
    hostTools: 'Host tools', hostSettings: 'Host settings', hostSettingsHelp: 'Open the Settings panel for this Host.', conversation: 'Conversation',
    nativeSettings: 'Native settings', nativeModel: 'Codex model', nativeReasoning: 'Codex reasoning effort', nativePermission: 'Codex permissions',
    nativeCollaboration: 'Codex collaboration mode', nativeServiceTier: 'Codex service tier', sourceUnreported: 'Not reported by Codex', modelDefault: 'Model default',
    permission: 'Permissions', permissionDefault: 'Request approval', permissionReadOnly: 'Read only', permissionYolo: 'Full access',
    collaboration: 'Mode', collaborationDefault: 'Default', collaborationPlan: 'Plan', serviceTier: 'Service tier',
    settingUnknown: 'This setting has not been confirmed. Check its native receipt before making another change.', checkNativeResult: 'Check native result',
    openFork: 'Open native fork', reconcileFork: 'Reconcile native fork', closeForkIntent: 'Close unresolved intent', forkRecovery: 'Recovery options',
    forkDuplicateHelp: 'The original request may already have created a native thread. A new request can create another thread; its receipt will record this relationship.',
    forkDuplicateAccept: 'I accept that this can create a duplicate native thread.', forkDuplicate: 'Create a new fork attempt',
    forkBoundaryHelp: 'Create a native fork at this completed message. The child opens after its native binding is ready.',
    forkLatestHelp: 'Create a native fork from the latest available boundary. The child opens after its native binding is ready.',
    dshCreateHelp: 'Create an official DSH session on the selected Host.', primaryHost: 'Primary Host', hostDefaultDirectory: 'Host default directory',
    browseDirectory: 'Browse directories', homeDirectory: 'Home', newDirectory: 'New directory', showHidden: 'Show hidden directories',
    directoryTruncated: 'This directory listing is truncated. Enter an exact path to reach an omitted directory.', namedSessionRetry: 'Retry uses the same named blank session and directory.',
    nativeCreationHistory: 'Native creation receipts', openCreatedSession: 'Open created session', reconcileCreation: 'Recover this creation',
    nativePlan: 'Codex plan', implementPlan: 'Implement plan', planSubmitting: 'Sending the implementation request…',
    planSubmitted: 'Codex accepted the implementation request.', planQueued: 'Implementation is in the native Codex queue.',
    planInvoked: 'Codex started the implementation turn. Follow its progress in the conversation.',
    planUnknown: 'The native result is unconfirmed. Check its receipt; this request will not be sent again.', planRejected: 'Codex rejected this implementation request.',
    untitledConversation: 'Untitled conversation', paneCount: '{n} panes', statusFilter: 'Status',
    paneActions: 'Pane actions', windowActions: 'Window actions', paneDrag: 'Drag pane',
    composerMore: 'More input controls', composerTools: 'Conversation tools',
    nativeResumeHint: 'The source is disconnected; sending still queues a durable turn, Resume reconnects the native session.',
    errorSummary: 'The action could not be completed.', readableMachineFallback: 'Unknown machine',
} as const

export const zh: Record<keyof typeof en, string> = {
    sourceStateView: '源会话状态', sourceStateHelp: '原 HAPI Runner 报告的连接、身份和投递状态。存在这些信息并不表示引擎正在运行。', sourceStateUnavailable: '当前会话窗口尚无源状态。', sourceHub: '源 Hub', sourceSession: '源会话', sourceThread: '原生线程', sourceExecution: '原生执行状态',
    originalConversation: '原有会话', technicalDetails: '技术详情',
    sourceLoading: '正在读取原始会话。目录仍在同步，这个会话会优先加载。',
    sourceNotFound: '源 Hub 暂未找到这个会话。工作区保留了原始引用，请检查源端后重试。',
    sourceRemoved: '源 Hub 已明确报告这个会话被移除。工作区中的位置和原始引用仍会保留。',
    sourceDenied: '源 Hub 拒绝了对这个会话的访问，请检查当前账号的权限后重试。',
    sourceTransport: '暂时无法连接源 Hub。工作区已保留，连接恢复后可以重试。',
    sourceNotReady: '已经找到原始会话，但展示连接尚未就绪。重试会继续打开同一个会话。',
    sourceAmbiguous: '这个原始引用对应多个来源，无法安全选择会话。请检查源 Hub 的身份。',
    sourceIdentityMismatch: '源身份与保存的会话不一致，已停止打开，以免进入其他会话。',
    sourceResolveFailed: '暂时无法载入原始会话。工作区保留了原始引用，可以查看详情或重试。',
    sidebarOptions: '列表选项', floatActiveSessions: '连接中的会话在目录上方分组', activeSessionsOnly: '仅显示活跃会话', sessionPreviewLimit: '每个目录的预览会话数',
    pinnedGroup: '置顶', inProgressGroup: '进行中', activeGroup: '活跃', pendingGroup: '待处理', idleGroup: '空闲连接', showMoreSessions: '显示更多会话', showFewerSessions: '收起部分会话',
    today: '今天', yesterday: '昨天', dateRange: '日期范围', dateFrom: '开始日期', dateThrough: '结束日期', clearDateRange: '清空日期范围',
    openSearch: '搜索会话', clearSearch: '清空搜索', closeDateRange: '关闭日期范围', previousMonth: '上个月', nextMonth: '下个月',
    pickStartDate: '选择开始日期', pickEndDate: '选择结束日期', sessionActivityDate: '有会话活动',
    mobileStatusMode: '移动端行状态', standardStatus: '标准', detailedStatus: '详细',
    timeJustNow: '刚刚', timeMinutesAgo: '{n} 分钟前', timeHoursAgo: '{n} 小时前', timeDaysAgo: '{n} 天前',
    fastServiceTier: '快速服务', todoProgress: '任务：{completed}/{total}', pendingRequestCount: '{n} 个待处理请求', backgroundTaskCount: '{n} 个后台任务', scheduledMessageCount: '{n} 条定时消息',
    firstTask: '首条任务', firstTaskOptional: '可选：创建空白会话，或在此描述首条任务。', firstTaskAttachments: '任务附件', removeTaskAttachment: '移除', firstTaskConfirmed: '源端已确认接收首条任务。', firstTaskPending: '会话已经创建，首条任务正在等待源端确认。', retryFirstTask: '重试同一条首条任务',
    browsePath: '浏览路径', parentDirectory: '上级目录', showHiddenFiles: '隐藏目录', filterDirectories: '筛选目录', showMoreDirectories: '显示更多目录', chooseDirectory: '使用此目录', directoryOutsideRoots: '此目录不在 Runner 允许的工作区根目录内。', worktreeDirectoryMissing: '创建工作树需要一个已经存在的项目目录。', confirmCreateDirectory: '目录尚不存在。再次选择“创建”将允许 Runner 创建此目录。', directoryUnconfirmed: 'Runner 尚未确认此目录是否存在，请检查连接后重试。',
    sourceDownload: '下载源文件', sourceDownloading: '正在下载…', sourcePathHelp: '此文件位于源机器上。下载副本后可在本机打开。',
    sourceEngines: 'HAPI 引擎', sourceCreateHelp: '启动原 HAPI Runner 会话，由其引擎管理模型、权限和执行。',
    sourceCustomModel: '填写源端模型 ID', sourceModelPreset: 'HAPI 预设', sourceModelVariant: '模型推理变体',
    sourceCursorChooseVariant: '请选择精确的模型变体', sourceCursorSelectionRequired: '请为这个 Cursor 模型选择变体，再创建会话。',
    sourceCursorSelectionUnavailable: '所选 Runner 的目录已不再包含这个模型。请选择可用模型、刷新目录，或明确填写源端模型 ID。',
    sourceStartingMode: '启动控制方式', sourceStartRemote: '远程控制', sourceStartPty: '本地终端（PTY）', sourceEngineUnavailable: '此 Runner 无法使用该引擎。',
    sourceCreationHistory: 'Runner 启动回执', sourceCreationUnknown: '本次启动保留原始请求编号。请先查询或恢复源端回执，再进行下一次启动。',
    sourceForkUnavailable: '此会话尚未提供原引擎分支操作。',
    sourceRejected: '源端拒绝了设置',
    sourceStatus: '源端连接', sourceLocallyControlled: '此会话由本地控制；切换到远程控制后才能发送。', sourceReconnecting: '正在重新连接源 Runner', sourceReadOnly: '源会话当前只读', sourceControlled: '本地控制', takeRemoteControl: '切换到远程控制', sourceSettings: '源端设置', sourceUnreportedValue: '源端尚未回报', sourceCopilotMode: 'Copilot 代理模式', sourceApplied: '源端已确认设置', sourceSubmitted: '已提交，等待源端确认', sourceUnknown: '结果未知；请查询源状态', sourceSettingCheck: '查询源状态', sourceCollaboration: '协作模式', sourceServiceTier: '服务级别',
    pluginViews: '插件视图', pluginViewsBeside: '在新窗格打开插件视图', openInWorkspacePane: '在工作区窗格中打开',
    nativeHistory: '原生历史与账号', sessionTools: '会话工具', machines: '机器', online: '在线',
    projectFiles: '项目文件', terminal: '终端', closeFiles: '关闭文件浏览器',
    closeUnsavedDocument: '文档有未保存的改动。关闭视图吗？草稿会保留在此浏览器中，直到保存或重置。',
    previousQuestion: '上一题', nextQuestion: '下一题', skipQuestion: '跳过', otherOption: '以上均不符合', requiredAnswer: '请先回答当前问题。',
    confirmNativeUrl: '请先选择原生请求中的确认选项，再打开链接。', popupBlocked: '浏览器阻止了链接弹窗。允许此弹窗后请重新提交。',
    tokenUsage: 'Token 用量', tokenBudget: 'Token 预算', windowList: '切换窗口', openConversation: '打开聊天', newPane: '新窗格', moveToNewWindow: '移动到新窗口', backToWorkspace: '返回工作区',
    recent: '最近', folders: '目录', all: '全部', attention: '需要处理', unread: '未读', markRead: '标记已读', markUnread: '标记未读', markAllRead: '全部标记已读',
    waitingPermission: '等待批准', waitingInput: '等待回答', background: '后台任务', activityError: '执行异常', compacting: '压缩上下文', offline: '离线',
    unknownFolder: '无目录', subagents: '子会话', folderUp: '目录上移', folderDown: '目录下移', newHere: '在此新建会话', copyDirectory: '复制目录',
    allChats: '全部聊天', search: '搜索标题、目录或机器…', allEngines: '全部引擎', allMachines: '全部机器',
    sessions: '个会话', noSessions: '没有符合当前条件的会话。', loading: '正在载入会话…', refresh: '刷新',
    newSession: '新建聊天', splitHorizontal: '左右分屏', splitVertical: '上下分屏', newWindow: '新建窗口',
    closePane: '关闭窗格', closeWindow: '关闭窗口', restoreWindow: '恢复已关闭窗口', renameWindow: '重命名窗口',
    zoom: '放大窗格', unzoom: '显示全部窗格', shortcuts: '工作区快捷键', window: '窗口', pane: '窗格',
    chooseSession: '从侧边栏选择聊天', emptyHelp: '在这里打开任意机器和引擎的会话，或通过分屏并排工作。',
    openFailed: '无法打开这个会话。', retry: '重试', dismiss: '关闭提示', local: '已保存在此浏览器',
    saving: '正在保存工作区…', saved: '工作区已保存', failed: '工作区保存失败',
    running: '运行中', idle: '空闲', rename: '重命名', archive: '归档', unarchive: '恢复会话', archived: '已归档',
    showArchived: '显示已归档会话', pin: '置顶', unpin: '取消置顶', fork: '分支会话', copyId: '复制会话 ID',
    openCurrent: '在当前窗格打开', openBelow: '在下方打开', copySourceId: '复制 HAPI 会话 ID', copyNativeId: '复制原始会话 ID', copyDisplayId: '复制 DSH 展示会话 ID',
    nativeIdUnavailable: '原始会话 ID 尚不可用。', pinProject: '在项目内置顶', unpinProject: '取消项目置顶', pinGlobal: '全局置顶', unpinGlobal: '取消全局置顶',
    restartSession: '重启会话', deleteSession: '删除会话', exportSession: '导出会话', migrateSession: '迁移 Codex home', editSummary: '编辑摘要',
    openBeside: '在旁边打开', actions: '会话操作', moveTo: '移动窗格到窗口', cancel: '取消', save: '保存',
    resize: '调整分屏大小', resizeHelp: '拖动或使用方向键调整大小。', prefix: '前缀键：Ctrl B', prefixReady: 'Ctrl B · 等待按键',
    shortcutHint: '按 Ctrl B 后再按快捷键。Escape 取消。', name: '名称', showSidebar: '展开全部聊天',
    unsaved: '无法保存工作区改动', previousWindow: '上一个窗口', nextWindow: '下一个窗口',
    nextPane: '下一个窗格', focusDirection: '按方向切换窗格', windowNumber: '切换到窗口 1–9', closeHelp: '关闭窗格只释放视图，会话会继续运行。',
    machine: '机器', engine: '引擎', copyFailed: '复制失败', selected: '已选择', more: '更多',
    nativeRequests: '原生请求', nativeDelivery: '原生投递', awaitingConfirmation: '等待原生确认',
    approve: '批准', deny: '拒绝', approveSession: '在此会话中批准', abort: '中止', submit: '提交答案',
    steer: '作为引导发送', cancelQueued: '取消排队消息', retryDelivery: '重试投递', answer: '你的回答',
    nativeStatus: 'Codex 原生连接', acknowledged: '回答已发送，等待源端确认',
    nativeReconnecting: 'Codex 尚未连接，草稿已保留。', nativeResumeToSend: '恢复此 Codex 原生会话后即可发送消息。', nativeReadOnly: '此 Codex 原生会话当前只读。',
    keepLocal: '保留此布局', useServer: '使用服务端布局', nativeNew: '新建 Codex 会话', directory: '工作目录',
    codexHome: 'Codex home', launchAccount: 'Codex 账号', launchKeyProfile: 'Codex 密钥配置', model: '模型', reasoning: '推理强度', defaultOption: 'Runner 默认值', machineOffline: '离线',
    nativeCreateHelp: '在已连接的 HAPI Runner 上创建 Codex 原生线程。', create: '创建', noMachines: '没有已连接的 HAPI Runner。',
    workingTree: '新建 Git worktree', worktreeName: 'Worktree 名称', created: '会话已创建', resume: '恢复原生会话',
    nativeForkUnavailable: '此 Host 尚未提供原生分叉',
    hostTools: 'Host 工具', hostSettings: 'Host 设置', hostSettingsHelp: '打开此 Host 的设置面板。', conversation: '聊天',
    nativeSettings: '原生设置', nativeModel: 'Codex 模型', nativeReasoning: 'Codex 推理强度', nativePermission: 'Codex 权限',
    nativeCollaboration: 'Codex 协作模式', nativeServiceTier: 'Codex 服务级别', sourceUnreported: 'Codex 尚未回报', modelDefault: '模型默认值',
    permission: '权限', permissionDefault: '请求批准', permissionReadOnly: '只读', permissionYolo: '完全访问',
    collaboration: '模式', collaborationDefault: '默认', collaborationPlan: '计划', serviceTier: '服务级别',
    settingUnknown: '此设置尚未确认。请先核对原生回执，再进行其他改动。', checkNativeResult: '核对原生结果',
    openFork: '打开原生分支', reconcileFork: '核对并恢复绑定', closeForkIntent: '关闭未解决意图', forkRecovery: '恢复选项',
    forkDuplicateHelp: '原始请求可能已经创建了原生线程。新请求可能再创建一个线程，回执会记录二者的关联。',
    forkDuplicateAccept: '我接受此次操作可能创建重复的原生线程。', forkDuplicate: '发起新的分叉尝试',
    forkBoundaryHelp: '从这条已完成的消息创建原生分支；子线程绑定就绪后才会打开。',
    forkLatestHelp: '从最近可用的边界创建原生分支；子线程绑定就绪后才会打开。',
    dshCreateHelp: '在所选 Host 上创建官方 DSH 会话。', primaryHost: '主 Host', hostDefaultDirectory: 'Host 默认目录',
    browseDirectory: '浏览目录', homeDirectory: '主目录', newDirectory: '新建目录', showHidden: '显示隐藏目录',
    directoryTruncated: '目录列表已截断。可以输入准确路径进入未列出的目录。', namedSessionRetry: '重试会使用同一个具名空白会话和目录。',
    nativeCreationHistory: '原生创建回执', openCreatedSession: '打开已创建的会话', reconcileCreation: '恢复这次创建',
    nativePlan: 'Codex 计划', implementPlan: '实施计划', planSubmitting: '正在提交实施请求…',
    planSubmitted: 'Codex 已接受实施请求。', planQueued: '实施请求已进入 Codex 原生队列。',
    planInvoked: 'Codex 已开始实施回合，请在聊天中查看执行进度。',
    planUnknown: '原生结果尚未确认。请核对回执；此请求不会被再次发送。', planRejected: 'Codex 拒绝了此次实施请求。',
    untitledConversation: '未命名会话', paneCount: '{n} 个窗格', statusFilter: '状态',
    paneActions: '窗格操作', windowActions: '窗口操作', paneDrag: '拖动窗格',
    composerMore: '更多输入控件', composerTools: '会话工具',
    nativeResumeHint: '源端已断开；发送仍会排队为可恢复的原生回合，Resume 会重连原生会话。',
    errorSummary: '操作未能完成。', readableMachineFallback: '未知机器',
}

export type WorkspaceKey = keyof typeof en
export type WorkspaceTranslate = (key: WorkspaceKey, params?: Record<string, unknown>) => string

declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface LocaleNamespaceMap { hapiWorkspace: WorkspaceKey }
}

/**
 * User-facing labels for engine, host and model values. Internal projection
 * identifiers (`hapi-observed`, `hapi-codex-native`, provider tuples, bare
 * UUIDs) never reach the sidebar, window tabs or the source header verbatim.
 */
const INTERNAL_NAMES: Record<string, string> = {
    dsh: 'DSH', codex: 'Codex', claude: 'Claude', gemini: 'Gemini', cursor: 'Cursor', copilot: 'Copilot',
    opencode: 'OpenCode', hapi: 'HAPI', 'hapi-observed': 'HAPI', 'hapi-codex-native': 'Codex',
    'hapi-dsh-runner': 'HAPI Runner', 'hapi-runner': 'HAPI Runner', 'hapi-presets': 'HAPI presets',
    'hapi-codex': 'Codex', 'codex-native': 'Codex', 'dsh-native': 'DSH',
}
const INTERNAL_ID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(?:hapi|host|machine|session|native|dsh)-(?:observed|codex-native|runner|dsh-runner)(?:[-:][\w-]+)?|[0-9a-f]{24,})$/i

/** A value that is a machine/engine/session identifier rather than a label. */
export function isInternalIdentifier(value: string | null | undefined): boolean {
    const raw = value?.trim()
    return Boolean(raw && (INTERNAL_ID.test(raw) || /^hapi-(?:observed|codex-native)$/i.test(raw)))
}

/**
 * Engine values are stored as source flavors (`dsh`, `codex`, `hapi-observed`).
 * Return the human name and leave unknown custom flavors capitalized.
 */
export function readableEngine(value: string | null | undefined): string {
    const raw = value?.trim()
    if (!raw) return ''
    const known = INTERNAL_NAMES[raw.toLowerCase()]
    if (known) return known
    const tail = raw.split(/[:/]/).filter(Boolean).at(-1) ?? raw
    const mapped = INTERNAL_NAMES[tail.toLowerCase()]
    if (mapped) return mapped
    return tail.charAt(0).toUpperCase() + tail.slice(1)
}

/** Machine labels fall back to nothing instead of a raw host id. */
export function readableHost(value: string | null | undefined): string {
    const raw = value?.trim()
    if (!raw || INTERNAL_ID.test(raw)) return ''
    const known = INTERNAL_NAMES[raw.toLowerCase()]
    return known ?? raw
}

function modelName(value: unknown, depth: number): string | null {
    if (depth > 3 || value === null || value === undefined) return null
    if (typeof value === 'string') {
        const text = value.trim()
        return text && !INTERNAL_NAMES[text.toLowerCase()] ? text : null
    }
    if (Array.isArray(value)) {
        for (const item of [...value].reverse()) {
            const found = modelName(item, depth + 1)
            if (found) return found
        }
        return null
    }
    if (typeof value !== 'object') return null
    const record = value as Record<string, unknown>
    for (const key of ['model', 'modelName', 'name', 'label', 'displayName', 'id']) {
        const found = modelName(record[key], depth + 1)
        if (found) return found
    }
    return null
}

/**
 * Some sources serialize the model as a provider tuple. Show the model name,
 * and drop values that are only a provider identifier.
 */
export function readableModel(value: string | null | undefined): string | null {
    const raw = value?.trim()
    if (!raw) return null
    if (raw.startsWith('{') || raw.startsWith('[')) {
        try { return modelName(JSON.parse(raw), 0) } catch { return null }
    }
    const name = raw.replace(/^hapi-(?:observed|codex-native)[:/]/i, '').trim()
    return name && !INTERNAL_NAMES[name.toLowerCase()] ? name : null
}

/** Collapse whitespace and clip at a stable character budget. */
export function stableLabel(value: string | null | undefined, max = 48): string | null {
    const raw = value?.replace(/\s+/g, ' ').trim()
    if (!raw) return null
    return raw.length > max ? `${raw.slice(0, Math.max(1, max - 1)).trimEnd()}…` : raw
}

/** Composer admission copy. Only a genuine read-only projection locks input;
 * a disconnected Codex source stays sendable through the durable submit/resume
 * path and therefore gets a resume hint instead of a read-only claim. */
export interface ComposerAdmission { readonly key: WorkspaceKey; readonly resume: boolean }
export function composerAdmission(input: {
    nativeConnection?: string | null | undefined
    readOnly?: boolean | undefined
    readOnlyReason?: string | null | undefined
}): ComposerAdmission | null {
    if (input.nativeConnection !== undefined && input.nativeConnection !== 'attached') return { key: 'nativeResumeHint', resume: true }
    if (!input.readOnly) return null
    return { key: input.readOnlyReason === 'engine-owned' ? 'sourceLocallyControlled' : 'sourceReadOnly', resume: false }
}
