import type { IpcContext } from './context';
import { registerChatHandlers } from './chat'; // chat:* + codeburn:*
import { registerAgentsHandlers } from './agents'; // agents + skills + mcp + mcp-discovery
import { registerSchedulerHandlers } from './scheduler'; // scheduler + activity board + tasks
import { registerSystemHandlers } from './system'; // logs + memory + tools + auth + identity + onboarding + shell + dialog
import { registerSettingsHandlers } from './settings'; // settings:* (get/update/set-api-key)
import { registerIntegrationsHandlers } from './integrations'; // vault + higgsfield + image + voice + google + channels
import { registerLocalLlmHandlers } from './local-llm'; // ollama:* (provider:* no barrel)
import { registerCodexHandlers } from './codex';
import { registerKimiHandlers } from './kimi'; // kimi:* (SPEC-011 runtime Kimi nativo)
import { registerGrokHandlers } from './grok';
import { registerTerminalHandlers } from './terminal'; // terminal:* (terminal integrado no chat)
import { registerClaudeCliHandlers } from './claude-cli'; // claude-cli:* (diagnostico/config do runtime nativo Claude)
import { registerKnowledgeHandlers } from './knowledge'; // knowledge:*
import { registerHarnessHandlers } from './harness'; // harness:*
import { registerEnrichHandlers } from './enrich'; // enrich:*
import { registerPipelineHandlers } from './pipeline'; // pipeline:* (Pipeline + Reset/Sprint History)
import { registerMgraphHandlers } from './mgraph'; // memory graph + ingest
import { registerOpenDesignHandlers } from './open-design'; // open-design:* + pricing:calculate
import { registerActivityHandlers } from './activity'; // activity:get-blocks (activity log v2)
import { registerDriveHandlers } from './drive'; // drive:* (orchestrator pipeline-control driver)
import { registerRepoGraphHandlers } from './repo-graph'; // repo-graph:* (repo mode com CodeGraph no chat)
import { registerDynamicWorkflowHandlers } from './dynamic-workflow'; // dynamic-workflow:* (SPEC-010 dynamic workflow pipe)
import { registerKanbanHandlers } from './kanban'; // kanban:* (SPEC kanban-nativo, Kanban por repositorio)

export function registerAllIpcHandlers(ctx: IpcContext): void {
  registerChatHandlers(ctx); // chat:* + codeburn:*
  registerAgentsHandlers(ctx); // agents + skills + mcp + mcp-discovery
  registerSchedulerHandlers(ctx); // scheduler + activity board + tasks
  registerSystemHandlers(ctx); // logs + memory + tools + auth + identity + onboarding + shell + dialog
  registerSettingsHandlers(ctx); // settings:* (get/update/set-api-key)
  registerIntegrationsHandlers(ctx); // vault + higgsfield + image + voice + google + channels
  registerLocalLlmHandlers(ctx); // ollama:* apenas
  registerCodexHandlers(ctx);
  registerKimiHandlers(ctx); // kimi:* (SPEC-011 runtime Kimi nativo)
  registerGrokHandlers(ctx);
  registerTerminalHandlers(ctx); // terminal:* (SPEC terminal-chat)
  registerClaudeCliHandlers(ctx); // claude-cli:* (diagnostico/config do runtime nativo Claude)
  registerKnowledgeHandlers(ctx); // knowledge:*
  registerHarnessHandlers(ctx); // harness:*
  registerEnrichHandlers(ctx); // enrich:*
  registerPipelineHandlers(ctx); // pipeline:* (Pipeline + Reset/Sprint History)
  registerMgraphHandlers(ctx); // memory graph + ingest
  registerOpenDesignHandlers(ctx); // open-design:* + pricing:calculate
  registerActivityHandlers(ctx); // activity:get-blocks (activity log v2)
  registerDriveHandlers(ctx); // drive:* (orchestrator pipeline-control driver)
  registerRepoGraphHandlers(ctx); // repo-graph:* (repo mode com CodeGraph no chat)
  registerDynamicWorkflowHandlers(ctx); // dynamic-workflow:* (SPEC-010 dynamic workflow pipe)
  registerKanbanHandlers(ctx); // kanban:* (SPEC kanban-nativo, Kanban por repositorio)
}
