export * from './pipeline';

export * from './open-design';

export * from './dynamic-workflow';

export * from './stream-timeline';

import type { DynamicWorkflowAPI } from './dynamic-workflow';
import type {
  PipelineProject,
  PipelineMessage,
  PipelineMetricsResult,
  PipelineStreamChunk,
  PipelinePhaseChangedEvent,
  PipelineProjectUpdatedEvent,
  PipelineNotesUpdatedEvent,
  PipelineSprintCompleteEvent,
  PipelineSprintMessage,
  SecurityAgentStatus,
} from './pipeline';

export interface ChatAttachment {
  id: string;
  type: 'image' | 'audio';
  filename: string;
  mimeType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' | 'audio/webm' | 'audio/mpeg';
  data: string;
  size: number;
  preview?: string;
}

export interface ChatMessage {
  id: number;
  sessionId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  subagent?: string;
  attachments?: ChatAttachment[];
  messageType?: 'text' | 'ask_question' | 'confirm_action';
  metadata?: MessageMetadata;
  createdAt: string;
}

export type TimelineRuntime = 'lion-sdk' | 'grok' | 'kimi' | 'codex' | 'cursor';
export type TimelineFidelity = 'exact' | 'observed';
export type TimelineTurnStatus = 'interrupted' | 'complete';
export type TimelineTurnOrigin = 'turn' | 'retry' | 'system-event' | 'swarm' | 'cron' | 'telegram';
export type TimelineEventKind =
  'user' | 'assistant_step' | 'tool_call' | 'tool_call_args' | 'tool_result' | 'assistant_final';

export interface TimelineTurn {
  seqId: number;
  runId: string;
  sessionId: string;
  turnIndex: number;
  anchorMessageId: number | null;
  currentUserMessageId: number | null;
  assistantMessageId: number | null;
  origin: TimelineTurnOrigin;
  runtime: TimelineRuntime;
  fidelity: TimelineFidelity;
  status: TimelineTurnStatus;
  cwd: string | null;
  textTokensEst: number | null;
  toolTokensEst: number | null;
  createdAt: string;
}

export interface TimelineEvent {
  id: number;
  runId: string;
  sessionId: string;
  seq: number;
  kind: TimelineEventKind;
  toolUseId: string | null;
  toolName: string | null;
  content: string;
  toolCallsJson: string | null;
  reasoningContent: string | null;
  isError: boolean;
  originalBytes: number | null;
  spillPath: string | null;
  createdAt: string;
}

export interface TimelineTurnWithEvents extends TimelineTurn {
  events: TimelineEvent[];
}

export interface MessageMetadata {
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  toolCalls?: ToolCallSummary[];
  askQuestions?: AskQuestion[];
  askAnswers?: Record<string, string | string[]>;
  artifacts?: ArtifactData[];
  source?: 'pipeline-drive';
  attachmentsMeta?: ChatAttachmentMeta[];
}

export interface ChatAttachmentMeta {
  id: string;
  type: 'image';
  filename: string;
  mimeType: string;
  preview: string;
}

export interface ToolCallSummary {
  tool: string;
  input: string;
  durationMs: number;
  output?: string;
  result?: string;
  isError?: boolean;
  status?: import('./stream-timeline').StreamTimelineToolStatus;
  sequence?: number;
  textOffset?: number;
  toolCallId?: string;
}

export interface ChatSession {
  id: string;
  sdkSessionId?: string;
  subagent?: string;
  title?: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  costStatus?: 'known' | 'unknown' | 'estimated-partial';
  tokenStatus?: 'reported' | 'not_reported';
  unknownCostCount?: number;
  costUnknownReasons?: string[];
  costByRuntime?: Record<string, number>;
  costStatusByRuntime?: Record<string, 'known' | 'unknown' | 'estimated-partial'>;
  subscriptionEquivalentCost?: number;
  status: 'active' | 'archived' | 'compacted' | 'trashed';
  type: 'chat' | 'scheduled' | 'manual' | 'telegram';
  taskId?: string;
  createdAt: string;
  updatedAt: string;
  compactedUpToMessageId?: number;
  rollingSummary?: string;
  pendingSeed?: string;
  activeContextTokensEst?: number;
  agenticContextTokensEst?: number;
  threadResetMessageId?: number;
  laneBadge?: number | null;
  orchestrator?: SessionOrchestrator | null;
  sdkThreadHistory?: string[];
  dreamingStartedAt?: string;
  dreamingTurnCount?: number;
  messageCount?: number;
  lastUserMessageAt?: string | null;
  state?: LaneSessionState;
}

export interface SessionOrchestrator {
  runtime: OrchestratorRuntime;
  provider: OrchestratorProvider;
  model: string;
  effort?: string;
}

export type LaneSessionState = 'idle' | 'streaming' | 'queued' | 'clearing' | 'interrupted' | 'drive';

export interface OpenChatSession {
  id: string;
  laneBadge: number;
  title: string;
  orchestrator: SessionOrchestrator | null;
  messageCount: number;
  lastUserMessageAt: string | null;
  createdAt: string;
  updatedAt: string;
  state: LaneSessionState;
  drive: { projectId: string; name: string; status: DriveState['status'] } | null;
}

export interface ChatSessionUpdatedEvent {
  sessionId: string;
  laneBadge: number | null;
  orchestrator: SessionOrchestrator | null;
  messageCount: number;
  state: LaneSessionState;
}

export type ChatLaneErrorCode =
  | 'session_required'
  | 'session_not_found'
  | 'session_not_active'
  | 'lane_required'
  | 'lanes_full'
  | 'provider_locked'
  | 'invalid_selection'
  | 'model_not_in_provider'
  | 'effort_not_supported'
  | 'turn_binding_required'
  | 'session_clearing'
  | 'orchestrator_unconfigured'
  | 'lane_busy'
  | 'drive_owned_by_other_lane'
  | 'drive_scope_violation'
  | 'drive_uniqueness_violated'
  | 'drive_turn_in_flight';

export interface ChatSendOptions {
  sessionId?: string;
  agentId?: string;
  model?: string;
  effort?: string;
  attachments?: ChatAttachment[];
  featureToggles?: ChatFeatureToggles;
}

export type ChatClearErrorCode =
  | 'session_required'
  | 'session_not_found'
  | 'session_not_active'
  | 'session_busy'
  | 'session_clearing'
  | 'drive_active'
  | 'empty_session'
  | 'turn_did_not_settle'
  | 'clear_cancelled'
  | 'clear_not_queued'
  | 'COMPACT-SUMMARY-FAILED'
  | 'COMPACT-MEMORY-FAILED'
  | 'clear_failed';

export interface ChatClearWarning {
  step: 'embeddings' | 'graph' | 'transcript' | 'report' | 'compaction_log';
  detail: string;
}

export type ChatClearResult =
  | {
      ok: true;
      sessionId: string;
      newSessionId: string | null;
      warnings: ChatClearWarning[];
      pausedDriveProjectIds: string[];
    }
  | { ok: false; code: ChatClearErrorCode; error: string };

export type ChatClearCancelResult =
  { ok: true; sessionId: string } | { ok: false; code: 'clear_not_queued' | 'session_required'; error: string };

export interface CompactionActivePayload {
  isActive: boolean;
  sessionId?: string;
  phase?: 'queued' | 'running';
  modelLabel?: string;
  title?: string;
  source?: 'lionclaw';
}

export type LiveActivityKind = 'subagent' | 'tool' | 'pipeline' | 'workflow';
export type LiveActivityPhase = 'start' | 'update' | 'end';
export type LiveActivityStatus = 'running' | 'done' | 'error' | 'stopped';

export interface LiveActivityEvent {
  id: string;
  parentId?: string;
  kind: LiveActivityKind;
  phase: LiveActivityPhase;
  label: string;
  status?: LiveActivityStatus;
  agentId?: string | null;
  model?: string;
  toolName?: string;
  tokens?: { input: number; output: number; cacheRead?: number; cacheCreation?: number };
  costUsd?: number;
  durationMs?: number;
  summary?: string;
  startedAt?: string;
  endedAt?: string;
  turnIndex?: number;
  description?: string;
  file?: string;
  command?: string;
  filesChanged?: string[];
  changed?: boolean;
  exitCode?: number;
  toolUses?: number;
  projectId?: string;
}

export interface LiveActivity {
  id: string;
  parentId?: string;
  kind: LiveActivityKind;
  label: string;
  status: LiveActivityStatus;
  agentId?: string | null;
  toolName?: string;
  tokens?: LiveActivityEvent['tokens'];
  costUsd?: number;
  durationMs?: number;
  summary?: string;
  startedAt?: string;
  endedAt?: string;
  turnIndex?: number;
  description?: string;
  file?: string;
  command?: string;
  filesChanged?: string[];
  changed?: boolean;
  exitCode?: number;
  toolUses?: number;
  projectId?: string;
}

export interface ActivityTurnBlock {
  turnIndex: number;
  sessionId: string;
  title?: string;
  items: LiveActivity[];
  startedAt: string;
  endedAt?: string;
  totals: { tokens: number; costUsd: number; subagents: number; tools: number };
  status: 'running' | 'done' | 'error' | 'stopped';
}

export interface RepoGraphChunkPayload {
  sessionId: string;
  turnIndex?: number;
  repositoryId: string;
  status: import('./repo-graph').LocalRepositoryStatus;
  used: boolean;
  source: import('./repo-graph').RepoGraphUsageSource;
  runtime?: string | null;
  toolName?: string;
  reason?: string;
  resultCount?: number;
  bytesReturned?: number;
  durationMs?: number;
  buildProgress?: string;
}

export interface StreamChunk {
  type:
    | 'text'
    | 'tool_call'
    | 'tool_result'
    | 'error'
    | 'done'
    | 'confirm_request'
    | 'ask_question'
    | 'usage'
    | 'session'
    | 'onboarding_completed'
    | 'replace_content'
    | 'artifact'
    | 'context_usage'
    | 'compacting'
    | 'dreaming_status'
    | 'activity'
    | 'assistant_pushed'
    | 'drive_paused'
    | 'repo_graph';
  sessionId?: string;
  content?: string;
  tool?: string;
  toolCallId?: string;
  input?: unknown;
  result?: string;
  isError?: boolean;
  error?: string;
  authProvider?: 'codex' | 'grok' | 'kimi';
  code?: string;
  confirmId?: string;
  confirmAction?: ConfirmAction;
  askRequest?: AskQuestionRequest;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    estimated?: boolean;
    runtime?: OrchestratorRuntime;
    provider?: OrchestratorProvider;
    model?: string;
    costUsd?: number | null;
    costStatus?: 'known' | 'unknown' | 'estimated-partial';
    costStatusReasons?: readonly string[];
    tokenStatus?: 'reported' | 'not_reported';
    costUnknownReason?: string;
    costEstimationKind?: 'subscription-equivalent-payg';
  };
  contextUsage?: {
    contextTokens: number;
    contextWindowTokens: number;
    compactionThresholdPercent: number;
    source?: 'estimate' | 'provider';
  };
  artifact?: ArtifactData;
  isCompacting?: boolean;
  isDreaming?: boolean;
  queueRemaining?: number;
  activity?: LiveActivityEvent;
  message?: ChatMessage;
  repoGraph?: RepoGraphChunkPayload;
}

