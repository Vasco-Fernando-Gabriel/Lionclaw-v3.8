import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type {
  LionClawAPI,
  StreamChunk,
  ConfirmAction,
  AskQuestionRequest,
  AskQuestionResponse,
  AuditEntry,
  SystemLogEntry,
  CompactionActivePayload,
  PipelineStreamChunk,
  PipelinePhaseChangedEvent,
  PipelineNotesUpdatedEvent,
  PipelineSprintCompleteEvent,
  PipelineProjectUpdatedEvent,
  PipelineSendResult,
  ChatAttachment,
  ChatSessionUpdatedEvent,
  IngestionProgress,
  IngestJob,
  PipelineConversationPhases,
  PipelinePhaseArtifact,
  SyncAgentsToOrchestratorRequest,
  DriveStateChangedEvent,
  CodexWindowsHealthWarning,
  CodexPatchFailureWarning,
  CodexWindowsPrepSkipped,
  PipelineAuditAgentsStateResponse,
} from '../../src/types';
import type { PipelineAuditAgentProgressEvent, RepoManifest } from '../../src/types/pipeline';
import type { RepoGraphStatusEvent } from '../../src/types/repo-graph';
import type { DynamicWorkflowStreamChunk } from '../../src/types/dynamic-workflow';
import type { KanbanChangedEvent } from '../../src/types/kanban';

