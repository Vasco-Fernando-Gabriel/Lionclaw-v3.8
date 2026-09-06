import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Gate de equivalencia do refactor de modularizacao do ipc-handlers.ts
// (spec-backend-ipc-modularization.md secao 10.2). Prova CONJUNTO + CONTAGEM
// dos nomes de canal IPC, NAO a ordem de registro. ABI-safe: so leitura de
// arquivo, sem SQLite/node-pty.

const MAIN = join(__dirname, '..');
const RE_HANDLE = /ipcMain\.handle\(\s*['"]([^'"]+)['"]/g;
const RE_ON = /ipcMain\.on\s*\(/g;

function walk(dir: string): string[] {
  // Antes da Onda 0 a pasta ipc/ ainda nao existe; readdirSync lancaria.
  // Sem essa guarda o gate quebra ao capturar o golden no monolito intacto.
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

function sources(): string[] {
  const files = [join(MAIN, 'ipc-handlers.ts'), ...walk(join(MAIN, 'ipc'))];
  return files.map((f) => readFileSync(f, 'utf8'));
}

function channelNames(): string[] {
  const names: string[] = [];
  for (const src of sources()) {
    for (const m of src.matchAll(RE_HANDLE)) names.push(m[1]);
  }
  return names;
}

function countOnListeners(): number {
  let n = 0;
  for (const src of sources()) n += [...src.matchAll(RE_ON)].length;
  return n;
}

// GOLDEN: lista ordenada dos 263 nomes capturada do monolito na Onda 0, passo 1.
// +1 (264) em Activity Log v2 (SPEC K2, secao 5.7): canal aditivo
// `activity:get-blocks` para hidratacao do painel. Nenhum canal removido/renomeado (R2).
// +6 (270) em Orchestrator <-> Pipeline Control (SPEC orchestrator-pipeline-control,
// S8/S9): handlers ADITIVOS do driver do orquestrador `drive:get-state`,
// `drive:start`, `drive:assumir`, `drive:stop`, `drive:resume`, `drive:set-mode`
// (ipc/drive.ts, registrados em ipc/index.ts). A UI do Pipeline observa/opera o
// drive por esses canais; o evento broadcast `drive:state-changed` NAO e um handle
// (e emitido via emitIPC, nao registrado com ipcMain.handle), logo nao entra aqui.
// Nenhum canal removido/renomeado (R2).
// +11 (281) em Repo Mode com CodeGraph no Chat (SPEC spec-chat-repo-codegraph.md,
// secao 6, Sprint A1): handlers ADITIVOS `repo-graph:list`, `repo-graph:add-repository`,
// `repo-graph:remove-repository`, `repo-graph:get-session-state`,
// `repo-graph:attach-session`, `repo-graph:detach-session`,
// `repo-graph:set-prompt-suppressed`, `repo-graph:set-global-prompt-suppressed`,
// `repo-graph:status`, `repo-graph:build`, `repo-graph:update` (ipc/repo-graph.ts,
// registrados em ipc/index.ts). O 12o canal da spec, `repo-graph:on-status`, e
// BROADCAST (webContents.send do engine; renderer assina com cleanup no preload),
// nao e ipcMain.handle — mesmo criterio do drive:state-changed acima. build/update
// sao os UNICOS caminhos ate o RepoGraphWriter (consentimento estrutural, 5.2).
// Nenhum canal removido/renomeado (R2).
// +1 (282) na Sprint A4 (SPEC spec-chat-repo-codegraph.md, secao 19 D-5):
// handler ADITIVO `repo-graph:metrics` — leitura agregada das metricas de
// economia (formula fixada: media de tool calls nao-repo-graph + tokens por
// turno, COM repo used=1 vs SEM repo, janela 50+ turnos cada) para a pagina
// Repositorios. Read-only (nao toca o writer). Nenhum canal removido/renomeado (R2).
// +1 (283) em drive-resiliente Parte A (SPEC spec-drive-resiliente.md, A2-bis):
// handler ADITIVO `open-design:get-start-status` (ipc/open-design.ts) que devolve
// { driveEngaged, startPending } pelos predicados canonicos do main (isDriveEngaged
// / isDriveStartPending), pra o Phase4Container decidir CTA vs auto-ensure sob drive.
// Read-only (nao inicia geracao). Nenhum canal removido/renomeado (R2). Mesmo padrao
// da atualizacao do snapshot irmao ipc-channels-snapshot.test.ts.
// +21 (304) em SPEC-010 dynamic-workflow-pipe: 21 handles dynamic-workflow:*
// (ipc/dynamic-workflow.ts, registrados em ipc/index.ts): create-from-spec,
// create-from-workflow, generate-and-start (os 3 REMOVIDOS depois - ver nota
// -3 abaixo), validate, start, pause, resume,
// abort, send-message, intervene, request-replan, approve-gate,
// resolve-with-closer, closer-message, finalize, list-runs, get-run,
// get-snapshot, get-nodes, get-events, get-artifacts (secao 14.1 da SPEC).
// Read-only reais na S01; demais como stub { error: 'not-implemented' }
// substituidos pelas sprints donas. O 22o canal da secao 14.1,
// `dynamic-workflow:stream`, e BROADCAST via emitIPC (nao e ipcMain.handle) e
// NAO entra aqui - mesmo criterio do drive:state-changed acima. Nenhum canal
// removido/renomeado (R2).
// +2 (306) em SPEC-010 P0-RECOVERY (SM-22/SM-10): handlers ADITIVOS
// `dynamic-workflow:delete` (UNICA porta destrutiva do dominio - botao "Deletar
// workflow" da lista, com confirmacao; para a execucao e apaga o run + cascade) e
// `dynamic-workflow:get-messages` (re-hidratacao dos threads do Maestro/closer ao
// revisitar/reabrir um run - mensagens ja persistidas em dynamic_workflow_messages).
// Read-only get-messages; delete e a unica escrita destrutiva. Nenhum canal
// removido/renomeado (R2).
// +1 (307) em SPEC-010 SM-37: handler ADITIVO `dynamic-workflow:reopen` (reabre
// run paused/interrupted/blocked sem perder plano/sprints/codigo - REGRA MAXIMA).
// Nenhum canal removido/renomeado (R2).
// +4 (311) em SPEC-011 S4 (runtime Kimi nativo): handlers ADITIVOS `kimi:status`,
// `kimi:test`, `kimi:open-login`, `kimi:set-binary-path` (ipc/kimi.ts, registrados
// em ipc/index.ts). Espelham os canais codex:* de auth/diagnostico. Nenhum canal
// existente removido/renomeado (R2).
// +2 (313) em spec-three-fixes ITEM 1 (telegram_notify): handlers ADITIVOS
// `tools:get-telegram-armed` e `tools:set-telegram-armed` (ipc/system.ts), o
// arm-toggle do envio proativo para o Telegram (le/persiste a chave de settings
// `telegram:armed`; default DESARMADO). Invoke/handle (request/response), entao
// sem cleanup fn no renderer. Nenhum canal existente removido/renomeado (R2).
// +1 (314) em handoff-orchestrator (SPEC spec-handoff-orchestrator.md, secao 8
// Canal ADITIVO 1): handler ADITIVO `chat:ensure-session` (ipc/chat.ts). Garante
// uma sessao de chat concreta ANTES do attach/send no handoff do orquestrador
// (preferred valido -> mesmo id sem arquivar; invalido -> getActiveChatSession;
// sem ativa -> cria nova). Invoke/handle (request/response), sem cleanup fn no
// renderer. Nenhum canal existente removido/renomeado (R2).
// +4 (318) em claude-cli (diagnostico/config do runtime NATIVO Claude Code): handlers
// ADITIVOS `claude-cli:status`, `claude-cli:test`, `claude-cli:open-login`,
// `claude-cli:set-binary-path` (ipc/claude-cli.ts, registrados em ipc/index.ts). Espelham
// os canais codex:*/kimi:* de auth/diagnostico (o Claude nasceu default e nunca teve
// menu). Invoke/handle (request/response), sem cleanup fn no renderer. Nenhum canal
// existente removido/renomeado (R2).
// +2 (320) em chat-context-reduction (SPEC spec-chat-context-reduction.md, A.3 —
// Sprint S2): handlers ADITIVOS `chat:get-feature-toggles` (toggles persistidos
// da sessao, para reidratacao dos chips Pipeline/Workflows) e
// `chat:set-feature-toggles` (persiste patch parcial; rejeita sessao
// inexistente / type nao-desktop / status != active com { ok:false, code })
// em ipc/chat.ts. Invoke/handle (request/response), sem cleanup fn no
// renderer. O `featureToggles` do send viaja DENTRO das options do canal
// `chat:send` existente (aditivo, sem canal novo). Nenhum canal existente
// removido/renomeado (R2).
// +1 (321) em robustez-chat SB-9 (SPEC spec-robustez-chat.md, P12): handler
// ADITIVO `vault:health` (ipc/integrations.ts) — saude do vault de segredos
// (KEYTAR-DEGRADED / VAULT-CORRUPT com backup .bak-<ts> / chaves
// SECRET-UNREADABLE) para os badges do VaultPage. Invoke/handle
// (request/response), sem cleanup fn no renderer. Nenhum canal existente
// removido/renomeado (R2).
// +1 (329) em robustez-chat UX-CTX (SPEC spec-robustez-chat.md, SA-2): handler
// ADITIVO `chat:get-context-usage` (ipc/chat.ts) — hidrata a barrinha de contexto
// ao ABRIR/TROCAR de sessao a partir do `active_context_tokens_est` persistido +
// a janela do modelo atual (buildChatContextUsage). Read-only (nao e um turno,
// nunca compacta/escreve); retorna o shape do chunk `context_usage` ou null (D5).
// Invoke/handle (request/response), sem cleanup fn no renderer. Nenhum canal
// existente removido/renomeado (R2).
// +1 (330) em logs-sistema (aba "Sistema" do menu Logs): handler ADITIVO
// `logs:query-system` (ipc/system.ts) — hidrata a aba com o ring buffer em
// memoria dos logs pino do main (system-log-buffer.ts): entries filtradas
// (minLevel/module/search/limit) + modulos distintos + caminho do arquivo de
// log da sessao. Read-only. O broadcast irmao `logs:system-entry` e emitido
// via webContents.send (nao e ipcMain.handle) e NAO entra aqui — mesmo
// criterio do drive:state-changed acima. Nenhum canal existente
// removido/renomeado (R2).
// +1 (331) no painel "Limites" do chat (port do lioncode): handler ADITIVO
// `usage:provider-limits` (ipc/system.ts) — janelas de uso das assinaturas
// conectadas (Claude/Codex/GLM/MiniMax/Kimi; provider-usage-limits.ts), com
// filtro de produto para status 'ok' apenas. Read-only, cache interno de 4min.
// Nenhum canal existente removido/renomeado (R2).
// +16 (344) em Kanban nativo F3 (SPEC spec-kanban-nativo-2026-08-31.md,
// secao 5): handlers ADITIVOS `kanban:list-boards`, `kanban:create-board`,
// `kanban:delete-board`, `kanban:query-cards`, `kanban:create-card`,
// `kanban:get-card`, `kanban:update-card`, `kanban:move-card`,
// `kanban:deliver-card`, `kanban:archive-card`, `kanban:unarchive-card`,
// `kanban:delete-card`, `kanban:attach-file`, `kanban:remove-attachment`,
// `kanban:open-attachment`, `kanban:read-attachment` (ipc/kanban.ts,
// registrados em ipc/index.ts). Handlers finos sobre o kanban-engine (mesma
// camada que o MCP lionclaw-kanban consome); escritas da UI gravam actor
// 'user'; read-attachment tem limite de leitura de 2MB (texto via IPC porque
// fetch de protocolo custom cai no default-src da CSP — img/PDF vao pelo
// protocolo lionclaw-kanban://). O broadcast `kanban:changed` e emitido via
// webContents.send do engine (nao e ipcMain.handle) e NAO entra aqui — mesmo
// criterio do drive:state-changed acima; shape travado no snapshot irmao
// ipc-channels-snapshot.test.ts. Nenhum canal removido/renomeado (R2).
// -3 (328) na refatoracao dynamic-workflows (SPEC 2026-08-27, Sprint 2):
// `dynamic-workflow:create-from-spec`, `dynamic-workflow:create-from-workflow` e
// `dynamic-workflow:generate-and-start` REMOVIDOS sem alias - criacao de workflow
// virou EXCLUSIVA do orquestrador via tools MCP (dynamic_workflow_author). Excecao
// deliberada ao R2, justificada pela SPEC da refatoracao (portas do renderer
// deixam de existir junto com o modo manifest/builder).
// +2 (346) na SPEC orquestrador-driver (2026-09-02, D25): handlers ADITIVOS
// `dynamic-workflow:get-run-bundle` (pacote SO-LEITURA do run para a aba Saidas
// do cockpit) e `dynamic-workflow:open-run-dir` (abre a pasta do run no gerenciador
// de arquivos). Read-only; nenhum canal removido/renomeado (R2).
const GOLDEN: string[] = [
  'activity:get-blocks',
  'agents:create',
  'agents:delete',
  'agents:get',
  'agents:list',
  'agents:sync-to-orchestrator',
  'agents:update',
  'auth:enable-totp',
  'auth:is-authenticated',
  'auth:is-first-run',
  'auth:login',
  'auth:logout',
  'auth:setup-password',
  'auth:verify-totp',
  'channels:get',
  'channels:list',
  'channels:save-telegram',
  'channels:telegram-status',
  'channels:test-telegram',
  'channels:toggle',
  'chat:archive-session',
  'chat:ask-response',
  'chat:clear-session',
  'chat:compact-session',
  'chat:confirm-response',
  'chat:delete-session',
  'chat:ensure-session',
  'chat:get-active-session',
  'chat:get-context-usage',
  'chat:get-feature-toggles',
  'chat:get-messages',
  'chat:get-sessions',
  'chat:send',
  'chat:set-feature-toggles',
  'chat:stop',
  'codeburn:kill',
  'codeburn:resize',
  'codeburn:spawn',
  'codeburn:write',
  'codex:apply-prep',
  'codex:check-prep-needed',
  'codex:grant-consent',
  'codex:list-model-capabilities',
  'codex:open-login',
  'codex:set-binary-path',
  'codex:status',
  'codex:test',
  // canais kimi:* PURAMENTE ADITIVOS; nenhum canal existente removido/renomeado (R2)
  'kimi:open-login',
  'kimi:set-binary-path',
  'kimi:status',
  'kimi:test',
  // canais claude-cli:* PURAMENTE ADITIVOS; nenhum canal existente removido/renomeado (R2)
  'claude-cli:open-login',
  'claude-cli:set-binary-path',
  'claude-cli:status',
  'claude-cli:test',
  'dialog:open-directory',
  'dialog:open-file',
  'drive:assumir',
  'drive:get-state',
  'drive:resume',
  'drive:set-mode',
  'drive:start',
  'drive:stop',
  'dynamic-workflow:abort',
  'dynamic-workflow:approve-gate',
  'dynamic-workflow:closer-message',
  'dynamic-workflow:delete',
  'dynamic-workflow:finalize',
  'dynamic-workflow:get-artifacts',
  'dynamic-workflow:get-events',
  'dynamic-workflow:get-messages',
  'dynamic-workflow:get-nodes',
  'dynamic-workflow:get-run',
  'dynamic-workflow:get-run-bundle',
  'dynamic-workflow:get-snapshot',
  'dynamic-workflow:intervene',
  'dynamic-workflow:list-runs',
  'dynamic-workflow:open-run-dir',
  'dynamic-workflow:pause',
  'dynamic-workflow:reopen',
  'dynamic-workflow:request-replan',
  'dynamic-workflow:resolve-with-closer',
  'dynamic-workflow:resume',
  'dynamic-workflow:send-message',
  'dynamic-workflow:start',
  'dynamic-workflow:validate',
  'enrich:abort',
  'enrich:approve-phase',
  'enrich:delete',
  'enrich:finalize',
  'enrich:get-messages',
  'enrich:get-spec',
  'enrich:list-sessions',
  'enrich:open-spec',
  'enrich:resume-after-auth',
  'enrich:send',
  'enrich:start',
  'google:authenticate',
  'google:revoke',
  'google:setup',
  'google:status',
  'grok:logout',
  'grok:open-login',
  'grok:set-binary-path',
  'grok:status',
  'grok:test',
  'harness:abort',
  'harness:approve-sprints',
  'harness:create-project',
  'harness:delete-project',
  'harness:get-evaluation',
  'harness:get-feedback-audit',
  'harness:get-metrics',
  'harness:get-project',
  'harness:get-rounds',
  'harness:get-sprint-json',
  'harness:get-sprints',
  'harness:get-sprints-json',
  'harness:get-stream-log',
  'harness:list-projects',
  'harness:pause',
  'harness:plan',
  'harness:regenerate-sprints',
  'harness:resume',
  'harness:run',
  'higgsfield:auth-status',
  'higgsfield:connect',
  'higgsfield:disconnect',
  'image:edit',
  'image:generate',
  // canais kanban:* PURAMENTE ADITIVOS (SPEC kanban-nativo F3); nenhum canal
  // existente removido/renomeado (R2)
  'kanban:archive-card',
  'kanban:attach-file',
  'kanban:create-board',
  'kanban:create-card',
  'kanban:delete-board',
  'kanban:delete-card',
  'kanban:deliver-card',
  'kanban:get-card',
  'kanban:list-boards',
  'kanban:move-card',
  'kanban:open-attachment',
  'kanban:query-cards',
  'kanban:read-attachment',
  'kanban:remove-attachment',
  'kanban:unarchive-card',
  'kanban:update-card',
  'knowledge:benchmark:start',
  'knowledge:benchmark:status',
  'knowledge:config:get',
  'knowledge:config:update',
  'knowledge:delete',
  'knowledge:list',
  'knowledge:reprocess',
  'knowledge:search',
  'knowledge:upload',
  'logs:export-csv',
  'logs:export-json',
  'logs:query',
  'logs:query-system',
  'mcp:create',
  'mcp:delete',
  'mcp:list',
  'mcp:list-sdk',
  'mcp:refresh-sdk',
  'mcp:restart',
  'mcp:test',
  'mcp:toggle',
  'mcp:toggle-sdk',
  'mcp:update',
  'memory:get-summaries',
  'memory:get-working',
  'memory:search-semantic',
  'memory:trigger-compaction',
  'memory:update-working',
  'mgraph:delete-note',
  'mgraph:graph',
  'mgraph:ingest-accept',
  'mgraph:ingest-cancel',
  'mgraph:ingest-discard',
  'mgraph:ingest-estimate',
  'mgraph:ingest-file',
  'mgraph:ingest-history',
  'mgraph:ingest-resume',
  'mgraph:ingest-settings',
  'mgraph:ingest-settings-update',
  'mgraph:ingest-text',
  'mgraph:ingest-url',
  'mgraph:list-notes',
  'mgraph:note-backlinks',
  'mgraph:read',
  'mgraph:search',
  'mgraph:seed',
  'mgraph:stats',
  'ollama:check',
  'ollama:list-models',
  'ollama:listModels',
  'onboarding:is-completed',
  'onboarding:mark-completed',
  'onboarding:reset',
  'open-design:boot-install-retry',
  'open-design:boot-install-status',
  'open-design:build-initial-prompt',
  'open-design:destructive-unlock',
  'open-design:ensure-session',
  'open-design:get-locked-snapshot',
  'open-design:get-session-config',
  'open-design:get-start-status',
  'open-design:hide-view',
  'open-design:inject-initial-prompt',
  'open-design:lock',
  'open-design:open-artifact',
  'open-design:preflight',
  'open-design:read-locked-html',
  'open-design:restart',
  'open-design:set-session-config',
  'open-design:set-view-bounds',
  'open-design:setup',
  'open-design:show-view',
  'open-design:snapshot',
  'open-design:start',
  'open-design:status',
  'open-design:stop',
  'pipeline:abort',
  'pipeline:advance',
  'pipeline:approve',
  'pipeline:conclude',
  'pipeline:confirm-development',
  'pipeline:create-project',
  'pipeline:decided',
  'pipeline:delete-project',
  'pipeline:export-report',
  'pipeline:get-audit-agents-state',
  'pipeline:get-conversation-phases',
  'pipeline:get-phase-messages',
  'pipeline:get-project',
  'pipeline:get-reset-preview',
  'pipeline:get-security-agent-status',
  'pipeline:get-smoke-test-path',
  'pipeline:get-sprint-detail',
  'pipeline:get-sprint-history',
  'pipeline:list-projects',
  'pipeline:list-sprints',
  'pipeline:metrics',
  'pipeline:open-project-file',
  'pipeline:open-smoke-test',
  'pipeline:pause',
  'pipeline:read-manifest',
  'pipeline:read-phase-artifact',
  'pipeline:read-phase-document',
  'pipeline:report',
  'pipeline:reset-phase',
  'pipeline:reset-sprint',
  'pipeline:resume',
  'pipeline:resume-after-auth',
  'pipeline:retry',
  'pipeline:send',
  'pipeline:start',
  'pricing:calculate',
  'provider:check',
  'provider:connect',
  'provider:disconnect',
  'provider:list-statuses',
  'provider:test-connection',
  'provider:test-openai-compatible',
  'provider:test-vertex-ai',
  'repo-graph:add-repository',
  'repo-graph:attach-session',
  'repo-graph:build',
  'repo-graph:detach-session',
  'repo-graph:get-session-state',
  'repo-graph:list',
  'repo-graph:metrics',
  'repo-graph:remove-repository',
  'repo-graph:set-global-prompt-suppressed',
  'repo-graph:set-prompt-suppressed',
  'repo-graph:status',
  'repo-graph:update',
  'rules:get-agent',
  'rules:get-global',
  'rules:update-agent',
  'rules:update-global',
  'scheduler:cleanup-sessions',
  'scheduler:create',
  'scheduler:delete',
  'scheduler:delete-session',
  'scheduler:get-activities',
  'scheduler:get-activity-stats',
  'scheduler:get-all-tags',
  'scheduler:get-runs',
  'scheduler:get-sessions',
  'scheduler:list',
  'scheduler:pause',
  'scheduler:pending-count',
  'scheduler:resume',
  'scheduler:review-run',
  'scheduler:update',
  'settings:get',
  'settings:set-api-key',
  'settings:update',
  'shell:open-path',
  'shell:show-in-folder',
  'skills:create',
  'skills:delete',
  'skills:get',
  'skills:list',
  'skills:update',
  'skills:update-raw',
  'soul:get',
  'soul:update',
  'tasks:categories',
  'tasks:create',
  'tasks:delete',
  'tasks:get',
  'tasks:list',
  'tasks:pending-due-count',
  'tasks:update',
  // SPEC terminal-chat v3 (R2: canais NOVOS do terminal integrado no chat,
  // nenhum rename; ver ipc/terminal.ts).
  'terminal:close',
  'terminal:open',
  'terminal:resize',
  'terminal:write',
  'tools:get-bypass',
  'tools:get-enabled',
  'tools:get-settings',
  'tools:get-telegram-armed',
  'tools:getEnabled',
  'tools:getSettings',
  'tools:set-bypass',
  'tools:set-enabled',
  'tools:set-telegram-armed',
  'tools:setEnabled',
  'usage:provider-limits',
  'user:get',
  'user:update',
  'vault:check',
  'vault:delete',
  'vault:health',
  'vault:list',
  'vault:register-and-set',
  'vault:set',
  'voice:list-cartesia-voices',
  'voice:list-voices',
  'voice:read-audio-file',
  'voice:speak',
  'voice:speak-cartesia',
  'voice:speak-live',
  'voice:transcribe',
];

describe('ipc channel list (gate de equivalencia do refactor)', () => {
  it('conjunto de nomes == golden (346, diff vazio)', () => {
    const names = channelNames();
    expect([...new Set(names)].sort()).toEqual([...GOLDEN].sort());
  });
  it('346 registros, 346 nomes unicos, 0 duplicatas', () => {
    const names = channelNames();
    expect(names.length).toBe(346);
    expect(new Set(names).size).toBe(346);
  });
  it('0 listeners ipcMain.on (so ipcMain.handle no projeto)', () => {
    expect(countOnListeners()).toBe(0);
  });
});