export interface ArtifactData {
  id: string;
  type: 'excalidraw' | 'image' | 'html' | 'mermaid' | 'mcp_app' | 'audio' | 'document';
  title: string;
  toolName: string;
  data: Record<string, unknown>;
}

export interface ConfirmAction {
  id: string;
  tool: string;
  description: string;
  input: unknown;
  risk: 'medium' | 'high' | 'critical';
  sessionId?: string;
  title?: string;
  laneBadge?: number | null;
}

export interface AskQuestionOption {
  label: string;
  description: string;
  preview?: string;
}

export interface AskQuestion {
  question: string;
  header: string;
  options: AskQuestionOption[];
  multiSelect?: boolean;
}

export interface AskQuestionRequest {
  id: string;
  questions: AskQuestion[];
  sessionId?: string;
  title?: string;
  laneBadge?: number | null;
}

export interface AskQuestionResponse {
  id: string;
  answers: Record<string, string | string[]>;
  annotations?: Record<
    string,
    {
      preview?: string;
      notes?: string;
    }
  >;
}

export type LocalLLMProvider = 'ollama' | 'lmstudio' | 'openai-compatible';

export type ExternalProvider =
  | 'openrouter'
  | 'openai'
  | 'openai-compatible'
  | 'kimi'
  | 'deepseek'
  | 'qwen'
  | 'minimax-payg'
  | 'gemini-agent-platform';

export type ExternalProtocol = 'openai-compatible' | 'google-genai';

export type LLMProvider = LocalLLMProvider | ExternalProvider;

export interface ExternalConfig {
  provider: ExternalProvider;
  protocol?: ExternalProtocol;
  baseUrl?: string;
  model: string;
  apiKeyRef: string;
  temperature?: number;
  maxTokens?: number;
  extraHeaders?: Record<string, string>;
  contextWindow?: number;
  location?: string;
  projectId?: string;
}

export interface CodexConfig {
  model: string;
  sandbox?: 'workspace-write' | 'read-only' | 'danger-full-access';
  reasoningEffort?: CodexChatReasoningEffort;
}

export type CodexChatReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';

export type AgentUpdatePayload = Omit<Partial<AgentConfig>, 'localConfig' | 'externalConfig' | 'codexConfig'> & {
  localConfig?: AgentConfig['localConfig'] | null;
  externalConfig?: AgentConfig['externalConfig'] | null;
  codexConfig?: AgentConfig['codexConfig'] | null;
};

export interface AgentConfig {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  model: string;
  allowedTools: string[];
  mcpServers: string[];
  isActive: boolean;
  sortOrder: number;
  effort: 'low' | 'medium' | 'high' | 'max';
  thinking: 'adaptive' | 'enabled' | 'disabled';
  thinkingBudget?: number;
  maxTurns?: number;
  skills: string[];
  kbEnabled?: boolean;
  runtime: 'cloud' | 'local' | 'external' | 'codex' | 'zai' | 'minimax-tp' | 'kimi' | 'grok' | 'cursor';
  localConfig?: {
    provider: LocalLLMProvider;
    baseUrl: string;
    model: string;
    temperature?: number;
    maxTokens?: number;
  };
  externalConfig?: ExternalConfig;
  codexConfig?: CodexConfig;
  localMode?: 'simple' | 'smart';
  maxToolRounds?: number;
  squad?: string;
  access?: 'read-only' | 'workspace-write';
  allowBash?: boolean;
  allowedCommands?: string[];
  allowNetwork?: boolean;
}

export interface Skill {
  name: string;
  description: string;
  category?: string;
  allowedTools?: string[];
  model?: string;
  disableModelInvocation: boolean;
  userInvocable: boolean;
  argumentHint?: string;
  context?: 'fork';
  agent?: string;
  content: string;
  rawContent: string;
  path: string;
  hasAuxFiles: boolean;
}

export interface SkillInput {
  name: string;
  description: string;
  category?: string;
  content: string;
  allowedTools?: string[];
  model?: string;
  disableModelInvocation?: boolean;
  userInvocable?: boolean;
  context?: 'fork';
  agent?: string;
}

export interface MCPServerConfig {
  id: string;
  name: string;
  description?: string;
  command: string;
  args: string[];
  envKeys: string[];
  isActive: boolean;
  status?: 'running' | 'stopped' | 'error';
  visibleTo?: 'all' | 'codex-lion-only';
  indexMode?: 'tools' | 'server';
}

export interface SDKMcpServer {
  name: string;
  status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled';
  serverInfo?: {
    name: string;
    version: string;
  };
  error?: string;
  scope?: string;
  tools?: Array<{
    name: string;
    description?: string;
    annotations?: {
      readOnly?: boolean;
      destructive?: boolean;
      openWorld?: boolean;
    };
  }>;
  isDisabledLocally: boolean;
}

export interface ScheduledTask {
  id: string;
  name: string;
  prompt: string;
  subagent?: string;
  scheduleType: 'cron' | 'interval' | 'once';
  scheduleValue: string;
  status: 'active' | 'paused' | 'completed';
  lastRun?: string;
  nextRun?: string;
  runCount: number;
  notify: boolean;
  tags: string[];
  scheduleError?: string;
}

export interface TaskRun {
  id: number;
  taskId: string;
  startedAt: string;
  completedAt?: string;
  status: 'running' | 'success' | 'error';
  result?: string;
  error?: string;
  tokensUsed: number;
  costUsd: number;
  sessionId?: string;
  reviewStatus?: 'pending_review' | 'validated' | 'rejected';
  reviewNote?: string;
  reviewedAt?: string;
}

export type TaskInput = Omit<ScheduledTask, 'id' | 'lastRun' | 'nextRun' | 'runCount'>;

export interface ActivityItem {
  runId: number;
  taskId: string;
  taskName: string;
  prompt: string;
  subagent: string | null;
  tags: string[];
  scheduledFor: string;
  startedAt: string | null;
  completedAt: string | null;
  status: 'scheduled' | 'running' | 'success' | 'error';
  reviewStatus: 'pending_review' | 'validated' | 'rejected' | null;
  sessionId: string | null;
  error: string | null;
}

export interface ActivityFilters {
  from: string;
  to: string;
  subagent?: string;
  status?: 'scheduled' | 'running' | 'success' | 'error';
  tags?: string[];
}

export interface ActivityStats {
  scheduled: number;
  running: number;
  success: number;
  error: number;
}

export interface PersonalTask {
  id: string;
  title: string;
  description: string | null;
  category: string | null;
  status: 'pending' | 'in_progress' | 'done';
  priority: 'low' | 'normal' | 'high';
  dueDate: string | null;
  createdAt: string;
  updatedAt: string;
  doneAt: string | null;
  doneComment: string | null;
}

export interface PersonalTaskInput {
  title: string;
  description?: string;
  category?: string;
  priority?: string;
  dueDate?: string;
}

export interface PersonalTaskFilters {
  status?: string;
  category?: string;
  priority?: string;
  period?: 'last30' | 'last90' | 'all';
}

export interface SemanticMemory {
  id: number;
  content: string;
  sourceSession?: string;
  topic?: string;
  subagent?: string;
  createdAt: string;
  similarity?: number;
}

export interface DailySummary {
  id: number;
  date: string;
  summary: string;
  decisions: string[];
  tasksCreated: string[];
  factsExtracted: string[];
  messageCount: number;
  subagentsUsed: string[];
  tokensUsed: number;
  costUsd: number;
}

export interface Channel {
  id: string;
  type: 'telegram' | 'slack' | 'discord' | 'whatsapp';
  name: string;
  config: Record<string, unknown>;
  isActive: boolean;
  status: 'connected' | 'disconnected' | 'error';
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TelegramSaveConfig {
  botToken: string;
  allowedUserId: number;
  allowedUserName: string;
  notifyOnSchedulerTasks: boolean;
  notifyOnDriveHandoff: boolean;
}

export type AuditSource = 'chat' | 'pipeline' | 'harness' | 'enrich' | 'workflow';

export interface AuditEntry {
  id: number;
  sessionId?: string;
  subagent?: string;
  eventType: 'tool_call' | 'tool_result' | 'tool_blocked' | 'error' | 'confirm_request' | 'confirm_response';
  toolName?: string;
  input?: string;
  output?: string;
  durationMs?: number;
  approved?: boolean;
  source?: AuditSource;
  createdAt: string;
}

export type SdkChoice = 'claude-anthropic' | 'codex' | 'claude-compat' | 'lion-sdk';

export type SdkCompleteHandler = (
  patch: Partial<AppSettings>,
  providerConnect?: () => Promise<{ ok: true } | { error: string }>,
) => Promise<{ ok: true } | { error: string }>;

export type OrchestratorRuntime =
  'claude-sdk' | 'claude-compat-sdk' | 'codex-sdk' | 'lion-sdk' | 'kimi-sdk' | 'grok-sdk' | 'cursor-sdk';

export type OrchestratorProvider =
  | 'anthropic'
  | 'zai'
  | 'minimax'
  | 'codex'
  | 'codex-official'
  | 'kimi'
  | 'grok'
  | 'cursor'
  | 'ollama'
  | 'lmstudio'
  | 'openai-compatible'
  | 'vertex-ai';

export type OpenAiCompatiblePreset = 'kimi' | 'kimi-cn' | 'qwen' | 'deepseek' | 'minimax' | 'custom';

export type VoiceTranscriptionModel = 'whisper-1' | 'gpt-4o-mini-transcribe' | 'gpt-4o-transcribe';

export interface ProviderModelEntry {
  id: string;
  displayName: string;
  label: string;
  reasoningOptions: string[];
  defaultReasoning: string | null;
  contextWindow?: number;
}

export interface ProviderStatusEntry {
  runtime: OrchestratorRuntime;
  provider: OrchestratorProvider;
  connected: boolean;
  available: boolean;
  authenticated?: boolean;
  subscriptionRouteVerified?: boolean;
  isolationVerified?: boolean;
  toolPolicyVerified?: boolean;
  modelAvailable?: boolean | null;
  usable?: boolean;
  reason?: string;
  models?: ProviderModelEntry[];
}

export const CHAT_WIDTH_MODES = ['compacto', 'amplo', 'full-width'] as const;
export type ChatWidthMode = (typeof CHAT_WIDTH_MODES)[number];

export type UsageLimitsProvider = 'claude' | 'codex' | 'glm' | 'minimax' | 'kimi';

export interface ProviderUsageWindow {
  id: string;
  label: string;
  usedPercent: number;
  resetsAt: string | null;
}

export interface ProviderUsageLimits {
  provider: UsageLimitsProvider;
  status: 'ok' | 'unavailable';
  reason?: string;
  planType?: string | null;
  windows: ProviderUsageWindow[];
}

export interface UsageLimitsResponse {
  providers: ProviderUsageLimits[];
}

export interface AppSettings {
  defaultModel?: string;