const api: LionClawAPI = {
  app: {
    getVersion: () => ipcRenderer.invoke('app:get-version'),
  },
  swarm: {
    openFindings: (sessionId, runId, slug) => ipcRenderer.invoke('swarm:open-findings', sessionId, runId, slug),
    start: (sessionId, input) => ipcRenderer.invoke('swarm:start', sessionId, input),
    abort: (sessionId, runId) => ipcRenderer.invoke('swarm:abort', sessionId, runId),
    getRunState: (sessionId, runId) => ipcRenderer.invoke('swarm:get-run-state', sessionId, runId),
    listRuns: (sessionId, cursor, limit) => ipcRenderer.invoke('swarm:list-runs', sessionId, cursor, limit),
    getCatalog: (sessionId) => ipcRenderer.invoke('swarm:get-catalog', sessionId),
    getSettings: () => ipcRenderer.invoke('swarm:get-settings'),
    setSettings: (settings) => ipcRenderer.invoke('swarm:set-settings', settings),
    onStream: (callback) => {
      const handler = (
        _: Electron.IpcRendererEvent,
        event: { runId: string; chatSessionId: string; revision: number },
      ) => callback(event);
      ipcRenderer.on('swarm:stream', handler);
      return () => ipcRenderer.removeListener('swarm:stream', handler);
    },
  },
  chat: {
    send: (message, options) => ipcRenderer.invoke('chat:send', message, options),
    stop: (sessionId?: string) => ipcRenderer.invoke('chat:stop', sessionId),
    onStream: (cb: (chunk: StreamChunk) => void) => {
      const handler = (_: Electron.IpcRendererEvent, chunk: StreamChunk) => cb(chunk);
      ipcRenderer.on('chat:stream', handler);
      return () => {
        ipcRenderer.removeListener('chat:stream', handler);
      };
    },
    onConfirmRequest: (cb: (action: ConfirmAction) => void) => {
      const handler = (_: Electron.IpcRendererEvent, action: ConfirmAction) => cb(action);
      ipcRenderer.on('chat:confirm-request', handler);
      return () => {
        ipcRenderer.removeListener('chat:confirm-request', handler);
      };
    },
    confirmResponse: (id, approved) => ipcRenderer.invoke('chat:confirm-response', id, approved),
    onAskQuestion: (cb: (request: AskQuestionRequest) => void) => {
      const handler = (_: Electron.IpcRendererEvent, request: AskQuestionRequest) => cb(request);
      ipcRenderer.on('chat:ask-question', handler);
      return () => {
        ipcRenderer.removeListener('chat:ask-question', handler);
      };
    },
    askResponse: (response: AskQuestionResponse) => ipcRenderer.invoke('chat:ask-response', response),
    getSessions: () => ipcRenderer.invoke('chat:get-sessions'),
    getMessages: (sessionId) => ipcRenderer.invoke('chat:get-messages', sessionId),
    deleteSession: (sessionId) => ipcRenderer.invoke('chat:delete-session', sessionId),
    archiveSession: (sessionId) => ipcRenderer.invoke('chat:archive-session', sessionId),
    getContextUsage: (sessionId: string) => ipcRenderer.invoke('chat:get-context-usage', sessionId),
    getFeatureToggles: (sessionId) => ipcRenderer.invoke('chat:get-feature-toggles', sessionId),
    setFeatureToggles: (sessionId, patch) => ipcRenderer.invoke('chat:set-feature-toggles', sessionId, patch),
    ensureSession: (preferredSessionId) => ipcRenderer.invoke('chat:ensure-session', { preferredSessionId }),
    createSession: () => ipcRenderer.invoke('chat:create-session'),
    listOpenSessions: () => ipcRenderer.invoke('chat:list-open-sessions'),
    setSessionOrchestrator: (sessionId, selection) =>
      ipcRenderer.invoke('chat:set-session-orchestrator', sessionId, selection),
    onSessionUpdated: (cb: (event: ChatSessionUpdatedEvent) => void) => {
      const handler = (_: Electron.IpcRendererEvent, event: ChatSessionUpdatedEvent) => cb(event);
      ipcRenderer.on('chat:session-updated', handler);
      return () => {
        ipcRenderer.removeListener('chat:session-updated', handler);
      };
    },
    clear: (sessionId: string, opts?: { force?: boolean }) => ipcRenderer.invoke('chat:clear', sessionId, opts),
    clearCancel: (sessionId: string) => ipcRenderer.invoke('chat:clear-cancel', sessionId),
    compactSession: (sessionId?: string) => ipcRenderer.invoke('chat:compact-session', sessionId),
    clearSession: (sessionId?: string) => ipcRenderer.invoke('chat:clear-session', sessionId),
    onSessionsUpdated: (cb: () => void) => {
      const handler = () => cb();
      ipcRenderer.on('chat:sessions-updated', handler);
      return () => {
        ipcRenderer.removeListener('chat:sessions-updated', handler);
      };
    },
    onCompactionActive: (cb: (payload: CompactionActivePayload) => void) => {
      const handler = (_: Electron.IpcRendererEvent, payload: CompactionActivePayload) => cb(payload);
      ipcRenderer.on('compaction:active', handler);
      return () => {
        ipcRenderer.removeListener('compaction:active', handler);
      };
    },
  },
  activity: {
    getBlocks: (sessionId) => ipcRenderer.invoke('activity:get-blocks', sessionId),
  },
  agents: {
    list: () => ipcRenderer.invoke('agents:list'),
    get: (id) => ipcRenderer.invoke('agents:get', id),
    create: (agent) => ipcRenderer.invoke('agents:create', agent),
    update: (id, agent) => ipcRenderer.invoke('agents:update', id, agent),
    delete: (id) => ipcRenderer.invoke('agents:delete', id),
    syncToOrchestrator: (req?: SyncAgentsToOrchestratorRequest) =>
      ipcRenderer.invoke('agents:sync-to-orchestrator', req ?? {}),
  },
  skills: {
    list: () => ipcRenderer.invoke('skills:list'),
    get: (name) => ipcRenderer.invoke('skills:get', name),
    create: (skill) => ipcRenderer.invoke('skills:create', skill),
    update: (name, skill) => ipcRenderer.invoke('skills:update', name, skill),
    updateRaw: (name, content) => ipcRenderer.invoke('skills:update-raw', name, content),
    delete: (name) => ipcRenderer.invoke('skills:delete', name),
  },
  mcp: {
    list: () => ipcRenderer.invoke('mcp:list'),
    create: (config) => ipcRenderer.invoke('mcp:create', config),
    update: (id, config) => ipcRenderer.invoke('mcp:update', id, config),
    delete: (id) => ipcRenderer.invoke('mcp:delete', id),
    test: (id) => ipcRenderer.invoke('mcp:test', id),
    restart: (id) => ipcRenderer.invoke('mcp:restart', id),
    toggle: (id: string, active: boolean) => ipcRenderer.invoke('mcp:toggle', id, active),
    listSDK: () => ipcRenderer.invoke('mcp:list-sdk'),
    refreshSDK: () => ipcRenderer.invoke('mcp:refresh-sdk'),
    toggleSDK: (name: string, enabled: boolean) => ipcRenderer.invoke('mcp:toggle-sdk', name, enabled),
    onStatusChanged: (
      cb: (payload: { id: string; status: 'running' | 'stopped' | 'error'; error?: string }) => void,
    ) => {
      const handler = (_e: unknown, payload: { id: string; status: 'running' | 'stopped' | 'error'; error?: string }) =>
        cb(payload);
      ipcRenderer.on('mcp:status-changed', handler);
      return () => {
        ipcRenderer.removeListener('mcp:status-changed', handler);
      };
    },
    getDistStale: () => ipcRenderer.invoke('mcp:get-dist-stale'),
    onDistStale: (cb: (payload: { servers: string[]; command: string }) => void) => {
      const handler = (_e: unknown, payload: { servers: string[]; command: string }) => cb(payload);
      ipcRenderer.on('mcp:dist-stale', handler);
      return () => {
        ipcRenderer.removeListener('mcp:dist-stale', handler);
      };
    },
  },
  scheduler: {
    list: () => ipcRenderer.invoke('scheduler:list'),
    create: (task) => ipcRenderer.invoke('scheduler:create', task),
    update: (id, task) => ipcRenderer.invoke('scheduler:update', id, task),
    delete: (id) => ipcRenderer.invoke('scheduler:delete', id),
    pause: (id) => ipcRenderer.invoke('scheduler:pause', id),
    resume: (id) => ipcRenderer.invoke('scheduler:resume', id),
    getRuns: (taskId) => ipcRenderer.invoke('scheduler:get-runs', taskId),
    reviewRun: (runId: number, status: 'validated' | 'rejected', note?: string) =>
      ipcRenderer.invoke('scheduler:review-run', runId, status, note),
    getPendingReviewCount: () => ipcRenderer.invoke('scheduler:pending-count'),
    getSessions: () => ipcRenderer.invoke('scheduler:get-sessions'),
    deleteSession: (sessionId: string) => ipcRenderer.invoke('scheduler:delete-session', sessionId),
    cleanupSessions: () => ipcRenderer.invoke('scheduler:cleanup-sessions'),
    getActivities: (filters: { from: string; to: string; subagent?: string; status?: string; tags?: string[] }) =>
      ipcRenderer.invoke('scheduler:get-activities', filters),
    getActivityStats: (from: string, to: string) => ipcRenderer.invoke('scheduler:get-activity-stats', from, to),
    getAllTags: () => ipcRenderer.invoke('scheduler:get-all-tags'),
  },
  tasks: {
    list: (filters?: { status?: string; category?: string; priority?: string; period?: 'last30' | 'last90' | 'all' }) =>
      ipcRenderer.invoke('tasks:list', filters),
    get: (id: string) => ipcRenderer.invoke('tasks:get', id),
    create: (task: { title: string; description?: string; category?: string; priority?: string; dueDate?: string }) =>
      ipcRenderer.invoke('tasks:create', {
        title: task.title,
        description: task.description,
        category: task.category,
        priority: task.priority,
        due_date: task.dueDate,
      }),
    update: (id: string, updates: Record<string, unknown>) => {
      const mapped: Record<string, unknown> = {};
      if (updates.title !== undefined) mapped.title = updates.title;
      if (updates.description !== undefined) mapped.description = updates.description;
      if (updates.category !== undefined) mapped.category = updates.category;
      if (updates.status !== undefined) mapped.status = updates.status;
      if (updates.priority !== undefined) mapped.priority = updates.priority;
      if (updates.dueDate !== undefined) mapped.due_date = updates.dueDate;
      if (updates.doneComment !== undefined) mapped.done_comment = updates.doneComment;
      return ipcRenderer.invoke('tasks:update', id, mapped);
    },
    delete: (id: string) => ipcRenderer.invoke('tasks:delete', id),
    getCategories: () => ipcRenderer.invoke('tasks:categories'),
    getPendingDueCount: () => ipcRenderer.invoke('tasks:pending-due-count'),
  },
  memory: {
    getWorkingMemory: () => ipcRenderer.invoke('memory:get-working'),
    updateWorkingMemory: (content) => ipcRenderer.invoke('memory:update-working', content),
    searchSemantic: (query, limit) => ipcRenderer.invoke('memory:search-semantic', query, limit),
    getDailySummaries: (from, to) => ipcRenderer.invoke('memory:get-summaries', from, to),
    triggerCompaction: (sessionId?: string) => ipcRenderer.invoke('memory:trigger-compaction', sessionId),
  },
  logs: {
    query: (filters) => ipcRenderer.invoke('logs:query', filters),
    stream: (cb: (entry: AuditEntry) => void) => {
      const handler = (_: Electron.IpcRendererEvent, entry: AuditEntry) => cb(entry);
      ipcRenderer.on('logs:entry', handler);
      return () => {
        ipcRenderer.removeListener('logs:entry', handler);
      };
    },
    exportCSV: (filters) => ipcRenderer.invoke('logs:export-csv', filters),
    exportJSON: (filters) => ipcRenderer.invoke('logs:export-json', filters),
    querySystem: (filters) => ipcRenderer.invoke('logs:query-system', filters),
    streamSystem: (cb: (entry: SystemLogEntry) => void) => {
      const handler = (_: Electron.IpcRendererEvent, entry: SystemLogEntry) => cb(entry);
      ipcRenderer.on('logs:system-entry', handler);
      return () => {
        ipcRenderer.removeListener('logs:system-entry', handler);
      };
    },
  },
  usage: {
    providerLimits: () => ipcRenderer.invoke('usage:provider-limits'),
  },
  tools: {
    getSettings: () => ipcRenderer.invoke('tools:get-settings'),
    setEnabled: (tool: string, enabled: boolean) => ipcRenderer.invoke('tools:set-enabled', tool, enabled),
    getEnabled: () => ipcRenderer.invoke('tools:get-enabled'),
    getBypass: () => ipcRenderer.invoke('tools:get-bypass'),
    setBypass: (enabled: boolean) => ipcRenderer.invoke('tools:set-bypass', enabled),
    getTelegramArmed: () => ipcRenderer.invoke('tools:get-telegram-armed'),
    setTelegramArmed: (enabled: boolean) => ipcRenderer.invoke('tools:set-telegram-armed', enabled),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    update: (settings) => ipcRenderer.invoke('settings:update', settings),
    setApiKey: (key: string) => ipcRenderer.invoke('settings:set-api-key', key),
  },
  auth: {
    login: (password, totpCode) => ipcRenderer.invoke('auth:login', password, totpCode),
    logout: () => ipcRenderer.invoke('auth:logout'),
    isAuthenticated: () => ipcRenderer.invoke('auth:is-authenticated'),
    isFirstRun: () => ipcRenderer.invoke('auth:is-first-run'),
    setupPassword: (password) => ipcRenderer.invoke('auth:setup-password', password),
    enableTOTP: () => ipcRenderer.invoke('auth:enable-totp'),
    verifyTOTP: (code) => ipcRenderer.invoke('auth:verify-totp', code),
    onLocked: (cb: () => void) => {
      const handler = () => cb();
      ipcRenderer.on('auth:locked', handler);
      return () => {
        ipcRenderer.removeListener('auth:locked', handler);
      };
    },
  },
  codeburn: {
    spawn: (cols, rows) => ipcRenderer.invoke('codeburn:spawn', { cols, rows }),
    write: (data) => ipcRenderer.invoke('codeburn:write', data),
    resize: (cols, rows) => ipcRenderer.invoke('codeburn:resize', { cols, rows }),
    kill: () => ipcRenderer.invoke('codeburn:kill'),
    onData: (cb: (chunk: string) => void) => {
      const handler = (_: Electron.IpcRendererEvent, chunk: string) => cb(chunk);
      ipcRenderer.on('codeburn:data', handler);
      return () => {
        ipcRenderer.removeListener('codeburn:data', handler);
      };
    },
    onExit: (cb: (info: { exitCode: number; signal: number | null }) => void) => {
      const handler = (_: Electron.IpcRendererEvent, info: { exitCode: number; signal: number | null }) => cb(info);
      ipcRenderer.on('codeburn:exit', handler);
      return () => {
        ipcRenderer.removeListener('codeburn:exit', handler);
      };
    },
  },
  soul: {
    get: () => ipcRenderer.invoke('soul:get'),
    update: (content) => ipcRenderer.invoke('soul:update', content),
  },
  user: {
    get: () => ipcRenderer.invoke('user:get'),
    update: (content) => ipcRenderer.invoke('user:update', content),
  },
  rules: {
    getGlobal: () => ipcRenderer.invoke('rules:get-global'),
    updateGlobal: (content) => ipcRenderer.invoke('rules:update-global', content),
    getAgent: (agentId) => ipcRenderer.invoke('rules:get-agent', agentId),
    updateAgent: (agentId, content) => ipcRenderer.invoke('rules:update-agent', agentId, content),
  },
  onboarding: {
    isCompleted: () => ipcRenderer.invoke('onboarding:is-completed'),
    markCompleted: () => ipcRenderer.invoke('onboarding:mark-completed'),
    reset: () => ipcRenderer.invoke('onboarding:reset'),
  },
  vault: {
    list: () => ipcRenderer.invoke('vault:list'),
    set: (key: string, value: string) => ipcRenderer.invoke('vault:set', key, value),
    delete: (key: string) => ipcRenderer.invoke('vault:delete', key),
    check: (key: string) => ipcRenderer.invoke('vault:check', key),
    health: () => ipcRenderer.invoke('vault:health'),
    registerAndSet: (
      entry: {
        key: string;
        label: string;
        description: string;
        service: string;
        required: boolean;
        placeholder?: string;
        docsUrl?: string;
      },
      value: string,
    ) => ipcRenderer.invoke('vault:register-and-set', entry, value),
  },
  higgsfield: {
    authStatus: () => ipcRenderer.invoke('higgsfield:auth-status'),
    connect: (options?: { force?: boolean }) => ipcRenderer.invoke('higgsfield:connect', options),
    disconnect: () => ipcRenderer.invoke('higgsfield:disconnect'),
  },
  provider: {
    testConnection: (providerName: string, baseUrl: string, apiKeyRef: string) =>
      ipcRenderer.invoke('provider:test-connection', providerName, baseUrl, apiKeyRef),
    testOpenAiCompatible: (payload: { baseUrl: string; apiKey: string; preset?: string }) =>
      ipcRenderer.invoke('provider:test-openai-compatible', payload),
    listStatuses: (opts?: { refresh?: boolean }) => ipcRenderer.invoke('provider:list-statuses', opts),
    check: (payload: { runtime: string; provider: string }) => ipcRenderer.invoke('provider:check', payload),
    connect: (payload: { provider: string; apiKey?: string; baseUrl?: string; preset?: string }) =>
      ipcRenderer.invoke('provider:connect', payload),
    disconnect: (payload: { provider: string }) => ipcRenderer.invoke('provider:disconnect', payload),
    testVertexAi: (payload: { apiKey?: string; model?: string }) =>
      ipcRenderer.invoke('provider:test-vertex-ai', payload),
  },
  image: {
    generate: (prompt: string, options?: { aspectRatio?: string }) =>
      ipcRenderer.invoke('image:generate', prompt, options),
    edit: (prompt: string, imageBase64: string, imageMimeType: string, options?: { aspectRatio?: string }) =>
      ipcRenderer.invoke('image:edit', prompt, imageBase64, imageMimeType, options),
  },
  voice: {
    transcribe: (audioBase64: string) => ipcRenderer.invoke('voice:transcribe', audioBase64),
    speak: (text: string, voiceId?: string) => ipcRenderer.invoke('voice:speak', text, voiceId),
    speakLive: (text: string) => ipcRenderer.invoke('voice:speak-live', text),
    speakCartesia: (text: string, voiceId?: string, language?: string) =>
      ipcRenderer.invoke('voice:speak-cartesia', text, voiceId, language),
    readAudioFile: (path: string) => ipcRenderer.invoke('voice:read-audio-file', path),
    listVoices: () => ipcRenderer.invoke('voice:list-voices'),
    listCartesiaVoices: (options?: { q?: string; language?: string; limit?: number }) =>
      ipcRenderer.invoke('voice:list-cartesia-voices', options),
  },
  channels: {
    list: () => ipcRenderer.invoke('channels:list'),
    get: (type: string) => ipcRenderer.invoke('channels:get', type),
    saveTelegram: (config: {
      botToken: string;
      allowedUserId: number;
      allowedUserName: string;
      notifyOnSchedulerTasks: boolean;
      notifyOnDriveHandoff: boolean;
    }) => ipcRenderer.invoke('channels:save-telegram', config),
    toggle: (type: string, active: boolean) => ipcRenderer.invoke('channels:toggle', type, active),
    testTelegram: () => ipcRenderer.invoke('channels:test-telegram'),
    telegramStatus: () => ipcRenderer.invoke('channels:telegram-status'),
  },
  google: {
    setup: (config: { clientId: string; clientSecret: string }) => ipcRenderer.invoke('google:setup', config),
    authenticate: () => ipcRenderer.invoke('google:authenticate'),
    status: () => ipcRenderer.invoke('google:status'),
    revoke: () => ipcRenderer.invoke('google:revoke'),
  },
  ollama: {
    check: (baseUrl: string, model: string, provider?: string) =>
      ipcRenderer.invoke('ollama:check', baseUrl, model, provider),
    listModels: (provider: string, baseUrl: string) => ipcRenderer.invoke('ollama:list-models', provider, baseUrl),
  },
  knowledge: {
    upload: (payload: {
      agentId: string;
      filePath: string;
      config: { strategy: string; chunkSize: number; chunkOverlap: number; title?: string };
    }) => ipcRenderer.invoke('knowledge:upload', payload),
    reprocess: (payload: { sourceId: string; strategy: string; chunkSize: number; chunkOverlap: number }) =>
      ipcRenderer.invoke('knowledge:reprocess', payload),
    delete: (payload: { sourceId: string }) => ipcRenderer.invoke('knowledge:delete', payload),
    list: (payload: { agentId: string }) => ipcRenderer.invoke('knowledge:list', payload),
    search: (payload: { agentId: string; query: string }) => ipcRenderer.invoke('knowledge:search', payload),
    benchmark: {
      start: (payload: {
        sourceIds: string[];
        agentId: string;
        config: { totalQuestions: number; modelJudge: 'sonnet' | 'opus'; threshold: number };
      }) => ipcRenderer.invoke('knowledge:benchmark:start', payload),
      status: (payload: { benchmarkId: string }) => ipcRenderer.invoke('knowledge:benchmark:status', payload),
    },
    config: {
      get: (payload: { agentId: string }) => ipcRenderer.invoke('knowledge:config:get', payload),
      update: (payload: { agentId: string; config: Record<string, unknown> }) =>
        ipcRenderer.invoke('knowledge:config:update', payload),
    },
    onIngestionProgress: (cb: (data: IngestionProgress) => void) => {
      const handler = (_: Electron.IpcRendererEvent, data: IngestionProgress) => cb(data);
      ipcRenderer.on('knowledge:ingestion:progress', handler);
      return () => {
        ipcRenderer.removeListener('knowledge:ingestion:progress', handler);
      };
    },
    onBenchmarkProgress: (
      cb: (data: { benchmarkId: string; stage: string; current: number; total: number }) => void,
    ) => {
      const handler = (
        _: Electron.IpcRendererEvent,
        data: { benchmarkId: string; stage: string; current: number; total: number },
      ) => cb(data);
      ipcRenderer.on('knowledge:benchmark:progress', handler);
      return () => {
        ipcRenderer.removeListener('knowledge:benchmark:progress', handler);
      };
    },
  },
  harness: {
    createProject: (data: {
      name: string;
      description?: string;
      projectPath: string;
      specText?: string;
      specFilePath?: string;
      config: {
        maxRoundsPerSprint: number;
        usePlaywright: boolean;
        evaluatorAgentId: string;
        plannerAgentId: string;
        stack: string[];
        plannerOutputFormat?: 'json' | 'markdown';
      };
    }) => ipcRenderer.invoke('harness:create-project', data),
    plan: (projectId: string) => ipcRenderer.invoke('harness:plan', projectId),
    approveSprints: (projectId: string) => ipcRenderer.invoke('harness:approve-sprints', projectId),
    regenerateSprints: (projectId: string, feedback: string) =>
      ipcRenderer.invoke('harness:regenerate-sprints', projectId, feedback),
    run: (projectId: string) => ipcRenderer.invoke('harness:run', projectId),
    pause: (projectId: string) => ipcRenderer.invoke('harness:pause', projectId),
    resume: (projectId: string) =>
      ipcRenderer.invoke('harness:resume', projectId) as Promise<
        { ok: true } | { ok: false; message: string } | { error: string }
      >,
    resumeAfterAuth: (projectId: string, provider: 'grok' | 'codex' | 'kimi') =>
      ipcRenderer.invoke('harness:resume', projectId, provider),
    abort: (projectId: string) => ipcRenderer.invoke('harness:abort', projectId),
    deleteProject: (projectId: string) => ipcRenderer.invoke('harness:delete-project', projectId),
    getProject: (projectId: string) => ipcRenderer.invoke('harness:get-project', projectId),
    listProjects: () => ipcRenderer.invoke('harness:list-projects'),
    getSprints: (projectId: string) => ipcRenderer.invoke('harness:get-sprints', projectId),
    getSprintJson: (projectId: string, sprintJsonId: string) =>
      ipcRenderer.invoke('harness:get-sprint-json', projectId, sprintJsonId),
    getSprintsJson: (projectId: string) => ipcRenderer.invoke('harness:get-sprints-json', projectId),
    getRounds: (sprintId: string) => ipcRenderer.invoke('harness:get-rounds', sprintId),
    getEvaluation: (projectId: string, sprintId: string) =>
      ipcRenderer.invoke('harness:get-evaluation', projectId, sprintId),
    getMetrics: (projectId: string) => ipcRenderer.invoke('harness:get-metrics', projectId),
    getStreamLog: (projectId: string, sprintId: string) =>
      ipcRenderer.invoke('harness:get-stream-log', projectId, sprintId),
    getFeedbackAudit: (projectId: string, sprintId: string) =>
      ipcRenderer.invoke('harness:get-feedback-audit', projectId, sprintId),
    onProjectUpdate: (cb: (data: Record<string, unknown>) => void) => {
      const handler = (_: Electron.IpcRendererEvent, data: Record<string, unknown>) => cb(data);
      ipcRenderer.on('harness:project-update', handler);
      return () => {
        ipcRenderer.removeListener('harness:project-update', handler);
      };
    },
    onSprintUpdate: (cb: (data: Record<string, unknown>) => void) => {
      const handler = (_: Electron.IpcRendererEvent, data: Record<string, unknown>) => cb(data);
      ipcRenderer.on('harness:sprint-update', handler);
      return () => {
        ipcRenderer.removeListener('harness:sprint-update', handler);
      };
    },
    onAgentStream: (cb: (data: Record<string, unknown>) => void) => {
      const handler = (_: Electron.IpcRendererEvent, data: Record<string, unknown>) => cb(data);
      ipcRenderer.on('harness:agent-stream', handler);
      return () => {
        ipcRenderer.removeListener('harness:agent-stream', handler);
      };
    },
    onMetricsUpdate: (cb: (data: Record<string, unknown>) => void) => {
      const handler = (_: Electron.IpcRendererEvent, data: Record<string, unknown>) => cb(data);
      ipcRenderer.on('harness:metrics-update', handler);
      return () => {
        ipcRenderer.removeListener('harness:metrics-update', handler);
      };
    },
    onPlanningDone: (cb: (data: Record<string, unknown>) => void) => {
      const handler = (_: Electron.IpcRendererEvent, data: Record<string, unknown>) => cb(data);
      ipcRenderer.on('harness:planning-done', handler);
      return () => {
        ipcRenderer.removeListener('harness:planning-done', handler);
      };
    },
    onError: (cb: (data: Record<string, unknown>) => void) => {
      const handler = (_: Electron.IpcRendererEvent, data: Record<string, unknown>) => cb(data);
      ipcRenderer.on('harness:error', handler);
      return () => {
        ipcRenderer.removeListener('harness:error', handler);
      };
    },
  },
  mgraph: {
    graph: () => ipcRenderer.invoke('mgraph:graph'),
    read: (path: string) => ipcRenderer.invoke('mgraph:read', path),
    search: (query: string) => ipcRenderer.invoke('mgraph:search', query),
    seed: (forceReseed?: boolean) => ipcRenderer.invoke('mgraph:seed', forceReseed),
    stats: () => ipcRenderer.invoke('mgraph:stats'),
    listNotes: (type: string) => ipcRenderer.invoke('mgraph:list-notes', type),
    deleteNote: (notePath: string, options?: { force?: boolean }) =>
      ipcRenderer.invoke('mgraph:delete-note', notePath, options),
    noteBacklinks: (notePath: string) => ipcRenderer.invoke('mgraph:note-backlinks', notePath),
    onSeedProgress: (cb: (data: { processed: number; total: number; notesCreated: number }) => void) => {
      const handler = (
        _: Electron.IpcRendererEvent,
        data: { processed: number; total: number; notesCreated: number },
      ) => cb(data);
      ipcRenderer.on('mgraph:seed-progress', handler);
      return () => {
        ipcRenderer.removeListener('mgraph:seed-progress', handler);
      };
    },
    onUpdated: (cb: () => void) => {
      const handler = () => cb();
      ipcRenderer.on('mgraph:updated', handler);
      return () => {
        ipcRenderer.removeListener('mgraph:updated', handler);
      };
    },
    ingestFile: (filePath: string, fileName: string) => ipcRenderer.invoke('mgraph:ingest-file', filePath, fileName),
    ingestUrl: (url: string) => ipcRenderer.invoke('mgraph:ingest-url', url),
    ingestText: (text: string, title?: string) => ipcRenderer.invoke('mgraph:ingest-text', text, title),
    ingestResume: (jobId: string) => ipcRenderer.invoke('mgraph:ingest-resume', jobId),
    ingestHistory: () => ipcRenderer.invoke('mgraph:ingest-history'),
    ingestCancel: (jobId: string) => ipcRenderer.invoke('mgraph:ingest-cancel', jobId),
    ingestEstimate: (filePath: string) => ipcRenderer.invoke('mgraph:ingest-estimate', filePath),
    ingestDiscard: (jobId: string) => ipcRenderer.invoke('mgraph:ingest-discard', jobId),
    ingestAccept: (jobId: string) => ipcRenderer.invoke('mgraph:ingest-accept', jobId),
    ingestSettings: () => ipcRenderer.invoke('mgraph:ingest-settings'),
    ingestSettingsUpdate: (settings: Record<string, string>) =>
      ipcRenderer.invoke('mgraph:ingest-settings-update', settings),
    onIngestProgress: (cb: (data: IngestJob) => void) => {
      const handler = (_: Electron.IpcRendererEvent, data: IngestJob) => cb(data);
      ipcRenderer.on('mgraph:ingest-progress', handler);
      return () => {
        ipcRenderer.removeListener('mgraph:ingest-progress', handler);
      };
    },
  },
  shell: {
    showInFolder: (filePath: string) => ipcRenderer.invoke('shell:show-in-folder', filePath),
    openPath: (dirPath: string) => ipcRenderer.invoke('shell:open-path', dirPath),
    openFile: (filePath: string) =>
      ipcRenderer.invoke('shell:open-file', filePath) as Promise<{ ok: true } | { error: string }>,
    selectDirectory: () => ipcRenderer.invoke('dialog:open-directory') as Promise<string | null>,
  },
  artifact: {
    getState: (storageKey: string) =>
      ipcRenderer.invoke('artifact:get-state', storageKey) as Promise<{ state: unknown } | { error: string }>,
    setState: (storageKey: string, state: unknown) =>
      ipcRenderer.invoke('artifact:set-state', storageKey, state) as Promise<{ ok: true } | { error: string }>,
  },
  utils: {
    getPathForFile: (file: File) => webUtils.getPathForFile(file),
  },
  enrich: {
    start: (config: {
      name: string;
      specPath: string;
      projectPath?: string;
      prdPath?: string;
      message?: string;
      validatorAgentId: string;
    }) => ipcRenderer.invoke('enrich:start', config),
    send: (sessionId: string, message: string) => ipcRenderer.invoke('enrich:send', { sessionId, message }),
    approvePhase: (sessionId: string) => ipcRenderer.invoke('enrich:approve-phase', { sessionId }),
    resumeAfterAuth: (sessionId: string, provider?: 'grok' | 'codex' | 'kimi') =>
      ipcRenderer.invoke('enrich:resume-after-auth', { sessionId, provider }),
    finalize: (sessionId: string) => ipcRenderer.invoke('enrich:finalize', { sessionId }),
    abort: (sessionId: string) => ipcRenderer.invoke('enrich:abort', { sessionId }),
    delete: (sessionId: string) => ipcRenderer.invoke('enrich:delete', { sessionId }),
    getSpec: (sessionId: string) => ipcRenderer.invoke('enrich:get-spec', { sessionId }),
    listSessions: () => ipcRenderer.invoke('enrich:list-sessions'),
    onStream: (cb: (chunk: unknown) => void) => {
      const handler = (_: Electron.IpcRendererEvent, chunk: unknown) => cb(chunk);
      ipcRenderer.on('enrich:stream', handler);
      return () => {
        ipcRenderer.removeListener('enrich:stream', handler);
      };
    },
    onMetrics: (cb: (data: unknown) => void) => {
      const handler = (_: Electron.IpcRendererEvent, data: unknown) => cb(data);
      ipcRenderer.on('enrich:metrics', handler);
      return () => {
        ipcRenderer.removeListener('enrich:metrics', handler);
      };
    },
    onStatus: (cb: (status: unknown) => void) => {
      const handler = (_: Electron.IpcRendererEvent, status: unknown) => cb(status);
      ipcRenderer.on('enrich:status', handler);
      return () => {
        ipcRenderer.removeListener('enrich:status', handler);
      };
    },
    getMessages: (sessionId: string, phase?: string) => ipcRenderer.invoke('enrich:get-messages', { sessionId, phase }),
    openSpec: (sessionId: string) => ipcRenderer.invoke('enrich:open-spec', { sessionId }),
  },
  pipeline: {
    start: (projectId: string, startPhase: number) => ipcRenderer.invoke('pipeline:start', projectId, startPhase),
    advance: (projectId: string) => ipcRenderer.invoke('pipeline:advance', projectId),
    abort: (projectId: string) => ipcRenderer.invoke('pipeline:abort', projectId),
    pause: (projectId: string) => ipcRenderer.invoke('pipeline:pause', projectId),
    resume: (projectId: string) => ipcRenderer.invoke('pipeline:resume', projectId),
    send: (projectId: string, message: string, attachments?: ChatAttachment[]): Promise<PipelineSendResult> =>
      ipcRenderer.invoke('pipeline:send', projectId, message, attachments),
    getConversationPhases: () =>
      ipcRenderer.invoke('pipeline:get-conversation-phases') as Promise<PipelineConversationPhases>,
    approve: (projectId: string, metadata?: Record<string, unknown>) =>
      ipcRenderer.invoke('pipeline:approve', projectId, metadata),
    getMetrics: (projectId: string) => ipcRenderer.invoke('pipeline:metrics', projectId),
    getReport: (projectId: string) => ipcRenderer.invoke('pipeline:report', projectId),
    exportReport: (projectId: string, format: 'md') => ipcRenderer.invoke('pipeline:export-report', projectId, format),
    openProjectFile: (projectId: string, relativePath: string) =>
      ipcRenderer.invoke('pipeline:open-project-file', { projectId, relativePath }) as Promise<
        { ok: true } | { error: string }
      >,
    openSmokeTest: (projectId: string) =>
      ipcRenderer.invoke('pipeline:open-smoke-test', projectId) as Promise<{ ok: true } | { error: string }>,
    getSmokeTestPath: (projectId: string) =>
      ipcRenderer.invoke('pipeline:get-smoke-test-path', projectId) as Promise<{ exists: boolean; path?: string }>,
    decided: (projectId: string, blockId: string) => ipcRenderer.invoke('pipeline:decided', projectId, blockId),
    conclude: (projectId: string) => ipcRenderer.invoke('pipeline:conclude', projectId),
    retry: (projectId: string) => ipcRenderer.invoke('pipeline:retry', projectId),
    confirmDevelopment: (projectId: string) => ipcRenderer.invoke('pipeline:confirm-development', projectId),
    createProject: (data: {
      name: string;
      description: string;
      projectPath: string;
      startPhase: number;
      specPath?: string;
      prdPath?: string;
      pipelineType?: string;
    }) => ipcRenderer.invoke('pipeline:create-project', data),
    getSecurityAgentStatus: (projectId: string) => ipcRenderer.invoke('pipeline:get-security-agent-status', projectId),
    getAuditAgentsState: (projectId: string) =>
      ipcRenderer.invoke('pipeline:get-audit-agents-state', projectId) as Promise<PipelineAuditAgentsStateResponse>,
    deleteProject: (projectId: string) => ipcRenderer.invoke('pipeline:delete-project', projectId),
    listProjects: () => ipcRenderer.invoke('pipeline:list-projects'),
    getProject: (projectId: string) => ipcRenderer.invoke('pipeline:get-project', projectId),
    getPhaseMessages: (projectId: string, phase: number) =>
      ipcRenderer.invoke('pipeline:get-phase-messages', projectId, phase),
    readPhaseDocument: (projectId: string, phase: number) =>
      ipcRenderer.invoke('pipeline:read-phase-document', projectId, phase),
    onStream: (cb: (chunk: PipelineStreamChunk) => void) => {
      const handler = (_: Electron.IpcRendererEvent, chunk: PipelineStreamChunk) => cb(chunk);
      ipcRenderer.on('pipeline:stream', handler);
      return () => {
        ipcRenderer.removeListener('pipeline:stream', handler);
      };
    },
    onPhaseChanged: (cb: (event: PipelinePhaseChangedEvent) => void) => {
      const handler = (_: Electron.IpcRendererEvent, event: PipelinePhaseChangedEvent) => cb(event);
      ipcRenderer.on('pipeline:phase-changed', handler);
      return () => {
        ipcRenderer.removeListener('pipeline:phase-changed', handler);
      };
    },
    onProjectUpdated: (cb: (event: PipelineProjectUpdatedEvent) => void) => {
      const handler = (_: Electron.IpcRendererEvent, event: PipelineProjectUpdatedEvent) => cb(event);
      ipcRenderer.on('pipeline:project-updated', handler);
      return () => {
        ipcRenderer.removeListener('pipeline:project-updated', handler);
      };
    },
    onNotesUpdated: (cb: (event: PipelineNotesUpdatedEvent) => void) => {
      const handler = (_: Electron.IpcRendererEvent, event: PipelineNotesUpdatedEvent) => cb(event);
      ipcRenderer.on('pipeline:notes-updated', handler);
      return () => {
        ipcRenderer.removeListener('pipeline:notes-updated', handler);
      };
    },
    onMessagesUpdated: (cb: (data: { projectId: string; phase: number }) => void) => {
      const handler = (_: Electron.IpcRendererEvent, data: { projectId: string; phase: number }) => cb(data);
      ipcRenderer.on('pipeline:messages-updated', handler);
      return () => {
        ipcRenderer.removeListener('pipeline:messages-updated', handler);
      };
    },
    onSprintComplete: (cb: (event: PipelineSprintCompleteEvent) => void) => {
      const handler = (_: Electron.IpcRendererEvent, event: PipelineSprintCompleteEvent) => cb(event);
      ipcRenderer.on('pipeline:sprint-complete', handler);
      return () => {
        ipcRenderer.removeListener('pipeline:sprint-complete', handler);
      };
    },
    onSprintUpdated: (cb: (data: { sprintIndex: number; status: string; round: number }) => void) => {
      const handler = (_: Electron.IpcRendererEvent, data: { sprintIndex: number; status: string; round: number }) =>
        cb(data);
      ipcRenderer.on('pipeline:sprint-updated', handler);
      return () => {
        ipcRenderer.removeListener('pipeline:sprint-updated', handler);
      };
    },
    onAgentCompleted: (cb: (data: { projectId: string }) => void) => {
      const handler = (_: Electron.IpcRendererEvent, data: { projectId: string }) => cb(data);
      ipcRenderer.on('pipeline:agent-completed', handler);
      return () => {
        ipcRenderer.removeListener('pipeline:agent-completed', handler);
      };
    },
    onDocumentUpdated: (cb: (data: { projectId: string; path: string; content: string }) => void) => {
      const handler = (_: Electron.IpcRendererEvent, data: { projectId: string; path: string; content: string }) =>
        cb(data);
      ipcRenderer.on('pipeline:document-updated', handler);
      return () => {
        ipcRenderer.removeListener('pipeline:document-updated', handler);
      };
    },
    onSprintsLoaded: (
      cb: (data: {
        projectId: string;
        sprints: Array<{
          index: number;
          name: string;
          status: string;
          coderAgentId?: string;
          evaluatorAgentId?: string;
          sprintJsonId?: string;
          sprintId?: string;
        }>;
      }) => void,
    ) => {
      const handler = (
        _: Electron.IpcRendererEvent,
        data: {
          projectId: string;
          sprints: Array<{
            index: number;
            name: string;
            status: string;
            coderAgentId?: string;
            evaluatorAgentId?: string;
            sprintJsonId?: string;
            sprintId?: string;
          }>;
        },
      ) => cb(data);
      ipcRenderer.on('pipeline:sprints-loaded', handler);
      return () => {
        ipcRenderer.removeListener('pipeline:sprints-loaded', handler);
      };
    },
    onSprintRound: (cb: (data: { projectId: string; sprintIndex: number; round: number; agent: string }) => void) => {
      const handler = (
        _: Electron.IpcRendererEvent,
        data: { projectId: string; sprintIndex: number; round: number; agent: string },
      ) => cb(data);
      ipcRenderer.on('pipeline:sprint-round', handler);
      return () => {
        ipcRenderer.removeListener('pipeline:sprint-round', handler);
      };
    },
    resetPhase: (projectId: string, phase: number) => ipcRenderer.invoke('pipeline:reset-phase', projectId, phase),
    resetSprint: (projectId: string, sprintIndex: number) =>
      ipcRenderer.invoke('pipeline:reset-sprint', projectId, sprintIndex),
    getResetPreview: (projectId: string, target: { phase?: number; sprintIndex?: number }) =>
      ipcRenderer.invoke('pipeline:get-reset-preview', projectId, target),
    readPhaseArtifact: (projectId: string, phase: number) =>
      ipcRenderer.invoke('pipeline:read-phase-artifact', projectId, phase) as Promise<PipelinePhaseArtifact>,
    getSprintHistory: (projectId: string, sprintIndex: number) =>
      ipcRenderer.invoke('pipeline:get-sprint-history', projectId, sprintIndex),
    listSprints: (projectId: string) => ipcRenderer.invoke('pipeline:list-sprints', projectId),
    getSprintDetail: (projectId: string, sprintIndex: number) =>
      ipcRenderer.invoke('pipeline:get-sprint-detail', projectId, sprintIndex),
    onResetComplete: (cb: (data: { projectId: string; phase?: number; sprintIndex?: number }) => void) => {
      const handler1 = (_: Electron.IpcRendererEvent, data: { projectId: string; phase: number }) =>
        cb({ projectId: data.projectId, phase: data.phase });
      const handler2 = (_: Electron.IpcRendererEvent, data: { projectId: string; sprintIndex: number }) =>
        cb({ projectId: data.projectId, sprintIndex: data.sprintIndex });
      ipcRenderer.on('pipeline:reset-complete', handler1);
      ipcRenderer.on('pipeline:sprint-reset', handler2);
      return () => {
        ipcRenderer.removeListener('pipeline:reset-complete', handler1);
        ipcRenderer.removeListener('pipeline:sprint-reset', handler2);
      };
    },
    onSecurityAgentStatus: (
      cb: (data: {
        projectId: string;
        agentId: string;
        agentName: string;
        status: 'pending' | 'running' | 'completed' | 'failed';
        findingsCount?: number;
        error?: string;
      }) => void,
    ) => {
      const handler = (
        _: Electron.IpcRendererEvent,
        data: {
          projectId: string;
          agentId: string;
          agentName: string;
          status: 'pending' | 'running' | 'completed' | 'failed';
          findingsCount?: number;
          error?: string;
        },
      ) => cb(data);
      ipcRenderer.on('pipeline:security-agent-status', handler);
      return () => {
        ipcRenderer.removeListener('pipeline:security-agent-status', handler);
      };
    },
    onAuditAgentProgress: (cb: (event: PipelineAuditAgentProgressEvent) => void) => {
      const handler = (_: Electron.IpcRendererEvent, event: PipelineAuditAgentProgressEvent) => cb(event);
      ipcRenderer.on('pipeline:audit-agent-progress', handler);
      return () => {
        ipcRenderer.removeListener('pipeline:audit-agent-progress', handler);
      };
    },
    readManifest: (projectId: string) => ipcRenderer.invoke('pipeline:read-manifest', projectId),
    onManifest: (cb: (data: { projectId: string; manifest: RepoManifest }) => void) => {
      const handler = (_: Electron.IpcRendererEvent, data: { projectId: string; manifest: RepoManifest }) => cb(data);
      ipcRenderer.on('pipeline:manifest', handler);
      return () => {
        ipcRenderer.removeListener('pipeline:manifest', handler);
      };
    },
    onResolutionTrackerComplete: (cb: (data: { projectId: string }) => void) => {
      const handler = (_: Electron.IpcRendererEvent, data: { projectId: string }) => cb(data);
      ipcRenderer.on('pipeline:resolution-tracker-complete', handler);
      return () => {
        ipcRenderer.removeListener('pipeline:resolution-tracker-complete', handler);
      };
    },
    onStalled: (
      cb: (data: {
        projectId: string;
        phase: number;
        agentId: string;
        lastChunkAt: number;
        secondsSinceLastChunk: number;
      }) => void,
    ) => {
      const handler = (
        _: Electron.IpcRendererEvent,
        data: { projectId: string; phase: number; agentId: string; lastChunkAt: number; secondsSinceLastChunk: number },
      ) => cb(data);
      ipcRenderer.on('pipeline:stalled', handler);
      return () => {
        ipcRenderer.removeListener('pipeline:stalled', handler);
      };
    },
    onAuthRequired: (
      cb: (data: {
        projectId: string;
        phaseNumber: number;
        agentId: string;
        message: string;
        provider: 'codex' | 'grok' | 'kimi';
        runtime: 'codex' | 'grok' | 'kimi';
        ownerKind?: 'pipeline' | 'harness' | 'enrich';
        roundId?: string;
      }) => void,
    ) => {
      const handler = (
        _: Electron.IpcRendererEvent,
        data: {
          projectId: string;
          phaseNumber: number;
          agentId: string;
          message: string;
          provider: 'codex' | 'grok' | 'kimi';
          runtime: 'codex' | 'grok' | 'kimi';
          ownerKind?: 'pipeline' | 'harness' | 'enrich';
          roundId?: string;
        },
      ) => cb(data);
      ipcRenderer.on('pipeline:auth-required', handler);
      return () => {
        ipcRenderer.removeListener('pipeline:auth-required', handler);
      };
    },
    resumeAfterAuth: (projectId: string, provider?: 'codex' | 'grok' | 'kimi') =>
      ipcRenderer.invoke('pipeline:resume-after-auth', projectId, provider) as Promise<
        { ok: true } | { ok: false; message: string }
      >,
  },
  dialog: {
    openFile: (filters?: Array<{ name: string; extensions: string[] }>) =>
      ipcRenderer.invoke('dialog:open-file', { filters }) as Promise<string | null>,
    openDirectory: () => ipcRenderer.invoke('dialog:open-directory') as Promise<string | null>,
  },
  codex: {
    status: () => ipcRenderer.invoke('codex:status'),
    test: () => ipcRenderer.invoke('codex:test'),
    openLogin: () => ipcRenderer.invoke('codex:open-login'),
    setBinaryPath: (path: string) => ipcRenderer.invoke('codex:set-binary-path', path),
    listModelCapabilities: () => ipcRenderer.invoke('codex:list-model-capabilities'),
    checkPrepNeeded: (projectPath: string) => ipcRenderer.invoke('codex:check-prep-needed', projectPath),
    applyPrep: (repoRoot: string) => ipcRenderer.invoke('codex:apply-prep', repoRoot),
    grantSkipConsent: (repoRoot: string) => ipcRenderer.invoke('codex:grant-consent', { repoRoot, action: 'skip' }),
    onWindowsHealthWarning: (handler: (payload: CodexWindowsHealthWarning) => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, payload: CodexWindowsHealthWarning): void => handler(payload);
      ipcRenderer.on('codex:windows-health-warning', wrapped);
      return () => ipcRenderer.removeListener('codex:windows-health-warning', wrapped);
    },
    onPatchFailureWarning: (handler: (payload: CodexPatchFailureWarning) => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, payload: CodexPatchFailureWarning): void => handler(payload);
      ipcRenderer.on('codex:patch-failure-warning', wrapped);
      return () => ipcRenderer.removeListener('codex:patch-failure-warning', wrapped);
    },
    onWindowsPrepSkipped: (handler: (payload: CodexWindowsPrepSkipped) => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, payload: CodexWindowsPrepSkipped): void => handler(payload);
      ipcRenderer.on('codex:windows-prep-skipped', wrapped);
      return () => ipcRenderer.removeListener('codex:windows-prep-skipped', wrapped);
    },
  },
  kimi: {
    status: () => ipcRenderer.invoke('kimi:status'),
    test: () => ipcRenderer.invoke('kimi:test'),
    openLogin: () => ipcRenderer.invoke('kimi:open-login'),
    setBinaryPath: (path: string) => ipcRenderer.invoke('kimi:set-binary-path', path),
  },
  grok: {
    status: () => ipcRenderer.invoke('grok:status'),
    test: () => ipcRenderer.invoke('grok:test'),
    openLogin: () => ipcRenderer.invoke('grok:open-login'),
    logout: () => ipcRenderer.invoke('grok:logout'),
    setBinaryPath: (path: string) => ipcRenderer.invoke('grok:set-binary-path', path),
  },
  terminal: {
    open: (sessionId: string, cols: number, rows: number) =>
      ipcRenderer.invoke('terminal:open', { sessionId, cols, rows }),
    write: (sessionId: string, data: string) => ipcRenderer.invoke('terminal:write', { sessionId, data }),
    resize: (sessionId: string, cols: number, rows: number) =>
      ipcRenderer.invoke('terminal:resize', { sessionId, cols, rows }),
    close: (sessionId: string) => ipcRenderer.invoke('terminal:close', { sessionId }),
    onData: (cb: (payload: { sessionId: string; chunk: string }) => void) => {
      const handler = (_: Electron.IpcRendererEvent, payload: { sessionId: string; chunk: string }) => cb(payload);
      ipcRenderer.on('terminal:data', handler);
      return () => {
        ipcRenderer.removeListener('terminal:data', handler);
      };
    },
    onExit: (cb: (payload: { sessionId: string; exitCode: number }) => void) => {
      const handler = (_: Electron.IpcRendererEvent, payload: { sessionId: string; exitCode: number }) => cb(payload);
      ipcRenderer.on('terminal:exit', handler);
      return () => {
        ipcRenderer.removeListener('terminal:exit', handler);
      };
    },
  },
  claudeCli: {
    status: () => ipcRenderer.invoke('claude-cli:status'),
    test: () => ipcRenderer.invoke('claude-cli:test'),
    openLogin: () => ipcRenderer.invoke('claude-cli:open-login'),
    setBinaryPath: (path: string) => ipcRenderer.invoke('claude-cli:set-binary-path', path),
  },
  openDesign: {
    preflight: (projectId: string) => ipcRenderer.invoke('open-design:preflight', projectId),
    setup: (projectId: string, config: Record<string, unknown>) =>
      ipcRenderer.invoke('open-design:setup', projectId, config),
    start: (projectId: string) => ipcRenderer.invoke('open-design:start', projectId),
    stop: (projectId: string) => ipcRenderer.invoke('open-design:stop', projectId),
    restart: (projectId: string) => ipcRenderer.invoke('open-design:restart', projectId),
    status: (projectId: string) => ipcRenderer.invoke('open-design:status', projectId),
    buildInitialPrompt: (projectId: string) => ipcRenderer.invoke('open-design:build-initial-prompt', projectId),
    injectInitialPrompt: (projectId: string) => ipcRenderer.invoke('open-design:inject-initial-prompt', projectId),
    snapshot: (projectId: string) => ipcRenderer.invoke('open-design:snapshot', projectId),
    getLockedSnapshot: (projectId: string) => ipcRenderer.invoke('open-design:get-locked-snapshot', projectId),
    readLockedHtml: (projectId: string) => ipcRenderer.invoke('open-design:read-locked-html', projectId),
    destructiveUnlock: (projectId: string, confirmation: string) =>
      ipcRenderer.invoke('open-design:destructive-unlock', projectId, confirmation),
    openArtifact: (projectId: string) => ipcRenderer.invoke('open-design:open-artifact', projectId),
    setViewBounds: (bounds: { x: number; y: number; width: number; height: number }) =>
      ipcRenderer.invoke('open-design:set-view-bounds', bounds),
    showView: (url: string, bounds: { x: number; y: number; width: number; height: number }) =>
      ipcRenderer.invoke('open-design:show-view', url, bounds),
    hideView: () => ipcRenderer.invoke('open-design:hide-view'),
    bootInstallStatus: () => ipcRenderer.invoke('open-design:boot-install-status'),
    bootInstallRetry: () => ipcRenderer.invoke('open-design:boot-install-retry'),
    getSessionConfig: (projectId: string) => ipcRenderer.invoke('open-design:get-session-config', projectId),
    setSessionConfig: (projectId: string, cfg: import('../../src/types/open-design').OpenDesignSessionConfig) =>
      ipcRenderer.invoke('open-design:set-session-config', projectId, cfg),
    ensureSession: (projectId: string) => ipcRenderer.invoke('open-design:ensure-session', projectId),
    getStartStatus: (projectId: string) => ipcRenderer.invoke('open-design:get-start-status', projectId),
    onBootInstallStream: (
      handler: (event: import('../../src/types/open-design').BootInstallStreamEvent) => void,
    ): (() => void) => {
      const wrapped = (_event: unknown, payload: unknown): void => {
        handler(payload as import('../../src/types/open-design').BootInstallStreamEvent);
      };
      ipcRenderer.on('open-design:boot-install-stream', wrapped);
      return (): void => {
        ipcRenderer.removeListener('open-design:boot-install-stream', wrapped);
      };
    },
    onBootstrapProgress: (
      handler: (event: import('../../src/types/open-design').OpenDesignBootstrapProgressEvent) => void,
    ): (() => void) => {
      const wrapped = (_event: unknown, payload: unknown): void => {
        handler(payload as import('../../src/types/open-design').OpenDesignBootstrapProgressEvent);
      };
      ipcRenderer.on('open-design:bootstrap-progress', wrapped);
      return (): void => {
        ipcRenderer.removeListener('open-design:bootstrap-progress', wrapped);
      };
    },
  },
  pricing: {
    calculate: (input) => ipcRenderer.invoke('pricing:calculate', input),
  },
  drive: {
    getState: (projectId: string) => ipcRenderer.invoke('drive:get-state', projectId),
    start: (projectId: string, mode: 'semi' | 'full', sessionId: string) =>
      ipcRenderer.invoke('drive:start', projectId, mode, sessionId),
    assumir: (projectId: string) => ipcRenderer.invoke('drive:assumir', projectId),
    stop: (projectId: string) => ipcRenderer.invoke('drive:stop', projectId),
    resume: (projectId: string, sessionId: string) => ipcRenderer.invoke('drive:resume', projectId, sessionId),
    setMode: (projectId: string, mode: 'semi' | 'full') => ipcRenderer.invoke('drive:set-mode', projectId, mode),
    onStateChanged: (cb: (payload: DriveStateChangedEvent) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, payload: DriveStateChangedEvent) => cb(payload);
      ipcRenderer.on('drive:state-changed', handler);
      return () => {
        ipcRenderer.removeListener('drive:state-changed', handler);
      };
    },
  },
  repoGraph: {
    list: () => ipcRenderer.invoke('repo-graph:list'),
    addRepository: (rawPath: string) => ipcRenderer.invoke('repo-graph:add-repository', rawPath),
    removeRepository: (repositoryId: string) => ipcRenderer.invoke('repo-graph:remove-repository', repositoryId),
    getSessionState: (sessionId: string) => ipcRenderer.invoke('repo-graph:get-session-state', sessionId),
    attachSession: (sessionId: string, repositoryId: string) =>
      ipcRenderer.invoke('repo-graph:attach-session', sessionId, repositoryId),
    detachSession: (sessionId: string) => ipcRenderer.invoke('repo-graph:detach-session', sessionId),
    setPromptSuppressed: (sessionId: string, suppressed: boolean) =>
      ipcRenderer.invoke('repo-graph:set-prompt-suppressed', sessionId, suppressed),
    setGlobalPromptSuppressed: (repositoryId: string, suppressed: boolean) =>
      ipcRenderer.invoke('repo-graph:set-global-prompt-suppressed', repositoryId, suppressed),
    status: (repositoryId: string) => ipcRenderer.invoke('repo-graph:status', repositoryId),
    metrics: () => ipcRenderer.invoke('repo-graph:metrics'),
    build: (repositoryId: string, sessionId?: string | null) =>
      ipcRenderer.invoke('repo-graph:build', repositoryId, sessionId ?? null),
    update: (repositoryId: string, sessionId?: string | null) =>
      ipcRenderer.invoke('repo-graph:update', repositoryId, sessionId ?? null),
    onStatus: (cb: (event: RepoGraphStatusEvent) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, event: RepoGraphStatusEvent) => cb(event);
      ipcRenderer.on('repo-graph:on-status', handler);
      return () => {
        ipcRenderer.removeListener('repo-graph:on-status', handler);
      };
    },
  },
  kanban: {
    listBoards: () => ipcRenderer.invoke('kanban:list-boards'),
    createBoard: (input) => ipcRenderer.invoke('kanban:create-board', input),
    deleteBoard: (boardId) => ipcRenderer.invoke('kanban:delete-board', boardId),
    queryCards: (filters) => ipcRenderer.invoke('kanban:query-cards', filters),
    createCard: (input) => ipcRenderer.invoke('kanban:create-card', input),
    getCard: (board, localId) => ipcRenderer.invoke('kanban:get-card', board, localId),
    updateCard: (board, localId, patch) => ipcRenderer.invoke('kanban:update-card', board, localId, patch),
    moveCard: (board, localId, toColumn, reason) =>
      ipcRenderer.invoke('kanban:move-card', board, localId, toColumn, reason ?? null),
    deliverCard: (board, localId, commit, toColumn) =>
      ipcRenderer.invoke('kanban:deliver-card', board, localId, commit, toColumn ?? null),
    archiveCard: (board, localId) => ipcRenderer.invoke('kanban:archive-card', board, localId),
    unarchiveCard: (board, localId) => ipcRenderer.invoke('kanban:unarchive-card', board, localId),
    deleteCard: (board, localId, hard) => ipcRenderer.invoke('kanban:delete-card', board, localId, hard ?? false),
    attachFile: (board, localId, filePath) => ipcRenderer.invoke('kanban:attach-file', board, localId, filePath),
    removeAttachment: (attachmentId) => ipcRenderer.invoke('kanban:remove-attachment', attachmentId),
    openAttachment: (attachmentId) => ipcRenderer.invoke('kanban:open-attachment', attachmentId),
    readAttachment: (attachmentId) => ipcRenderer.invoke('kanban:read-attachment', attachmentId),
    onChanged: (cb: (event: KanbanChangedEvent) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, event: KanbanChangedEvent) => cb(event);
      ipcRenderer.on('kanban:changed', handler);
      return () => {
        ipcRenderer.removeListener('kanban:changed', handler);
      };
    },
  },
  dynamicWorkflow: {
    validate: (runId) => ipcRenderer.invoke('dynamic-workflow:validate', runId),
    start: (runId) => ipcRenderer.invoke('dynamic-workflow:start', runId),
    pause: (runId) => ipcRenderer.invoke('dynamic-workflow:pause', runId),
    resume: (runId, opts) => ipcRenderer.invoke('dynamic-workflow:resume', runId, opts),
    abort: (runId) => ipcRenderer.invoke('dynamic-workflow:abort', runId),
    reopen: (runId) => ipcRenderer.invoke('dynamic-workflow:reopen', runId),
    deleteRun: (runId) => ipcRenderer.invoke('dynamic-workflow:delete', runId),
    sendMessage: (runId, message, attachments) =>
      ipcRenderer.invoke('dynamic-workflow:send-message', runId, message, attachments),
    intervene: (runId, intervention) => ipcRenderer.invoke('dynamic-workflow:intervene', runId, intervention),
    requestReplan: (runId, request) => ipcRenderer.invoke('dynamic-workflow:request-replan', runId, request),
    approveGate: (runId, gateId, decision) =>
      ipcRenderer.invoke('dynamic-workflow:approve-gate', runId, gateId, decision),
    resolveWithCloser: (runId, reason) => ipcRenderer.invoke('dynamic-workflow:resolve-with-closer', runId, reason),
    sendCloserMessage: (runId, message) => ipcRenderer.invoke('dynamic-workflow:closer-message', runId, message),
    finalizeWorkflow: (runId) => ipcRenderer.invoke('dynamic-workflow:finalize', runId),
    getRun: (runId) => ipcRenderer.invoke('dynamic-workflow:get-run', runId),
    getSnapshot: (runId) => ipcRenderer.invoke('dynamic-workflow:get-snapshot', runId),
    listRuns: () => ipcRenderer.invoke('dynamic-workflow:list-runs'),
    getNodes: (runId) => ipcRenderer.invoke('dynamic-workflow:get-nodes', runId),
    getEvents: (runId, opts) => ipcRenderer.invoke('dynamic-workflow:get-events', runId, opts),
    getRunBundle: (runId) => ipcRenderer.invoke('dynamic-workflow:get-run-bundle', runId),
    openRunDir: (runId) => ipcRenderer.invoke('dynamic-workflow:open-run-dir', runId),
    getArtifacts: (runId) => ipcRenderer.invoke('dynamic-workflow:get-artifacts', runId),
    getMessages: (runId) => ipcRenderer.invoke('dynamic-workflow:get-messages', runId),
    onEvent: (cb: (chunk: DynamicWorkflowStreamChunk) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, chunk: DynamicWorkflowStreamChunk) => cb(chunk);
      ipcRenderer.on('dynamic-workflow:stream', handler);
      return () => {
        ipcRenderer.removeListener('dynamic-workflow:stream', handler);
      };
    },
  },
};

contextBridge.exposeInMainWorld('lionclaw', api);