  orchestratorRuntime: OrchestratorRuntime;
  orchestratorProvider: OrchestratorProvider;
  orchestratorModel: string;

  orchestratorEffort?: 'low' | 'medium' | 'high' | 'max';

  orchestratorCodexEffort?: CodexChatReasoningEffort;

  orchestratorKimiEffort?: import('../constants/kimi-models').KimiEffort;

  orchestratorGrokEffort?: import('../constants/grok-models').GrokReasoningEffort;

  chatWidthMode?: ChatWidthMode;
  chatStaleLaneDays?: number;

  grokBinaryPath?: string;
  grokMaxConcurrency?: number;

  orchestratorOllamaBaseUrl?: string;
  orchestratorLmStudioBaseUrl?: string;

  orchestratorOpenAiCompatPreset?: OpenAiCompatiblePreset;
  orchestratorOpenAiCompatBaseUrl?: string;
  orchestratorOpenAiCompatApiKeyRef?: string;

  orchestratorZaiApiKeyRef?: string;
  orchestratorMinimaxApiKeyRef?: string;

  orchestratorVertexApiKeyRef?: string;
  orchestratorVertexLocation?: string;
  orchestratorVertexProjectId?: string;
  orchestratorVertexAuthMode?: 'api-key';

  orchestratorCompactionRuntime?: OrchestratorRuntime;
  orchestratorCompactionProvider?: OrchestratorProvider;
  orchestratorCompactionModel?: string;
  orchestratorContextWindowTokens?: number;
  orchestratorCompactionThresholdPercent?: number;
  chatCompactionTargetTokens?: number;
  chatAutoCompactionEnabled?: boolean;
  chatTimelineReinjectEnabled?: boolean;

  orchestratorSetupCompleted: boolean;

  language: 'pt-BR';
  sessionTimeoutMinutes: number;
  compactionSchedule: string;
  maxWorkingMemoryTokens: number;
  rawMessageRetentionDays: number;
  maxSessionTokens?: number;
  voiceResponseEnabled: boolean;
  voiceId?: string;
  voiceLiveProvider?: 'elevenlabs' | 'cartesia';
  cartesiaVoiceId?: string;
  cartesiaVoiceLanguage?: string;
  cartesiaModel?: string;
  cartesiaSpeed?: number;
  voiceTranscriptionModel: VoiceTranscriptionModel;
  visionProvider: 'openai' | 'anthropic';
  visionModel: string;
  ollamaEnabled: boolean;
  ollamaBaseUrl: string;
  ollamaEmbeddingModel: string;
  ollamaCompactionModel: string;
  mgraphMode: boolean;

  dreamingTurnBasedEnabled?: boolean;
  dreamingTurnBasedInterval?: number;
  dreamingTurnBasedModel?: string;

  subagentsPromptMode?: 'index' | 'full';

  mcpPromptMode?: 'index' | 'full';

  chatCapabilityGateMode?: 'shadow' | 'enforce';

  toolScriptEnabled?: boolean;
  toolScriptAvailable?: boolean;
  toolScriptAvailabilityReason?: string;
  toolScriptTools?: string[];
  toolScriptTimeoutMs?: number;
  toolScriptMaxStdoutBytes?: number;
  toolScriptMaxStderrBytes?: number;
  toolScriptMaxToolCalls?: number;
}

export interface SettingsUpdateResult {
  success?: boolean;
  error?: string;
}

export interface LogFilters {
  sessionId?: string;
  subagent?: string;
  eventType?: string;
  source?: AuditSource;
  from?: string;
  to?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface SystemLogEntry {
  seq: number;
  time: number;
  level: number;
  levelLabel: string;
  module?: string;
  msg?: string;
  extra?: string;
}

export interface SystemLogFilters {
  minLevel?: number;
  module?: string;
  search?: string;
  limit?: number;
}

export interface SystemLogQueryResult {
  entries: SystemLogEntry[];
  modules: string[];
  logFilePath: string;
}

export const TOOL_CATALOG = [
  {
    id: 'Read',
    name: 'Ler Arquivos',
    description: 'Le arquivos do filesystem',
    category: 'filesystem',
    risk: 'low',
    extraCost: false,
  },
  {
    id: 'Write',
    name: 'Criar Arquivos',
    description: 'Cria arquivos novos',
    category: 'filesystem',
    risk: 'medium',
    extraCost: false,
  },
  {
    id: 'Edit',
    name: 'Editar Arquivos',
    description: 'Edita arquivos existentes',
    category: 'filesystem',
    risk: 'medium',
    extraCost: false,
  },
  {
    id: 'Glob',
    name: 'Buscar Arquivos',
    description: 'Busca arquivos por pattern',
    category: 'filesystem',
    risk: 'low',
    extraCost: false,
  },
  {
    id: 'Grep',
    name: 'Buscar Conteudo',
    description: 'Busca conteudo dentro de arquivos',
    category: 'filesystem',
    risk: 'low',
    extraCost: false,
  },
  {
    id: 'NotebookEdit',
    name: 'Editar Notebooks',
    description: 'Edita notebooks Jupyter',
    category: 'filesystem',
    risk: 'medium',
    extraCost: false,
  },
  {
    id: 'Bash',
    name: 'Terminal',
    description: 'Executa comandos no terminal',
    category: 'system',
    risk: 'high',
    extraCost: false,
  },
  {
    id: 'WebSearch',
    name: 'Busca Web',
    description: 'Pesquisa na internet (~$0.01/busca)',
    category: 'internet',
    risk: 'medium',
    extraCost: true,
  },
  {
    id: 'WebFetch',
    name: 'Acessar URL',
    description: 'Acessa e le conteudo de URLs',
    category: 'internet',
    risk: 'medium',
    extraCost: false,
  },
  {
    id: 'Agent',
    name: 'SubAgentes',
    description: 'Delega tarefas para subagentes',
    category: 'orchestration',
    risk: 'low',
    extraCost: false,
  },
  {
    id: 'TodoWrite',
    name: 'Lista de Tarefas',
    description: 'Gerencia lista de tarefas interna',
    category: 'utility',
    risk: 'none',
    extraCost: false,
  },
  {
    id: 'AskUserQuestion',
    name: 'Perguntar ao Usuario',
    description: 'Faz perguntas com opcoes',
    category: 'interaction',
    risk: 'none',
    extraCost: false,
  },
] as const;

export type ToolId = (typeof TOOL_CATALOG)[number]['id'];

export type ToolCategory = (typeof TOOL_CATALOG)[number]['category'];

export const TOOL_CATEGORY_LABELS: Record<ToolCategory, string> = {
  filesystem: 'Filesystem',
  system: 'Sistema',
  internet: 'Internet',
  orchestration: 'Orquestracao',
  utility: 'Utilidade',
  interaction: 'Interacao',
};

export type HarnessProjectStatus = HarnessProject['status'];

export interface OrchestratorSelectionSnapshot {
  runtime: OrchestratorRuntime;
  provider: OrchestratorProvider;
  model: string;
  effort?: string;
  baseUrl?: string;
}

export interface AgentSyncPatchSnapshot {
  runtime: AgentConfig['runtime'];
  model: string;
  effort?: AgentConfig['effort'];
  localConfig?: AgentConfig['localConfig'];
  externalConfig?: AgentConfig['externalConfig'];
  codexConfig?: AgentConfig['codexConfig'];
  localMode?: AgentConfig['localMode'];
  allowedTools?: string[];
  mcpServers?: string[];
  skills?: string[];
}

export interface SyncAgentsToOrchestratorRequest {
  agentIds?: string[];
  dryRun?: boolean;
  mode?: 'initial-onboarding' | 'manual-button';
  selection?: SessionOrchestrator;
}

export interface AgentSyncResult {
  agentId: string;
  before: AgentSyncPatchSnapshot;
  after: AgentSyncPatchSnapshot;
  changed: boolean;
  restoredFromSeed?: Array<'allowedTools' | 'mcpServers' | 'skills'>;
  warning?: string;
  error?: string;
}

export interface AgentSyncSuccessResponse {
  blocked: false;
  orchestrator: OrchestratorSelectionSnapshot;
  results: AgentSyncResult[];
  summary: { updated: number; skipped: number; failed: number };
}

export interface AgentSyncBlockedResponse {
  blocked: true;
  reason: 'pipeline-running' | 'enrich-active' | 'project-locked';
  active: {
    projects: Array<{ id: string; name: string; status: HarnessProjectStatus }>;
    enrich: boolean;
  };
}

export type SyncAgentsToOrchestratorResponse = AgentSyncSuccessResponse | AgentSyncBlockedResponse;

export interface AgentSyncIpcError {
  error: string;
}

export type SyncAgentsToOrchestratorIpcResult = SyncAgentsToOrchestratorResponse | AgentSyncIpcError;

export function isAgentSyncIpcError(result: SyncAgentsToOrchestratorIpcResult): result is AgentSyncIpcError {
  return 'error' in result && typeof result.error === 'string';
}

export interface KimiAvailability {
  installed: boolean;
  version: string | null;
  authenticated: boolean;
  authMode: 'subscription' | 'none';
  managedProviderVerified: boolean;
  modelAvailable: boolean;
  availableModels: string[];
  usable: boolean;
  reason?: string;
}

export interface PipelineAuditAgentSnapshot {
  agentId: string;
  agentSlug?: string;
  agentName: string;
  status: string;
  findingsCount?: number;
  costUsd: number;
  durationMs: number;
  model: string | null;
  runtime: AgentConfig['runtime'] | null;
  startedAt?: string | null;
  completedAt?: string | null;
  filesAnalyzed: number;
  additionalFilesAfterStart: number;
  toolCallsCount: number;
}

export type PipelineAuditAgentsStateResponse = { agents: PipelineAuditAgentSnapshot[] } | { error: string };

export interface LionClawAPI {
  app: {
    getVersion: () => Promise<{ version: string; label: string }>;
  };
  chat: {
    send: (
      message: string,
      options?: ChatSendOptions,
    ) => Promise<{ accepted: boolean; code?: ChatLaneErrorCode; error?: string }>;
    stop: (sessionId?: string) => Promise<void>;
    onStream: (cb: (chunk: StreamChunk) => void) => () => void;
    onConfirmRequest: (cb: (action: ConfirmAction) => void) => () => void;
    confirmResponse: (id: string, approved: boolean) => Promise<void>;
    onAskQuestion: (cb: (request: AskQuestionRequest) => void) => () => void;
    askResponse: (response: AskQuestionResponse) => Promise<void>;
    getSessions: () => Promise<ChatSession[]>;
    getMessages: (sessionId: string) => Promise<ChatMessage[]>;
    deleteSession: (sessionId: string) => Promise<{ success: boolean; error?: string }>;
    archiveSession: (sessionId: string) => Promise<boolean>;
    getContextUsage: (sessionId: string) => Promise<NonNullable<StreamChunk['contextUsage']> | null>;
    getFeatureToggles: (sessionId: string) => Promise<ChatFeatureTogglesResult>;
    setFeatureToggles: (sessionId: string, patch: Partial<ChatFeatureToggles>) => Promise<ChatFeatureTogglesResult>;
    ensureSession: (
      preferredSessionId?: string,
    ) => Promise<{ sessionId: string } | { error: string; code?: ChatLaneErrorCode }>;
    createSession: () => Promise<{ session: OpenChatSession } | { error: string; code: ChatLaneErrorCode }>;
    listOpenSessions: () => Promise<OpenChatSession[] | { error: string }>;
    setSessionOrchestrator: (
      sessionId: string,
      selection: { runtime: OrchestratorRuntime; provider: OrchestratorProvider; model: string; effort?: string },
    ) => Promise<{ ok: true; orchestrator: SessionOrchestrator } | { error: string; code: ChatLaneErrorCode }>;
    onSessionUpdated: (cb: (event: ChatSessionUpdatedEvent) => void) => () => void;
    clear: (sessionId: string, opts?: { force?: boolean }) => Promise<ChatClearResult>;
    clearCancel: (sessionId: string) => Promise<ChatClearCancelResult>;
    compactSession: (sessionId?: string) => Promise<{
      success: boolean;
      newSessionId?: string;
      reason?: string;
      error?: string;
    }>;
    clearSession: (sessionId?: string) => Promise<{
      success: boolean;
      newSessionId?: string;
      reason?: string;
    }>;
    onSessionsUpdated: (cb: () => void) => () => void;
    onCompactionActive: (cb: (payload: CompactionActivePayload) => void) => () => void;
  };
  activity: {
    getBlocks: (sessionId: string) => Promise<ActivityTurnBlock[]>;
  };
  agents: {
    list: () => Promise<AgentConfig[]>;
    get: (id: string) => Promise<AgentConfig>;
    create: (agent: Omit<AgentConfig, 'sortOrder'>) => Promise<AgentConfig>;
    update: (id: string, agent: AgentUpdatePayload) => Promise<AgentConfig>;
    delete: (id: string) => Promise<void>;
    syncToOrchestrator: (req?: SyncAgentsToOrchestratorRequest) => Promise<SyncAgentsToOrchestratorIpcResult>;
  };
  skills: {
    list: () => Promise<Skill[]>;
    get: (name: string) => Promise<Skill>;
    create: (skill: SkillInput) => Promise<Skill>;
    update: (name: string, skill: SkillInput) => Promise<Skill>;
    updateRaw: (name: string, content: string) => Promise<Skill>;
    delete: (name: string) => Promise<void>;
  };
  mcp: {
    list: () => Promise<MCPServerConfig[]>;
    create: (config: Omit<MCPServerConfig, 'status'>) => Promise<MCPServerConfig>;
    update: (id: string, config: Partial<MCPServerConfig>) => Promise<MCPServerConfig>;
    delete: (id: string) => Promise<void>;
    test: (id: string) => Promise<{ success: boolean; error?: string }>;
    restart: (id: string) => Promise<void>;
    toggle: (id: string, active: boolean) => Promise<MCPServerConfig>;
    listSDK: () => Promise<SDKMcpServer[]>;
    refreshSDK: () => Promise<SDKMcpServer[]>;
    toggleSDK: (name: string, enabled: boolean) => Promise<void>;
    onStatusChanged: (
      cb: (payload: { id: string; status: 'running' | 'stopped' | 'error'; error?: string }) => void,
    ) => () => void;
    getDistStale: () => Promise<{ servers: string[]; command: string } | null>;
    onDistStale: (cb: (payload: { servers: string[]; command: string }) => void) => () => void;
  };
  scheduler: {
    list: () => Promise<ScheduledTask[]>;
    create: (
      task: Omit<ScheduledTask, 'id' | 'lastRun' | 'nextRun' | 'runCount' | 'scheduleError'>,
    ) => Promise<ScheduledTask | { error: string }>;
    update: (id: string, task: Partial<ScheduledTask>) => Promise<ScheduledTask | { error: string }>;
    delete: (id: string) => Promise<void>;
    pause: (id: string) => Promise<void>;
    resume: (id: string) => Promise<void>;
    getRuns: (taskId: string) => Promise<TaskRun[]>;
    reviewRun: (runId: number, status: 'validated' | 'rejected', note?: string) => Promise<void>;
    getPendingReviewCount: () => Promise<number>;
    getSessions: () => Promise<ChatSession[]>;
    deleteSession: (sessionId: string) => Promise<void>;
    cleanupSessions: () => Promise<void>;
    getActivities: (filters: ActivityFilters) => Promise<ActivityItem[]>;
    getActivityStats: (from: string, to: string) => Promise<ActivityStats>;
    getAllTags: () => Promise<string[]>;
  };
  tasks: {
    list: (filters?: PersonalTaskFilters) => Promise<PersonalTask[]>;
    get: (id: string) => Promise<PersonalTask>;
    create: (task: PersonalTaskInput) => Promise<PersonalTask>;
    update: (id: string, updates: Partial<PersonalTask>) => Promise<PersonalTask>;
    delete: (id: string) => Promise<void>;
    getCategories: () => Promise<string[]>;
    getPendingDueCount: () => Promise<number>;
  };
  memory: {
    getWorkingMemory: () => Promise<string>;
    updateWorkingMemory: (content: string) => Promise<void>;
    searchSemantic: (query: string, limit?: number) => Promise<SemanticMemory[]>;
    getDailySummaries: (from?: string, to?: string) => Promise<DailySummary[]>;
    triggerCompaction: (sessionId?: string) => Promise<ChatClearResult | undefined>;
  };
  logs: {
    query: (filters: LogFilters) => Promise<AuditEntry[]>;
    stream: (cb: (entry: AuditEntry) => void) => () => void;
    exportCSV: (filters: LogFilters) => Promise<string>;
    exportJSON: (filters: LogFilters) => Promise<string>;
    querySystem: (filters?: SystemLogFilters) => Promise<SystemLogQueryResult>;
    streamSystem: (cb: (entry: SystemLogEntry) => void) => () => void;
  };
  usage: {
    providerLimits: () => Promise<UsageLimitsResponse>;
  };
  tools: {
    getSettings: () => Promise<Record<string, boolean>>;
    setEnabled: (tool: string, enabled: boolean) => Promise<Record<string, boolean>>;
    getEnabled: () => Promise<string[]>;
    getBypass: () => Promise<boolean>;
    setBypass: (enabled: boolean) => Promise<boolean>;
    getTelegramArmed: () => Promise<boolean>;
    setTelegramArmed: (enabled: boolean) => Promise<boolean>;
  };
  settings: {
    get: () => Promise<AppSettings>;
    update: (settings: Partial<AppSettings>) => Promise<SettingsUpdateResult>;
    setApiKey: (key: string) => Promise<void>;
  };
  auth: {
    login: (password: string, totpCode?: string) => Promise<{ token: string }>;
    logout: () => Promise<void>;
    isAuthenticated: () => Promise<boolean>;
    isFirstRun: () => Promise<boolean>;
    setupPassword: (password: string) => Promise<void>;
    enableTOTP: () => Promise<{ secret: string; qrCode: string }>;
    verifyTOTP: (code: string) => Promise<boolean>;
    onLocked: (cb: () => void) => () => void;
  };
  codeburn: {
    spawn: (cols: number, rows: number) => Promise<{ ok: true } | { ok: false; error: string }>;
    write: (data: string) => Promise<void>;
    resize: (cols: number, rows: number) => Promise<void>;
    kill: () => Promise<void>;
    onData: (cb: (chunk: string) => void) => () => void;
    onExit: (cb: (info: { exitCode: number; signal: number | null }) => void) => () => void;
  };
  soul: {
    get: () => Promise<string>;
    update: (content: string) => Promise<boolean>;
  };
  user: {
    get: () => Promise<string>;
    update: (content: string) => Promise<boolean>;
  };
  rules: {
    getGlobal: () => Promise<string>;
    updateGlobal: (content: string) => Promise<void>;
    getAgent: (agentId: string) => Promise<string>;
    updateAgent: (agentId: string, content: string) => Promise<void>;
  };
  onboarding: {
    isCompleted: () => Promise<boolean>;
    markCompleted: () => Promise<void>;
    reset: () => Promise<void>;
  };
  vault: {
    list: () => Promise<
      Array<{
        key: string;
        label: string;
        description: string;
        service: string;
        required: boolean;
        configured: boolean;
        placeholder?: string;
        docsUrl?: string;
        status?: 'error';
        error?: string;
      }>
    >;
    set: (key: string, value: string) => Promise<void>;
    delete: (key: string) => Promise<void>;
    check: (key: string) => Promise<boolean>;
    health: () => Promise<{
      keytarDegraded: boolean;
      vaultCorruptBackupPath: string | null;
      unreadableKeys: Array<{ key: string; reason: string }>;
    }>;
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
    ) => Promise<{ ok: true } | { error: string }>;
  };
  higgsfield: {
    authStatus: () => Promise<{
      configured: boolean;
      localSession: boolean;
      authDir: string;
      wrapperPath: string;
      lastCapturedAt?: string;
    }>;
    connect: (options?: { force?: boolean }) => Promise<
      | {
          ok: true;
          status: {
            configured: boolean;
            localSession: boolean;
            authDir: string;
            wrapperPath: string;
            lastCapturedAt?: string;
          };
        }
      | {
          ok: false;
          error: string;
          status: {
            configured: boolean;
            localSession: boolean;
            authDir: string;
            wrapperPath: string;
            lastCapturedAt?: string;
          };
        }
    >;
    disconnect: () => Promise<{
      ok: true;
      status: {
        configured: boolean;
        localSession: boolean;
        authDir: string;
        wrapperPath: string;
        lastCapturedAt?: string;
      };
    }>;
  };
  provider: {
    testConnection: (
      providerName: string,
      baseUrl: string,
      apiKeyRef: string,
    ) => Promise<{ ok: true } | { ok: false; error: string }>;
    testOpenAiCompatible: (payload: {
      baseUrl: string;
      apiKey: string;
      preset?: OpenAiCompatiblePreset | 'custom';
    }) => Promise<{ ok: true; models: number } | { ok: false; error: string }>;
    listStatuses: (opts?: { refresh?: boolean }) => Promise<ProviderStatusEntry[] | { error: string }>;
    check: (payload: {
      runtime: OrchestratorRuntime;
      provider: OrchestratorProvider;
    }) => Promise<ProviderStatusEntry | { error: string }>;
    connect: (payload: {
      provider: OrchestratorProvider;
      apiKey?: string;
      baseUrl?: string;
      preset?: OpenAiCompatiblePreset | 'custom';
    }) => Promise<{ ok: true } | { error: string }>;
    disconnect: (payload: { provider: OrchestratorProvider }) => Promise<{ ok: true } | { error: string }>;
    testVertexAi: (payload: {
      apiKey?: string;
      model?: string;
    }) => Promise<{ ok: true; models?: number } | { ok: false; error: string }>;
  };
  image: {
    generate: (
      prompt: string,
      options?: { aspectRatio?: string },
    ) => Promise<{ base64: string; mimeType: string; prompt: string }>;
    edit: (
      prompt: string,
      imageBase64: string,
      imageMimeType: string,
      options?: { aspectRatio?: string },
    ) => Promise<{ base64: string; mimeType: string; prompt: string }>;
  };
  voice: {
    transcribe: (audioBase64: string) => Promise<string>;
    speak: (text: string, voiceId?: string) => Promise<{ base64: string; format: 'mp3' | 'opus' }>;
    speakLive: (
      text: string,
    ) => Promise<{ base64: string; format: 'mp3' | 'opus'; provider: 'elevenlabs' | 'cartesia' }>;
    speakCartesia: (text: string, voiceId?: string, language?: string) => Promise<{ base64: string; format: 'mp3' }>;
    readAudioFile: (path: string) => Promise<string>;
    listVoices: () => Promise<
      Array<{
        voice_id: string;
        name: string;
        category: string;
        labels: Record<string, string>;
        preview_url: string;
      }>
    >;
    listCartesiaVoices: (options?: { q?: string; language?: string; limit?: number }) => Promise<
      Array<{
        id: string;
        name: string;
        description: string;
        gender?: string;
        language?: string;
        country?: string;
        isOwner: boolean;
        isPublic: boolean;
        previewUrl?: string;
      }>
    >;
  };
  channels: {
    list: () => Promise<Channel[]>;
    get: (type: string) => Promise<Channel | null>;
    saveTelegram: (config: TelegramSaveConfig) => Promise<Channel>;
    toggle: (type: string, active: boolean) => Promise<void>;
    testTelegram: () => Promise<{
      success: boolean;
      error?: string;
      botUsername?: string;
      botName?: string;
    }>;
    telegramStatus: () => Promise<{ running: boolean }>;
  };

  google: {
    setup: (config: { clientId: string; clientSecret: string }) => Promise<{ success: boolean }>;
    authenticate: () => Promise<{
      success: boolean;
      error?: string;
      mcpStartFailures?: Array<{ id: string; error: string }>;
    }>;
    status: () => Promise<{
      hasCredentials: boolean;
      isAuthenticated: boolean;
    }>;
    revoke: () => Promise<{
      localCleared: boolean;
      remoteRevoked: boolean;
      warning?: 'REVOKE-UNCONFIRMED';
    }>;
  };
  ollama: {
    check: (baseUrl: string, model: string, provider?: string) => Promise<{ available: boolean; models: string[] }>;
    listModels: (provider: string, baseUrl: string) => Promise<{ models: string[]; error?: string }>;
  };
  knowledge: {
    upload: (payload: {
      agentId: string;
      filePath: string;
      config: {
        strategy: ChunkStrategy;
        chunkSize: number;
        chunkOverlap: number;
        title?: string;
      };
    }) => Promise<KnowledgeSource>;
    reprocess: (payload: {
      sourceId: string;
      strategy: ChunkStrategy;
      chunkSize: number;
      chunkOverlap: number;
    }) => Promise<KnowledgeSource>;
    delete: (payload: { sourceId: string }) => Promise<{ success: boolean }>;
    list: (payload: { agentId: string }) => Promise<KnowledgeSource[]>;
    search: (payload: { agentId: string; query: string }) => Promise<KBSearchResult>;
    benchmark: {
      start: (payload: {
        sourceIds: string[];
        agentId: string;
        config: {
          totalQuestions: number;
          modelJudge: 'sonnet' | 'opus';
          threshold: number;
        };
      }) => Promise<{ benchmarkId: string }>;
      status: (payload: { benchmarkId: string }) => Promise<{
        status: string;
        progress: number;
        currentStage: string;
        result?: BenchmarkResult;
      }>;
    };
    config: {
      get: (payload: { agentId: string }) => Promise<KnowledgeAgentConfig>;
      update: (payload: { agentId: string; config: Partial<KnowledgeAgentConfig> }) => Promise<KnowledgeAgentConfig>;
    };
    onIngestionProgress: (cb: (data: IngestionProgress) => void) => () => void;
    onBenchmarkProgress: (cb: (data: BenchmarkProgress) => void) => () => void;
  };
  harness: {
    createProject: (data: {
      name: string;
      description?: string;
      projectPath: string;
      specText?: string;
      specFilePath?: string;
      config: HarnessConfig;
    }) => Promise<{ projectId: string } | { error: string }>;
    plan: (projectId: string) => Promise<void | { error: string }>;
    approveSprints: (projectId: string) => Promise<void | { error: string }>;
    regenerateSprints: (projectId: string, feedback: string) => Promise<void | { error: string }>;
    run: (projectId: string) => Promise<void | { error: string }>;
    pause: (projectId: string) => Promise<void | { error: string }>;
    resume: (projectId: string) => Promise<{ ok: true } | { ok: false; message: string } | { error: string }>;
    resumeAfterAuth: (
      projectId: string,
      provider: 'grok' | 'codex' | 'kimi',
    ) => Promise<{ ok: true } | { ok: false; message: string } | { error: string }>;
    abort: (projectId: string) => Promise<void | { error: string }>;
    deleteProject: (projectId: string) => Promise<void>;
    getProject: (projectId: string) => Promise<HarnessProject | null>;
    listProjects: () => Promise<HarnessProject[]>;
    getSprints: (projectId: string) => Promise<HarnessSprint[]>;
    getSprintJson: (projectId: string, sprintJsonId: string) => Promise<SprintJsonDetail | null>;
    getSprintsJson: (projectId: string) => Promise<unknown>;
    getRounds: (sprintId: string) => Promise<HarnessRound[]>;
    getEvaluation: (projectId: string, sprintId: string) => Promise<EvaluationResult | null>;
    getMetrics: (projectId: string) => Promise<HarnessProjectMetrics>;
    getStreamLog: (
      projectId: string,
      sprintId: string,
    ) => Promise<{
      coder: { type: string; content?: string; tool?: string }[];
      evaluator: { type: string; content?: string; tool?: string }[];
      round: number;
    }>;
    getFeedbackAudit: (
      projectId: string,
      sprintId: string,
    ) => Promise<
      {
        timestamp: string;
        round: number;
        evaluatorVerdict: string;
        evaluatorSummary: string;
        failedCriteria: { description: string; justification: string }[];
        feedbackInjectedIntoCoder: string;
      }[]
    >;
    onProjectUpdate: (cb: (data: Record<string, unknown>) => void) => () => void;
    onSprintUpdate: (cb: (data: Record<string, unknown>) => void) => () => void;
    onAgentStream: (cb: (data: Record<string, unknown>) => void) => () => void;
    onMetricsUpdate: (cb: (data: Record<string, unknown>) => void) => () => void;
    onPlanningDone: (cb: (data: Record<string, unknown>) => void) => () => void;
    onError: (cb: (data: Record<string, unknown>) => void) => () => void;
  };
  mgraph: {
    graph: () => Promise<GraphData>;
    read: (path: string) => Promise<string>;
    search: (query: string) => Promise<MgraphSearchResult[]>;
    seed: (forceReseed?: boolean) => Promise<{ notes: number; connections: number } | { error: string }>;
    stats: () => Promise<MgraphStats>;
    listNotes: (type: string) => Promise<NoteListItem[]>;
    deleteNote: (
      notePath: string,
      options?: { force?: boolean },
    ) => Promise<{
      success: boolean;
      backlinks?: BacklinkResult[];
      error?: string;
    }>;
    noteBacklinks: (notePath: string) => Promise<BacklinkResult[]>;
    onSeedProgress: (cb: (data: { processed: number; total: number; notesCreated: number }) => void) => () => void;
    onUpdated: (cb: () => void) => () => void;
    ingestFile: (filePath: string, fileName: string) => Promise<IngestJob | { error: string }>;
    ingestUrl: (url: string) => Promise<IngestJob>;
    ingestText: (text: string, title?: string) => Promise<IngestJob>;
    ingestResume: (jobId: string) => Promise<IngestJob | { error: string }>;
    ingestHistory: () => Promise<IngestJob[]>;
    ingestCancel: (jobId: string) => Promise<void>;
    ingestEstimate: (filePath: string) => Promise<IngestEstimate | { error: string }>;
    ingestDiscard: (jobId: string) => Promise<void>;
    ingestAccept: (jobId: string) => Promise<void>;
    ingestSettings: () => Promise<IngestSettings>;
    ingestSettingsUpdate: (settings: Record<string, string>) => Promise<void>;
    onIngestProgress: (cb: (data: IngestJob) => void) => () => void;
  };
  shell: {
    showInFolder: (filePath: string) => Promise<void>;
    openPath: (dirPath: string) => Promise<void>;
    openFile: (filePath: string) => Promise<{ ok: true } | { error: string }>;
    selectDirectory: () => Promise<string | null>;
  };
  artifact: {
    getState: (storageKey: string) => Promise<{ state: unknown } | { error: string }>;
    setState: (storageKey: string, state: unknown) => Promise<{ ok: true } | { error: string }>;
  };
  utils: {
    getPathForFile: (file: File) => string;
  };
  enrich: {
    start: (config: CreateEnrichConfig) => Promise<{ sessionId: string } | { error: string }>;
    send: (sessionId: string, message: string) => Promise<{ ok: true } | { error: string }>;
    approvePhase: (sessionId: string) => Promise<{ ok: true } | { error: string }>;
    resumeAfterAuth: (
      sessionId: string,
      provider?: 'grok' | 'codex' | 'kimi',
    ) => Promise<{ ok: true } | { error: string }>;
    finalize: (sessionId: string) => Promise<{ ok: true; finalSpecPath: string } | { error: string }>;
    abort: (sessionId: string) => Promise<{ ok: true } | { error: string }>;
    delete: (sessionId: string) => Promise<{ ok: true } | { error: string }>;
    getSpec: (sessionId: string) => Promise<{ finalSpecPath: string | null } | { error: string }>;
    listSessions: () => Promise<EnrichSession[]>;
    getMessages: (sessionId: string, phase?: string) => Promise<EnrichMessage[]>;
    openSpec: (sessionId: string) => Promise<{ ok: true } | { error: string }>;
    onStream: (cb: (chunk: unknown) => void) => () => void;
    onMetrics: (cb: (data: unknown) => void) => () => void;
    onStatus: (cb: (status: unknown) => void) => () => void;
  };
  pipeline: {
    start: (projectId: string, startPhase: number) => Promise<{ ok: true } | { error: string }>;
    advance: (projectId: string) => Promise<{ ok: true } | { error: string }>;
    abort: (projectId: string) => Promise<{ ok: true } | { error: string }>;
    pause: (projectId: string) => Promise<{ ok: true } | { error: string }>;
    resume: (projectId: string) => Promise<{ ok: true } | { error: string }>;
    send: (projectId: string, message: string, attachments?: ChatAttachment[]) => Promise<PipelineSendResult>;
    getConversationPhases: () => Promise<PipelineConversationPhases>;
    approve: (projectId: string, metadata?: Record<string, unknown>) => Promise<{ ok: true } | { error: string }>;
    decided: (projectId: string, blockId: string) => Promise<{ ok: true } | { error: string }>;
    conclude: (projectId: string) => Promise<{ ok: true } | { error: string }>;
    retry: (projectId: string) => Promise<{ ok: true } | { error: string }>;
    confirmDevelopment: (projectId: string) => Promise<{ ok: true } | { error: string }>;
    createProject: (data: {
      name: string;
      description: string;
      projectPath: string;
      startPhase: number;
      specPath?: string;
      prdPath?: string;
      pipelineType?: string;
    }) => Promise<{ id: string } | { error: string }>;
    getSecurityAgentStatus: (projectId: string) => Promise<SecurityAgentStatus[]>;
    getAuditAgentsState: (projectId: string) => Promise<PipelineAuditAgentsStateResponse>;
    deleteProject: (projectId: string) => Promise<{ ok: true } | { error: string }>;
    listProjects: () => Promise<PipelineProject[]>;
    getProject: (projectId: string) => Promise<PipelineProject | { error: string }>;
    getPhaseMessages: (projectId: string, phase: number) => Promise<PipelineMessage[]>;
    readPhaseDocument: (
      projectId: string,
      phase: number,
    ) => Promise<{ path: string; content: string } | { error: string }>;
    getMetrics: (projectId: string) => Promise<PipelineMetricsResult | { error: string }>;
    getReport: (projectId: string) => Promise<{ report: string } | { error: string }>;
    exportReport: (projectId: string, format: 'md') => Promise<{ ok: true; reportPath: string } | { error: string }>;
    openProjectFile: (projectId: string, relativePath: string) => Promise<{ ok: true } | { error: string }>;
    openSmokeTest: (projectId: string) => Promise<{ ok: true } | { error: string }>;
    getSmokeTestPath: (projectId: string) => Promise<{ exists: boolean; path?: string }>;
    onStream: (cb: (chunk: PipelineStreamChunk) => void) => () => void;
    onPhaseChanged: (cb: (event: PipelinePhaseChangedEvent) => void) => () => void;
    onProjectUpdated: (cb: (event: PipelineProjectUpdatedEvent) => void) => () => void;
    onNotesUpdated: (cb: (event: PipelineNotesUpdatedEvent) => void) => () => void;
    onMessagesUpdated: (cb: (data: { projectId: string; phase: number }) => void) => () => void;
    onSprintComplete: (cb: (event: PipelineSprintCompleteEvent) => void) => () => void;
    onSprintUpdated: (cb: (data: { sprintIndex: number; status: string; round: number }) => void) => () => void;
    onAgentCompleted: (cb: (data: { projectId: string }) => void) => () => void;
    onDocumentUpdated: (cb: (data: { projectId: string; path: string; content: string }) => void) => () => void;
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
    ) => () => void;
    onSprintRound: (
      cb: (data: { projectId: string; sprintIndex: number; round: number; agent: string }) => void,
    ) => () => void;
    resetPhase: (projectId: string, phase: number) => Promise<{ ok: boolean; error?: string }>;
    resetSprint: (projectId: string, sprintIndex: number) => Promise<{ ok: boolean; error?: string }>;
    getResetPreview: (
      projectId: string,
      target: { phase?: number; sprintIndex?: number },
    ) => Promise<{
      filesToDelete: string[];
      messagesToDelete: number;
      metricsToDelete: number;
      sprintsAffected: number[];
    }>;
    readPhaseArtifact: (projectId: string, phase: number) => Promise<PipelinePhaseArtifact>;
    getSprintHistory: (projectId: string, sprintIndex: number) => Promise<PipelineSprintMessage[]>;
    listSprints: (projectId: string) => Promise<HarnessSprint[]>;
    getSprintDetail: (projectId: string, sprintIndex: number) => Promise<{ sprint: HarnessSprint } | { error: string }>;
    onResetComplete: (cb: (data: { projectId: string; phase?: number; sprintIndex?: number }) => void) => () => void;
    onSecurityAgentStatus: (
      cb: (data: {
        projectId: string;
        agentId: string;
        agentName: string;
        status: 'pending' | 'running' | 'completed' | 'failed';
        findingsCount?: number;
        error?: string;
      }) => void,
    ) => () => void;
    onAuditAgentProgress: (cb: (event: import('./pipeline').PipelineAuditAgentProgressEvent) => void) => () => void;
    onResolutionTrackerComplete: (cb: (data: { projectId: string }) => void) => () => void;
    readManifest: (projectId: string) => Promise<import('./pipeline').RepoManifest | null>;
    onManifest: (cb: (data: { projectId: string; manifest: import('./pipeline').RepoManifest }) => void) => () => void;
    onStalled: (
      cb: (data: {
        projectId: string;
        phase: number;
        agentId: string;
        lastChunkAt: number;
        secondsSinceLastChunk: number;
      }) => void,
    ) => () => void;
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
    ) => () => void;
    resumeAfterAuth: (
      projectId: string,
      provider?: 'codex' | 'grok' | 'kimi',
    ) => Promise<{ ok: true } | { ok: false; message: string }>;
  };
  drive: {
    getState: (projectId: string) => Promise<DriveState | null>;
    start: (
      projectId: string,
      mode: 'semi' | 'full',
      sessionId: string,
    ) => Promise<{ ok: true; drive: DriveState; sessionId: string } | { error: string; code?: ChatLaneErrorCode }>;
    assumir: (projectId: string) => Promise<{ ok: true; drive: DriveState } | { error: string }>;
    stop: (projectId: string) => Promise<{ ok: true } | { error: string }>;
    resume: (
      projectId: string,
      sessionId: string,
    ) => Promise<{ ok: true; drive: DriveState; sessionId: string } | { error: string; code?: ChatLaneErrorCode }>;
    setMode: (projectId: string, mode: 'semi' | 'full') => Promise<{ ok: true; drive: DriveState } | { error: string }>;
    onStateChanged: (cb: (payload: DriveStateChangedEvent) => void) => () => void;
  };
  dialog: {
    openFile: (filters?: Array<{ name: string; extensions: string[] }>) => Promise<string | null>;
    openDirectory: () => Promise<string | null>;
  };
  codex: {
    status: () => Promise<{
      installed: boolean;
      version: string | null;
      authenticated: boolean;
      appServerSupported: boolean;
      error?: string;
    }>;
    test: () => Promise<{ ok: boolean; message: string }>;
    openLogin: () => Promise<{ ok: boolean }>;
    setBinaryPath: (path: string) => Promise<{ ok: boolean }>;
    listModelCapabilities: () => Promise<{
      state: 'uninitialized' | 'ready' | 'probe-failed';
      capabilities: Array<{
        id: string;
        displayName: string;
        description: string;
        supportedEfforts: readonly CodexChatReasoningEffort[];
        defaultEffort: CodexChatReasoningEffort;
        hidden: boolean;
      }> | null;
    }>;
    checkPrepNeeded: (projectPath: string) => Promise<CodexPrepCheckResult>;
    applyPrep: (repoRoot: string) => Promise<CodexPrepApplyResult>;
    grantSkipConsent: (repoRoot: string) => Promise<{ ok: boolean; error?: string }>;
    onWindowsHealthWarning: (handler: (payload: CodexWindowsHealthWarning) => void) => () => void;
    onPatchFailureWarning: (handler: (payload: CodexPatchFailureWarning) => void) => () => void;
    onWindowsPrepSkipped: (handler: (payload: CodexWindowsPrepSkipped) => void) => () => void;
  };
  kimi: {
    status: () => Promise<KimiAvailability>;
    test: () => Promise<{ ok: boolean; message: string }>;
    openLogin: () => Promise<{ ok: boolean; url?: string }>;
    setBinaryPath: (path: string) => Promise<{ ok: boolean }>;
  };
  grok: {
    status: () => Promise<{
      installed: boolean;
      version: string | null;
      authenticated: boolean;
      authMode?: 'subscription' | 'none';
      subscriptionRouteVerified: boolean;
      isolationVerified: boolean;
      toolPolicyVerified: boolean;
      modelAvailable: boolean | null;
      usable: boolean;
      binaryPath: string;
      home?: string;
      error?: string;
      reason?: string;
    }>;
    test: () => Promise<{ ok: boolean; message: string }>;
    openLogin: () => Promise<{ ok: boolean; url?: string; userCode?: string; error?: string }>;
    logout: () => Promise<{ ok: boolean; error?: string }>;
    setBinaryPath: (path: string) => Promise<{ ok: boolean }>;
  };
  terminal: {
    open: (sessionId: string, cols: number, rows: number) => Promise<{ ok: true } | { ok: false; error: string }>;
    write: (sessionId: string, data: string) => Promise<void>;
    resize: (sessionId: string, cols: number, rows: number) => Promise<void>;
    close: (sessionId: string) => Promise<void>;
    onData: (cb: (payload: { sessionId: string; chunk: string }) => void) => () => void;
    onExit: (cb: (payload: { sessionId: string; exitCode: number }) => void) => () => void;
  };
  claudeCli: {
    status: () => Promise<{
      installed: boolean;
      version: string | null;
      authenticated: boolean;
      authMode: 'oauth' | 'api-key' | 'none';
      resolvedPath: string;
    }>;
    test: () => Promise<{ ok: boolean; message: string }>;
    openLogin: () => Promise<{ ok: boolean }>;
    setBinaryPath: (path: string) => Promise<{ ok: boolean }>;
  };
  openDesign: {
    preflight: (projectId: string) => Promise<import('./open-design').PreflightResult>;
    setup: (projectId: string, config: Record<string, unknown>) => Promise<{ ok: true } | { error: string }>;
    start: (projectId: string) => Promise<{ ok: true; daemonUrl: string; webUrl: string } | { error: string }>;
    stop: (projectId: string) => Promise<{ ok: true } | { error: string }>;
    restart: (projectId: string) => Promise<{ ok: true; daemonUrl: string; webUrl: string } | { error: string }>;
    status: (projectId: string) => Promise<
      | {
          running: boolean;
          daemonUrl: string | null;
          webUrl: string | null;
          daemonPort: number | null;
          webPort: number | null;
        }
      | { error: string }
    >;
    buildInitialPrompt: (projectId: string) => Promise<{ error: string }>;
    injectInitialPrompt: (projectId: string) => Promise<{ error: string }>;
    snapshot: (projectId: string) => Promise<{ error: string }>;
    getLockedSnapshot: (projectId: string) => Promise<{ error: string }>;
    readLockedHtml: (projectId: string) => Promise<{ ok: true; html: string; htmlPath: string } | { error: string }>;
    destructiveUnlock: (projectId: string, confirmation: string) => Promise<{ ok: true } | { error: string }>;
    openArtifact: (projectId: string) => Promise<{ error: string }>;
    setViewBounds: (bounds: {
      x: number;
      y: number;
      width: number;
      height: number;
    }) => Promise<{ ok: true } | { error: string }>;
    showView: (
      url: string,
      bounds: { x: number; y: number; width: number; height: number },
    ) => Promise<{ ok: true } | { error: string }>;
    hideView: () => Promise<{ ok: true } | { error: string }>;
    bootInstallStatus: () => Promise<import('./open-design').BootInstallStatus>;
    bootInstallRetry: () => Promise<import('./open-design').BootInstallStatus>;
    onBootInstallStream: (handler: (event: import('./open-design').BootInstallStreamEvent) => void) => () => void;
    onBootstrapProgress: (
      handler: (event: import('./open-design').OpenDesignBootstrapProgressEvent) => void,
    ) => () => void;
    getSessionConfig: (projectId: string) => Promise<import('./open-design').OpenDesignSessionConfig | null>;
    setSessionConfig: (
      projectId: string,
      cfg: import('./open-design').OpenDesignSessionConfig,
    ) => Promise<{ ok: true } | { error: string }>;
    ensureSession: (projectId: string) => Promise<import('./open-design').OpenDesignEnsureResult>;
    getStartStatus: (projectId: string) => Promise<import('./open-design').OpenDesignStartStatus>;
  };
  pricing: {
    calculate: (input: {
      runtime: OrchestratorRuntime;
      provider: OrchestratorProvider;
      model: string;
      presetId?: OpenAiCompatiblePreset | string;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens?: number;
      cacheCreationTokens?: number;
    }) => Promise<{ costUsd: number | null }>;
  };
  dynamicWorkflow: DynamicWorkflowAPI;
  swarm: import('./swarm').SwarmAPI;
}

export interface PipelineConversationPhases {
  security: number[];
  dev: number[];
  feature: number[];
  architecture: number[];
  developmentV2: number[];
  bug: number[];
}

export type PipelineSendResult =
  { ok: true; resumedInSessionId?: string; laneBadge?: number | null } | { error: string; code?: string };

export type PipelinePhaseArtifact =
  | { type: 'markdown'; content: string }
  | { type: 'sprints'; sprints: HarnessSprint[] }
  | {
      type: 'architecture';
      phase: number;
      markdown: string | null;
      json: string | null;
    }
  | { error: string };

export type CodexWindowsIssueType = 'autocrlf-true' | 'no-gitattributes' | 'mixed-line-endings' | 'powershell-5.1';

export interface CodexWindowsIssue {
  type: CodexWindowsIssueType;
  severity: 'low' | 'medium' | 'high';
  message: string;
  hint: string;
}

export interface CodexPrepCheckResult {
  needs: boolean;
  reason:
    | 'not-windows'
    | 'not-git-repo'
    | 'codex-not-authenticated'
    | 'no-codex-agents'
    | 'no-issues'
    | 'consent-current'
    | 'consent-skip-current'
    | 'needs-dialog';
  repoRoot?: string;
  issues?: CodexWindowsIssue[];
  consent?: {
    repoRoot: string;
    prepVersion: number;
    action: 'prepared' | 'skip';
    consentedAt: number;
    lastAppliedAt: number | null;
  } | null;
}

export type CodexPrepApplyResult =
  | { applied: true; filesAffected: number }
  | {
      applied: false;
      reason: 'not-windows' | 'no-git-repo' | 'has-submodules' | 'dirty-tree' | 'error';
      message?: string;
    };

export interface CodexWindowsHealthWarning {
  projectId?: string;
  agentId: string;
  cwd: string;
  repoRoot: string;
  timestamp: number;
  issues: CodexWindowsIssue[];
}

export interface CodexPatchFailureWarning {
  projectId?: string;
  agentId: string;
  cwd: string;
  count: number;
  samples: Array<{ source: string; text: string; ts: number }>;
  timestamp: number;
}

export interface CodexWindowsPrepSkipped {
  projectId?: string;
  repoRoot: string;
  reason: string;
  timestamp: number;
}

declare global {
  interface Window {
    lionclaw: LionClawAPI;
  }
}

export type ChunkStrategy = 'recursive' | 'semantic' | 'page' | 'csv' | 'agentic';

export interface KnowledgeSource {
  id: string;
  agentId: string;
  fileName: string;
  fileType: string;
  fileSize: number;
  filePath: string;
  title?: string;
  description?: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  chunksCount: number;
  chunkStrategy: string;
  chunkSize: number;
  chunkOverlap: number;
  qualityScore?: number;
  bestStrategy?: string;
  errorMessage?: string;
  createdAt: string;
  processedAt?: string;
  updatedAt: string;
}

export interface KnowledgeAgentConfig {
  agentId: string;
  hydeEnabled: boolean;
  hydeThreshold: number;
  minScore: number;
  defaultStrategy: ChunkStrategy;
  rerankEnabled: boolean;
  rerankTopK: number;
  searchTopK: number;
}

export interface KBSearchResult {
  found: boolean;
  degraded?: boolean;
  degradedReason?: string;
  strategy: 'hybrid_direct' | 'hyde_hybrid' | 'hybrid_fallback' | 'not_found';
  results: Array<{
    chunk_id: string;
    source_id: string;
    source_name: string;
    content: string;
    rerank_score: number;
    chunk_index: number;
    token_count: number;
    metadata: Record<string, unknown>;
  }>;
  query_used: string;
  latency_ms: number;
}

export interface BenchmarkResult {
  benchmark_id: string;
  winner: string;
  winner_score: number;
  execution_time_s: number;
  questions: string[];
  strategies: Record<
    string,
    Record<
      string,
      {
        avg_score: number;
        true_rate: number;
        llm_judge_avg: number;
        raw_scores: number[];
      }
    >
  >;
}

export interface IngestionProgress {
  sourceId: string;
  stage: 'parsing' | 'chunking' | 'embedding' | 'indexing' | 'completed' | 'failed';
  progress: number;
}

export interface BenchmarkProgress {
  benchmarkId: string;
  stage: string;
  strategy?: string;
  mode?: string;
  current: number;
  total: number;
  done?: boolean;
}

export type EnrichPhase = 'validator' | 'enricher' | 'done';
export type EnrichStatus = 'idle' | 'running' | 'paused' | 'waiting' | 'finalizing' | 'done';

export interface EnrichMetrics {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  durationMs: number;
  toolUses: number;
  apiRequests: number;
  messages: number;
  costStatus?: 'known' | 'unknown' | 'estimated-partial';
  tokenStatus?: 'reported' | 'not_reported';
  costUnknownReason?: string;
  costSource?: string;
  costEstimationKind?: 'subscription-equivalent-payg';
  unknownCostCount?: number;
  usageMetadata?: Record<string, unknown>;
  costByRuntime?: Record<string, number>;
  subscriptionEquivalentCost?: number;
}

export interface EnrichSession {
  id: string;
  name: string;
  specPath: string;
  projectPath?: string;
  prdPath?: string;
  userMessage?: string;
  validatorAgentId: string;
  enricherAgentId: string;
  phase: EnrichPhase;
  status: EnrichStatus;
  finalSpecPath?: string;
  validatorMetrics: EnrichMetrics;
  enricherMetrics: EnrichMetrics;
  createdAt: string;
  updatedAt: string;
}

export interface CreateEnrichConfig {
  name: string;
  specPath: string;
  projectPath?: string;
  prdPath?: string;
  message?: string;
  validatorAgentId: string;
}

export interface EnrichStatusEvent {
  sessionId: string;
  phase: EnrichPhase;
  status: EnrichStatus;
}

export interface EnrichMetricsEvent {
  sessionId: string;
  phase: EnrichPhase;
  metrics: EnrichMetrics;
}

export interface EnrichMessage {
  id: number;
  sessionId: string;
  phase: EnrichPhase;
  role: 'user' | 'assistant';
  content: string;
  toolCalls: Array<{ tool: string; input: unknown }> | null;
  createdAt: string;
}

export interface IngestJob {
  id: string;
  fileName: string;
  sourceType: string;
  originalPath?: string;
  fileHash?: string;
  status: 'extracting' | 'estimating' | 'waiting_confirm' | 'processing' | 'completed' | 'failed' | 'partial';
  totalChunks: number;
  processedChunks: number;
  lastProcessedChunk: number;
  notesCreated: number;
  notesUpdated: number;
  estimatedCostUsd?: number;
  truncated?: boolean;
  originalChunkCount?: number;
  error?: string;
  startedAt: string;
  completedAt?: string;
  createdNotePaths?: string[];
}

export interface IngestEstimate {
  totalChunks: number;
  estimatedTokens: number;
  estimatedCostUsd: number;
  requiresConfirmation: boolean;
  truncated: boolean;
  originalChunkCount: number;
}

export interface IngestSettings {
  visionModel: string;
  extractionModel: string;
  sttProvider: 'elevenlabs' | 'whisper';
  maxFileSizeMb: number;
  maxChunks: number;
  autoConfirm: boolean;
  pdfExtractor: 'auto' | 'pdfjs' | 'vision';
  urlLevel: 1 | 2 | 3;
}

export interface NoteListItem {
  path: string;
  title: string;
  type: string;
  tags: string[];
  snippet: string;
  updatedAt: string;
}

export interface BacklinkResult {
  path: string;
  title: string;
  linkContext: string;
}

export interface VaultOperation {
  action: 'create' | 'update';
  path: string;
  type: 'entity' | 'meeting' | 'decision' | 'project' | 'reference';
  title: string;
  tags: string[];
  content: string;
  append?: boolean;
}

export interface MgraphSearchResult {
  path: string;
  title: string;
  type: string;
  snippet: string;
}

export interface MgraphStats {
  totalNotes: number;
  totalConnections: number;
  lastUpdated: string;
  notesByType: Record<string, number>;
}

export interface GraphNode {
  id: string;
  title: string;
  type: string;
  tags: string[];
  connections: number;
}

export interface GraphEdge {
  source: string;
  target: string;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface HarnessProject {
  id: string;
  name: string;
  description?: string;
  projectPath: string;
  specPath: string;
  sprintsJsonPath?: string;
  status:
    'idle' | 'planning' | 'reviewing' | 'ready' | 'running' | 'paused' | 'done' | 'failed' | 'aborted' | 'interrupted';
  config: HarnessConfig;
  currentSprintIndex: number;
  totalSprints: number;
  totalFeatures: number;
  plannerInputTokens: number;
  plannerOutputTokens: number;
  plannerCacheTokens: number;
  plannerCostUsd: number;
  plannerDurationMs: number;
  plannerUnknownCostCount?: number;
  createdAt: string;
  updatedAt: string;
  pipelineType?: import('./pipeline').PipelineType;
  pipelineDocsId?: string | null;
  pipelineCurrentPhase?: number | null;
  pipelineStartPhase?: number | null;
  pipelineSprintIndex?: number;
  pipelineDiscoveryBlock?: number;
  prdPath?: string;
  discoveryNotesPath?: string;
  securitySummaryJson?: string | null;
}

export interface HarnessConfig {
  maxRoundsPerSprint: number;
  usePlaywright: boolean;
  evaluatorAgentId: string;
  plannerAgentId: string;
  stack: string[];
  plannerOutputFormat?: 'json' | 'markdown';
  architectureReview?: {
    runId?: string;
    selectedCandidateId?: string | null;
  };
  bug?: {
    runId?: string;
    outcome?: 'pending' | 'fix' | 'no-bug';
  };
  openDesign?: import('./open-design').OpenDesignConfig;
  drive?: DriveState;
  sprintJsonHashes?: Record<string, string>;
  metricsQuality?: {
    plannerCostStatus?: 'known' | 'unknown' | 'estimated-partial';
    plannerTokenStatus?: 'reported' | 'not_reported';
    plannerCostUnknownReasons?: string[];
    plannerSubscriptionEquivalentCostUsd?: number;
  };
  providerAuthCheckpoint?: HarnessProviderAuthCheckpoint;
}

export interface HarnessProviderAuthCheckpoint {
  checkpointId: string;
  pauseReason: 'provider-auth';
  provider: 'codex' | 'grok' | 'kimi';
  ownerKind: 'harness' | 'pipeline';
  phaseNumber: number;
  agentId: string;
  roundId?: string;
  claimState?: 'pending' | 'claimed';
  resume: unknown;
}

export interface DriveState {
  driver: 'orchestrator' | 'human';
  status: 'driving' | 'awaiting-human' | 'stopped';
  handoff: 'none' | 'temporary' | 'permanent';
  mode: 'semi' | 'full';
  sessionId?: string;
  requiresHumanPhases: number[];
  startedAt?: string;
  stoppedReason?: string;
  rebindFrom?: string;
  lastEscalation?: string;
}

export interface DriveStateChangedEvent {
  projectId: string;
  drive: DriveState | null;
  sessionId: string | null;
  laneBadge: number | null;
}

export interface HarnessSprint {
  id: string;
  projectId: string;
  sprintIndex: number;
  sprintJsonId: string;
  name: string;
  status: 'pending' | 'running' | 'passed' | 'rejected' | 'failed' | 'interrupted' | 'skipped';
  verdict?: string | null;
  coderAgentId?: string;
  evaluatorAgentId?: string;
  roundsUsed: number;
  maxRounds: number;
  startedAt?: string;
  completedAt?: string;
  updatedAt?: string;
}

export interface SprintJsonDetail {
  id: string;
  index: number;
  name: string;
  description: string;
  coder_agent_id: string;
  stack: string[];
  features: {
    id: string;
    name: string;
    description: string;
    acceptance_criteria: string[];
  }[];
  hints: {
    existing_files: string[];
    key_interfaces: string[];
    architecture_notes: string;
  };
  dependencies: string[];
  complexity: 'low' | 'medium' | 'high';
  estimated_rounds: number;
}

export type CostSource = 'sdk_anthropic' | 'reported' | 'calculated' | 'fallback_zero';

export interface HarnessRound {
  id: string;
  sprintId: string;
  roundNumber: number;
  coderSessionId?: string;
  coderInputTokens: number;
  coderOutputTokens: number;
  coderCacheTokens: number;
  coderCostUsd: number;
  coderDurationMs: number;
  coderToolUses: number;
  coderApiRequests: number;
  evaluatorSessionId?: string;
  evaluatorInputTokens: number;
  evaluatorOutputTokens: number;
  evaluatorCacheTokens: number;
  evaluatorCostUsd: number;
  evaluatorDurationMs: number;
  evaluatorToolUses: number;
  evaluatorApiRequests: number;
  verdict?: 'pass' | 'fail';
  feedbackSummary?: string;
  startedAt: string;
  completedAt?: string;
  costSource?: CostSource | null;
  runtimeUsed?: 'cloud' | 'local' | 'external' | 'codex' | 'zai' | 'minimax-tp' | 'kimi' | 'grok' | 'cursor' | null;
  providerUsed?: string | null;
  modelUsed?: string | null;
  metadata?: Record<string, unknown>;
  costStatus?: 'known' | 'unknown' | 'estimated-partial';
  subscriptionEquivalentCost?: number;
  codexPatchFailures?: number;
  unknownCostCount?: number;
}

export interface HarnessProjectMetrics {
  totalCost: number;
  totalDuration: number;
  totalRounds: number;
  totalTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalApiRequests: number;
  passRate: number;
  coderCost: number;
  evaluatorCost: number;
  plannerCost: number;
  subscriptionEquivalentCost: number;
  coderSubscriptionEquivalentCost: number;
  evaluatorSubscriptionEquivalentCost: number;
  plannerSubscriptionEquivalentCost: number;
  subagentSubscriptionEquivalentCost: number;
  sprintMetrics: SprintMetrics[];
  costStatus?: 'known' | 'unknown' | 'estimated-partial';
  tokenStatus?: 'reported' | 'not_reported';
  costUnknownReasons?: string[];
  unknownCostCount?: number;
}

export interface SprintMetrics {
  sprintId: string;
  name: string;
  rounds: number;
  coderCost: number;
  evaluatorCost: number;
  totalCost: number;
  subscriptionEquivalentCost: number;
  coderSubscriptionEquivalentCost: number;
  evaluatorSubscriptionEquivalentCost: number;
  coderInputTokens: number;
  coderOutputTokens: number;
  evaluatorInputTokens: number;
  evaluatorOutputTokens: number;
  duration: number;
  verdict: 'passed' | 'failed';
  unknownCostCount?: number;
  costStatus?: 'known' | 'unknown' | 'estimated-partial';
  tokenStatus?: 'reported' | 'not_reported';
  costUnknownReasons?: string[];
}

export interface EvaluationResult {
  sprintId: string;
  round: number;
  verdict: 'pass' | 'fail';
  criteria: EvaluationCriterion[];
  summary: string;
  timestamp: string;
}

export interface EvaluationCriterion {
  id: string;
  featureId: string;
  description: string;
  result: 'pass' | 'fail';
  justification: string;
}

export interface ChatFeatureToggles {
  pipelineControl: boolean;
  dynamicWorkflows: boolean;
  swarm?: boolean;
}

export const CHAT_CAPABILITIES_LEGACY_ON: Readonly<ChatFeatureToggles> = Object.freeze({
  pipelineControl: true,
  dynamicWorkflows: true,
  swarm: false,
});

export const CHAT_CAPABILITIES_DEFAULT_OFF: Readonly<ChatFeatureToggles> = Object.freeze({
  pipelineControl: false,
  dynamicWorkflows: false,
  swarm: false,
});

export type ChatFeatureTogglesErrorCode =
  'session_not_found' | 'session_not_desktop' | 'session_not_active' | 'invalid_patch' | 'internal_error';

export type ChatFeatureTogglesResult =
  { ok: true; toggles: ChatFeatureToggles } | { ok: false; code: ChatFeatureTogglesErrorCode; error: string };
