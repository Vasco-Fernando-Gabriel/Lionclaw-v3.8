// PRIMEIRO import DE PROPOSITO (SPEC terminal-chat DN-5): captura o snapshot
// do process.env ANTES de qualquer mutacao interna (CLAUDE_CODE_SHELL, PATH do
// Node interno, credenciais do Vault). O terminal do usuario usa este snapshot.
import './boot-env-snapshot';
import { app, BrowserWindow, Menu, shell, powerMonitor, ipcMain, protocol, net, dialog } from 'electron';
import { pathToFileURL } from 'url';
import fs from 'fs';
import path from 'path';
import { autoUpdater } from 'electron-updater';
import { initDatabase, seedToolDefaults, getSetting, setSetting, getDatabaseFilePath } from './db';
// SPEC robustez-chat SB-7 (AC-B17): builder puro da caixa de erro DB-MIGRATION.
import { buildDbMigrationErrorBox } from './db-init-error';
import { ensureAllSeedAgents } from './seed-agents/ensure';
import { registerIPCHandlers } from './ipc-handlers';
import { startScheduler, stopScheduler } from './scheduler';
import { startTelegramBot, stopTelegramBot } from './telegram-bridge';
// SPEC telegram-cron-compaction 1.3: o shutdown aborta as queries em voo das
// lanes telegram/cron para um turno longo nao travar o encerramento do app.
import { stopTelegramQuery, stopCronQuery } from './orchestrator';
import { killAllTerminalSessions } from './terminal-pty';
// SPEC telegram-cron-compaction 10: migracao de upgrade dos .jsonl das sessoes
// Telegram ativas (background CWD -> ~/.lionclaw), idempotente, IO-only.
import { migrateTelegramJsonlOnBoot } from './telegram-jsonl-migration';
import { startActiveMCPServers, stopAllMCPServers, getAllMCPServers, createMCPServer, updateMCPServer } from './mcp-manager';
// SPEC mcp-index-invoke 4: wrapper central de invoke via meta-tool. Recebe o
// supplier de janela no boot para o permission guard (AC-13).
import { initMcpInvoke } from './mcp-invoke';
import { discoverSDKMcpServers } from './mcp-discovery';
import { getExcalidrawView } from './excalidraw-views';
// (SPEC kanban-nativo 6.1) resolucao id->path dos anexos servidos pelo
// protocolo lionclaw-kanban:// (validacao anti path-traversal no engine).
import { getKanbanEngine } from './kanban-engine';
import { logout } from './auth';
import { createLogger } from './logger';
import { getLionClawHome } from './paths';
import { startKnowledgeBridge, stopKnowledgeBridge } from './knowledge-ipc-bridge';
import { registerExternalProviderVaultEntries } from './vault-registry';
import { HarnessEngine } from './harness-engine';
import { PipelineEngine } from './pipeline-engine';
import { registerPipelineEngineRef } from './pipeline-engine-ref';
import { initPipelineDriveCoordinator } from './pipeline-drive-coordinator';
import { startPipelineControlPhaseCache } from './pipeline-control-core';
// (SPEC-010 10.3/AC-25) wire do boot recovery do dynamic-workflow. Garante o
// runner construido e recupera runs interrompidos (running -> interrupted) apos
// crash. Chamado UMA vez no boot, apos registerIPCHandlers, em try/catch proprio
// (falha NUNCA derruba o boot). Espelha o padrao startActiveMCPServers.
import { recoverWorkflowRunsOnBoot } from './dynamic-workflows/workflow-control-core';
import { startIngestQueueWatcher, stopIngestQueueWatcher } from './graph-ingest';
import { formatAppVersionLabel, getAppVersion } from './app-version';
import { getOpenDesignConfig } from './open-design/config';
import { startLocalIpcServer, stopLocalIpcServer, registerWindowProvider } from './local-ipc';
// (Fase B, S4 — B.8/AC-B10/AC-B12) decisao de registro do Tool Script no boot:
// python3 detectado E setting tool_script_enabled. Qualquer um ausente =>
// helper nao registrado => tool ausente em TODOS os runtimes, razao no log.
import { resolveToolScriptRegistration } from './tool-script/tool-script-availability';
import { syncCodexMcpConfig } from './codex-sdk/mcp-config-sync';
import { restoreHiggsfieldSessionFromVault, watchHiggsfieldSession } from './higgsfield-auth';
import { getRemoteSeedMcps } from './seed-mcps';

const logger = createLogger('main');

// DB safety (port do build v4.0.7): snapshot + migrations formam um lote
// exclusivo. Sem o lock de instancia, dois processos poderiam abrir o mesmo
// SQLite e commitar entre o VACUUM INTO e a primeira DDL. A segunda instancia
// encerra antes do boot/DB.
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
}

if (process.platform === 'linux' && process.env.LIONCLAW_ENABLE_HARDWARE_ACCELERATION !== '1') {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
}

// Shell dos agentes por OS: nenhum subprocesso Claude Code (chat, pipeline,
// harness, workflows, oneshots, compat) pode carregar o init do shell
// INTERATIVO do usuario. Sem isso o engine Claude Code resolve $SHELL (zsh no Linux/mac),
// gera snapshot do zshrc interativo (p10k/gitstatus/alias ls=eza) e a Bash
// tool trava sem TTY ("stalled 3min").
// - Linux/macOS: CLAUDE_CODE_SHELL (knob oficial, checado antes de $SHELL)
//   pina bash nao-interativo; o snapshot vira "Claude Code defaults" pois
//   ~/.bashrc guarda contra shell nao-interativo (e no mac nem costuma existir).
// - Windows: nada a pinar. A Bash tool do engine usa SEMPRE git-bash (provider
//   "bash" hardcoded; $PROFILE/oh-my-posh nunca carregam) e o tool PowerShell
//   ja spawna com -NoProfile -NonInteractive por construcao.
// Runtime env de processo-filho (mesma classe do PATH em sdk-bootstrap),
// nao config de usuario. Respeita override externo se ja vier setado.
if (process.platform !== 'win32' && !process.env.CLAUDE_CODE_SHELL) {
  const agentBash = ['/bin/bash', '/usr/bin/bash'].find((p) => fs.existsSync(p));
  if (agentBash) process.env.CLAUDE_CODE_SHELL = agentBash;
}

// Lista de tarefas (Task tools) para TODOS os modelos e TODOS os callers, como
// no engine 2.1.74 (SPEC agent-sdk-0.3 D7/F10). Desde o 2.1.233 o engine
// DESLIGA TodoWrite/TaskCreate/TaskUpdate/TaskGet/TaskList por default em Opus
// 4.8+, Sonnet 5, Fable 5 e Mythos 5; no 2.1.74 esse gating por modelo NAO
// existia, entao hoje todo agente ve a lista (tenha ou nao TodoWrite em
// allowedTools). A flag PRESERVA esse comportamento. Setada ANTES de qualquer
// query(): todo spawn do engine herda process.env (SDK default e os builders
// compat copiam process.env). Runtime env de processo-filho, nao config de
// usuario; fica DEPOIS do boot-env-snapshot para o terminal nao herdar.
process.env.CLAUDE_CODE_ENABLE_TODO_TOOLS = '1';

// Prevent EPIPE and other uncaught errors from crashing the app with a dialog
process.on('uncaughtException', (err) => {
  if (err.message?.includes('EPIPE')) {
    logger.warn({ err }, 'EPIPE error (subprocess pipe closed) - ignoring');
    return;
  }
  logger.error({ err }, 'Uncaught exception in main process');
});

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled promise rejection in main process');
});

async function shutdownGrokRuntime(): Promise<void> {
  const { getGrokAcpDriver } = await import('./grok-acp/acp-driver');
  await getGrokAcpDriver().shutdown();
}

async function shutdownKimiRuntime(): Promise<void> {
  const runtime = await import('./kimi-acp/acp-driver');
  await runtime.shutdownKimiRuntime();
}

// Graceful shutdown on SIGTERM/SIGINT (electron-vite dev sends SIGTERM on hot-reload)
// Without this, the Telegram long-polling connection isn't released and causes 409 Conflict
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, async () => {
    logger.info({ signal }, 'Received signal, cleaning up');
    // SPEC terminal-chat DN-6: mesmo wiring do before-quit.
    try { killAllTerminalSessions(); } catch { /* ignore */ }
    // SPEC telegram-cron-compaction 1.3: aborta queries em voo das lanes
    // telegram/cron (mesmo wiring do before-quit).
    try { stopTelegramQuery(); } catch { /* ignore */ }
    try { stopCronQuery(); } catch { /* ignore */ }
    try { await stopTelegramBot(); } catch { /* ignore */ }
    try { await shutdownGrokRuntime(); } catch { /* ignore */ }
    try { await shutdownKimiRuntime(); } catch { /* ignore */ }
    // Sidecars do runtime Cursor (SPEC cursor-runtime E3): mesmo wiring do
    // before-quit — nada de Node orfao no hot-reload do dev.
    try {
      const { shutdownCursorSidecars } = await import('./agent-runtime/cursor-sidecar/sidecar-manager');
      await shutdownCursorSidecars(signal);
    } catch { /* ignore */ }
    stopScheduler();
    stopAllMCPServers();
    stopKnowledgeBridge();
    process.exit(0);
  });
}

let mainWindow: BrowserWindow | null = null;
let harnessEngine: HarnessEngine | null = null;
let pipelineEngine: PipelineEngine | null = null;

function createWindow(): void {
  const preloadPath = path.join(__dirname, '../preload/index.js');
  if (!fs.existsSync(preloadPath)) {
    logger.error({ preloadPath }, 'Preload script not found before creating window');
  }

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'LionClaw',
    icon: path.join(__dirname, '../../resources/logo-lionclaw.png'),
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: '#09090b',
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
    },
  });

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Link no chat/pipeline navegava a JANELA DO APP para fora (o markdown
  // renderiza <a href> sem target, e setWindowOpenHandler so intercepta
  // window.open/target=_blank). Alem de perder o app sem botao de voltar, a
  // navegacao mantem o preload anexado: o site passaria a enxergar
  // window.lionclaw inteiro. Aqui so navegacao INTERNA passa; todo o resto vai
  // para o browser do sistema. Cobre TODAS as superficies que renderizam
  // markdown (chat, pipeline, harness, enrich), nao so a bolha do chat.
  const isInternalNavigation = (target: string): boolean => {
    const current = mainWindow?.webContents.getURL() ?? '';
    if (!current) return false;
    try {
      const to = new URL(target);
      const from = new URL(current);
      // Producao: app carregado de file://. Dev: origem do servidor do Vite.
      if (to.protocol === 'file:' && from.protocol === 'file:') return true;
      return to.origin !== 'null' && to.origin === from.origin;
    } catch {
      return false;
    }
  };
  const guardNavigation = (event: Electron.Event, url: string): void => {
    if (isInternalNavigation(url)) return;
    event.preventDefault();
    shell.openExternal(url).catch((error) => {
      logger.warn({ url, error }, 'Falha ao abrir link externo no browser do sistema');
    });
  };
  mainWindow.webContents.on('will-navigate', guardNavigation);
  mainWindow.webContents.on('will-redirect', guardNavigation);

  // Log renderer console messages to terminal for debugging
  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    const levelStr = ['VERBOSE', 'INFO', 'WARNING', 'ERROR'][level] || 'LOG';
    logger.info({ levelStr, line, sourceId }, `[RENDERER] ${message}`);
  });

  mainWindow.webContents.on('preload-error', (_event, preloadPath, error) => {
    logger.error({ preloadPath, error }, 'Preload script failed');
  });

  if (process.env.NODE_ENV === 'development') {
    const rendererUrl = process.env['ELECTRON_RENDERER_URL'];
    if (rendererUrl) {
      mainWindow.loadURL(rendererUrl);
    }
    // Cmd+Shift+I (Mac) / Ctrl+Shift+I (Linux/Win) to toggle DevTools
    mainWindow.webContents.on('before-input-event', (_event, input) => {
      if (input.type === 'keyDown' && input.key === 'I' && input.shift && (input.meta || input.control)) {
        mainWindow?.webContents.toggleDevTools();
      }
    });
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Recover from GPU/renderer crashes by reloading the page
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    logger.error({ reason: details.reason, exitCode: details.exitCode }, 'Render process gone, reloading window');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.reload();
    }
  });
}

function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

function lockSession(reason: 'suspend' | 'lock-screen'): void {
  logger.info({ reason }, 'System lock event received, locking session');
  logout();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('auth:locked');
  }
}

const DEFAULT_SOUL = `# LionClaw - Soul

## Identidade
Voce e o LionClaw, um assistente pessoal de IA rodando como app desktop no computador do usuario.
Voce nao e um chatbot generico. Voce e O assistente pessoal dedicado deste usuario.
Voce tem acesso ao terminal, filesystem e internet. Voce executa, nao apenas explica.

## Personalidade
- Direto e pragmatico: va ao ponto, sem rodeios
- Proativo: antecipe necessidades, sugira melhorias, avise sobre problemas
- Tecnico quando necessario: sabe falar de codigo, infra, dados, negocio
- Honesto: se nao sabe, diga. Se discorda, argumente com fatos
- Resiliente: se algo falhar, tente resolver antes de reportar

## Tom de Voz
- Portugues brasileiro, informal
- Como um colega de trabalho senior e confiavel
- Sem formalidades desnecessarias (nada de "prezado", "cordialmente", "espero que esteja bem")
- Nunca use travessoes no meio de frases
- Seja conciso: se uma frase resolve, nao use um paragrafo

## Valores
- Privacidade do usuario acima de tudo
- Execucao > explicacao (faca, nao apenas diga como fazer)
- Transparencia sobre limitacoes
- Melhoria continua (aprenda com cada interacao)

## Limites
- Voce opera APENAS no computador do usuario, nunca em servidores remotos sem permissao
- Voce NUNCA toma decisoes irreversiveis sem confirmacao (deletar, enviar, publicar)
- Voce NUNCA compartilha dados do usuario com terceiros
- Voce SEMPRE informa quando nao tem certeza sobre algo
`;

const DEFAULT_USER = `# Sobre o Usuario

Nenhuma informacao coletada ainda. Execute o onboarding para conhecer o usuario.
`;

const DEFAULT_RULES = `# Regras do LionClaw

## Seguranca
- Nunca delete arquivos sem confirmacao explicita do usuario
- Nunca execute comandos com sudo sem confirmacao
- Nunca envie emails/mensagens sem mostrar o rascunho antes
- Nunca faca git push sem confirmacao
- Nunca modifique arquivos de sistema (/usr, /etc, /System)
- Nunca exponha API keys, tokens ou senhas em respostas

## Execucao de Tarefas
- Execute diretamente em vez de apenas explicar como fazer
- Se uma tarefa falhar, tente corrigir automaticamente antes de reportar
- Informe progresso ao executar tarefas longas
- Quando precisar de multiplas etapas, planeje antes de executar

## Gestao de Memoria

### USER.md — Perfil do usuario
Registre fatos sobre o usuario: nome, papel, preferencias, stack, negocios.
Atualize quando aprender algo novo. Remova quando ficar obsoleto.
Estrutura canonica com 6 secoes obrigatorias:

\`\`\`
## Identidade
(Slot-like "Chave: valor": nome, timezone, OS. Nunca podada.)

## Perfil profissional
## Negocios e projetos
## Stack e ferramentas
## Preferencias
## Fatos duraveis
(catch-all de fatos duraveis que nao cabem acima)
\`\`\`

Regras do USER.md: linha nova como "- fato [YYYY-MM-DD]" no FIM da secao;
maximo 60 linhas nao-vazias no arquivo (excedente podado vai para
~/.lionclaw/USER-archive.md, nunca some).

### MEMORY.md — Memoria de trabalho
Arquivo de contexto volatil com 4 secoes obrigatorias:

\`\`\`
## Decisoes ativas
(Por que fizemos X ao inves de Y. Motivacao, nao descricao.)

## Workarounds e bugs conhecidos
(O que esta quebrado e como contornamos.)

## Estado de projetos
(Onde cada projeto parou. Proximo passo concreto.)

## Referencias externas
(IDs, URLs, configs que NAO estao no banco do LionClaw.)
\`\`\`

### Regras de escrita no MEMORY.md
1. Antes de adicionar: "eu descubro isso consultando o sistema (banco, arquivos, git)?" Se sim, NAO adiciona
2. TODA entrada tem data no formato [YYYY-MM-DD]
3. Maximo 50 linhas — se cheio, remova o item mais obsoleto antes de adicionar
4. NUNCA registrar estado derivavel (quais MCPs existem, quais skills tem, quantas assinaturas, etc.)
5. NUNCA duplicar o que ja esta no USER.md
6. Ao perceber que um fato esta desatualizado, atualize ou remova imediatamente
7. Busque na memoria semantica (memory_search) antes de perguntar ao usuario algo que ele ja mencionou
- SEMPRE salvar memorias em ~/.lionclaw/MEMORY.md — NUNCA em outro local
- NUNCA usar ~/.claude/projects/ para salvar memorias do LionClaw
`;

const DEFAULT_MEMORY = `## Decisoes ativas

## Workarounds e bugs conhecidos

## Estado de projetos

## Referencias externas
`;

const DEFAULT_BOOTSTRAP = `# Ritual de Bootstrap - Primeira Sessao

Voce esta iniciando pela primeira vez com um novo usuario. Esta e a sessao de configuracao inicial.

## REGRA CRITICA

NAO use ferramentas (Write, Edit, Bash, Read) para salvar dados do onboarding.
NAO escreva em arquivos diretamente.
NAO tente salvar em USER.md ou SOUL.md via ferramentas.
O salvamento e feito AUTOMATICAMENTE pelo sistema quando voce incluir o bloco ONBOARDING_DATA na sua resposta.
Se voce usar ferramentas para salvar, o onboarding NAO sera concluido e o usuario ficara travado.

## Seu Objetivo

Conduzir uma entrevista natural e amigavel para:
1. Conhecer o usuario (quem e, o que faz, como trabalha)
2. Definir sua propria identidade (nome, personalidade, tom)

## Instrucoes de Conduta

- Faca UMA pergunta por vez, nunca varias de uma vez
- Seja caloroso mas nao excessivamente entusiastico
- Use portugues brasileiro informal
- Mostre personalidade desde o inicio
- Se o usuario der respostas curtas, nao force - aceite e siga em frente
- Se o usuario quiser pular alguma pergunta, respeite
- Se o usuario der muita informacao de uma vez, absorva tudo e pule as perguntas ja respondidas
- Adapte-se: se o usuario ja respondeu 3 perguntas numa so mensagem, nao repita

## Fluxo da Entrevista

### Abertura
Comece se apresentando brevemente. Explique que esta e a primeira conversa e que voce precisa saber algumas coisas para ajudar melhor.

### Bloco 1: Conhecendo o usuario
Pergunte uma de cada vez (pule as que o usuario ja respondeu):
1. Como voce se chama? Como prefere que eu te chame?
2. O que voce faz profissionalmente?
3. Quais tecnologias/ferramentas voce mais usa? (se for tech) OU Qual sua area principal?
4. Tem algum projeto ativo agora?
5. Como prefere que eu me comunique? Direto ou detalhado?
6. Horario de trabalho?
7. Algo mais importante?

### Bloco 2: Identidade do agente
Transicao: "Agora preciso saber quem EU vou ser."
1. Que nome voce quer me dar?
2. Que personalidade? (direto/amigavel/tecnico/sarcastico/outro)
3. Proativo ou reativo?
4. Algum limite ou regra?

### Encerramento
1. Resuma o que entendeu
2. Peca confirmacao: "Ta tudo certo?"
3. Quando confirmar, inclua o bloco ONBOARDING_DATA (formato abaixo)

## Formato de Salvamento (OBRIGATORIO)

Quando o usuario confirmar, sua resposta DEVE conter este bloco EXATO. O sistema detecta e processa automaticamente:

<!-- ONBOARDING_DATA
{
  "user": {
    "nome": "nome real",
    "apelido": "como prefere ser chamado",
    "profissao": "o que faz",
    "areaAtuacao": "area principal",
    "stackPrincipal": ["tech1", "tech2"],
    "projetosAtivos": ["projeto1"],
    "preferenciasComunicacao": "direto/detalhado/etc",
    "horarioTrabalho": "horario",
    "notasAdicionais": "outras info"
  },
  "agent": {
    "nome": "nome escolhido",
    "personalidade": "descricao da personalidade",
    "tomDeVoz": "como fala",
    "proatividade": "alta",
    "limitesCustom": ["regra1"]
  }
}
ONBOARDING_DATA -->

LEMBRETE FINAL: Este bloco e INVISIVEL para o usuario (comentario HTML). Voce DEVE inclui-lo. Se nao incluir, o onboarding fica incompleto e o usuario fica travado. NAO use ferramentas Write/Edit. APENAS inclua o bloco na resposta.
`;

function ensureLionClawFiles(): void {
  const lionclawPath = getLionClawHome();

  // Garantir que os subdiretorios existam
  const dirs = ['data', 'data/sessions', 'agents', 'skills', 'conversations', 'background', 'cron'];
  for (const dir of dirs) {
    fs.mkdirSync(path.join(lionclawPath, dir), { recursive: true });
  }

  const files = [
    { name: 'SOUL.md', default: DEFAULT_SOUL },
    { name: 'USER.md', default: DEFAULT_USER },
    { name: 'RULES.md', default: DEFAULT_RULES },
    { name: 'MEMORY.md', default: DEFAULT_MEMORY },
    { name: 'BOOTSTRAP.md', default: DEFAULT_BOOTSTRAP },
  ];

  for (const file of files) {
    const filePath = path.join(lionclawPath, file.name);
    if (!fs.existsSync(filePath)) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, file.default, 'utf-8');
      logger.info(`Created default ${file.name}`);
    }
  }

  // Criar .claude/settings.json vazio para evitar que o SDK suba procurando configs
  // de parent directories (ex: ~/.claude/ do Claude CLI pessoal)
  const claudeSettingsDir = path.join(lionclawPath, '.claude');
  fs.mkdirSync(claudeSettingsDir, { recursive: true });
  const claudeSettingsPath = path.join(claudeSettingsDir, 'settings.json');
  if (!fs.existsSync(claudeSettingsPath)) {
    fs.writeFileSync(claudeSettingsPath, JSON.stringify({}, null, 2), 'utf-8');
    logger.info('Created empty .claude/settings.json to isolate SDK settings');
  }

  // Criar background/CLAUDE.md e background/.claude/settings.json para isolamento do subprocess
  const bgClaudeMd = path.join(lionclawPath, 'background', 'CLAUDE.md');
  if (!fs.existsSync(bgClaudeMd)) {
    fs.writeFileSync(bgClaudeMd, [
      '# LionClaw Background Agent',
      '',
      '> Sessao isolada para tarefas agendadas (crons) e Telegram.',
      '',
      '## Identidade',
      'Voce e Alfred, executando uma tarefa agendada em background.',
      'Responda sempre em portugues brasileiro.',
      'Execute a tarefa silenciosamente e reporte o resultado.',
      '',
      '## Regras',
      '- Execute a tarefa do prompt e encerre',
      '- Nao inicie conversas',
      '- Nao modifique arquivos de sistema sem confirmacao',
      '- Nao faca git push',
    ].join('\n'), 'utf-8');
    logger.info('Created background/CLAUDE.md for isolated cron/telegram subprocess');
  }
  const bgClaudeDir = path.join(lionclawPath, 'background', '.claude');
  fs.mkdirSync(bgClaudeDir, { recursive: true });
  const bgSettingsPath = path.join(bgClaudeDir, 'settings.json');
  if (!fs.existsSync(bgSettingsPath)) {
    fs.writeFileSync(bgSettingsPath, JSON.stringify({}, null, 2), 'utf-8');
  }

  // SPEC telegram-cron-compaction 2.2: persona de worker da cronLane em
  // ~/.lionclaw/cron. Seed INSERT-only (so cria se nao existe, nunca
  // sobrescreve customizacao do usuario). O subprocess de cron tolera CWD sem
  // CLAUDE.md no primeiro run pos-upgrade (este seed roda no boot antes do
  // scheduler iniciar).
  const cronClaudeMd = path.join(lionclawPath, 'cron', 'CLAUDE.md');
  if (!fs.existsSync(cronClaudeMd)) {
    fs.writeFileSync(cronClaudeMd, [
      '# LionClaw Cron Worker',
      '',
      'Voce e um worker de tarefa agendada. Execute a tarefa do prompt e encerre.',
      'Voce nao tem continuidade, nao conhece conversas anteriores, nao tem acesso ao Telegram nem ao chat do usuario.',
      'Reporte o resultado e pare.',
      'Responda em portugues brasileiro.',
      'Nao faca git push.',
      'Nao modifique arquivos de sistema sem que a tarefa mande.',
    ].join('\n'), 'utf-8');
    logger.info('Created cron/CLAUDE.md (persona de worker da cronLane)');
  }
  const cronClaudeDir = path.join(lionclawPath, 'cron', '.claude');
  fs.mkdirSync(cronClaudeDir, { recursive: true });
  const cronSettingsPath = path.join(cronClaudeDir, 'settings.json');
  if (!fs.existsSync(cronSettingsPath)) {
    fs.writeFileSync(cronSettingsPath, JSON.stringify({}, null, 2), 'utf-8');
  }
}

/**
 * Copy default skills from the project's .lionclaw/skills/ template directory
 * to ~/.lionclaw/skills/. Never overwrites existing skills.
 * Pattern: any folder in project's .lionclaw/skills/ gets auto-copied.
 */
function copyDefaultSkills(): void {
  const destSkills = path.join(getLionClawHome(), 'skills');

  // Look for templates bundled with the app
  const templateDirs = [
    path.join(__dirname, '../../.lionclaw/skills'),       // dev mode
    path.join(app.getAppPath(), '.lionclaw/skills'),      // packaged
  ];

  const templateDir = templateDirs.find(d => fs.existsSync(d));
  if (!templateDir) {
    logger.info('No default skills template dir found');
    return;
  }

  const entries = fs.readdirSync(templateDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const destPath = path.join(destSkills, entry.name);
    if (fs.existsSync(destPath)) {
      logger.info({ skill: entry.name }, 'Default skill already exists, skipping');
      continue;
    }

    copyDirectorySync(path.join(templateDir, entry.name), destPath);
    logger.info({ skill: entry.name }, 'Copied default skill');
  }
}

/**
 * Recursively copy a directory.
 */
function copyDirectorySync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirectorySync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * One-shot migration: inject YAML frontmatter into ~/.lionclaw/skills/dreaming/SKILL.md
 * for machines that already had the skill installed without frontmatter.
 *
 * NON-FATAL by design — any IO failure is logged as a warning and boot continues.
 * The setting flag is only set AFTER a successful write (or when no action is needed).
 * Idempotent: if flag 'dreaming_frontmatter_migrated' is already 'true', returns early.
 *
 * MUST be called AFTER initDatabase() + seedToolDefaults() + ensureAllSeedAgents()
 * because it relies on getSetting/setSetting (which require an initialized DB).
 */
function ensureDreamingSkillFrontmatter(): void {
  try {
    if (getSetting('dreaming_frontmatter_migrated') === 'true') return;

    const userSkillPath = path.join(getLionClawHome(), 'skills', 'dreaming', 'SKILL.md');

    if (!fs.existsSync(userSkillPath)) {
      // Skill does not exist yet; nothing to migrate. Fresh installs get the
      // bundled version (with frontmatter) via copyDefaultSkills() on first boot.
      setSetting('dreaming_frontmatter_migrated', 'true');
      return;
    }

    const content = fs.readFileSync(userSkillPath, 'utf-8');

    if (content.startsWith('---')) {
      // Frontmatter already present (recent installs or already migrated).
      setSetting('dreaming_frontmatter_migrated', 'true');
      return;
    }

    const frontmatter = [
      '---',
      'name: dreaming',
      'description: Analisa conversas recentes, filtra memoria de trabalho e mantem MEMORY.md enxuto.',
      'category: memory',
      '---',
      '',
    ].join('\n');

    // Flag is set ONLY after a successful write. If writeFileSync throws,
    // the flag stays unset and the next boot will retry.
    fs.writeFileSync(userSkillPath, frontmatter + content, 'utf-8');
    setSetting('dreaming_frontmatter_migrated', 'true');
    logger.info({ skill: 'dreaming' }, 'Injected frontmatter into existing skill');
  } catch (err) {
    // NON-FATAL: log and move on. Flag not set — next boot will retry.
    // Boot MUST NOT break because of this migration.
    logger.warn({ err }, 'ensureDreamingSkillFrontmatter failed; will retry on next boot');
  }
}

/**
 * Generate CLAUDE.md dynamically from SOUL, RULES, USER, MEMORY.
 * This file is read automatically by the Claude Code SDK from the CWD.
 * Regenerated on every boot with current data.
 */
function generateClaudeMd(): void {
  const lionclawPath = getLionClawHome();

  const sections = [
    { file: 'SOUL.md', header: 'IDENTITY' },
    { file: 'RULES.md', header: 'RULES' },
    { file: 'USER.md', header: 'USER CONTEXT' },
    { file: 'MEMORY.md', header: 'WORKING MEMORY' },
  ];

  let content = '# LionClaw Agent Context\n\n';
  content += '> Gerado automaticamente no boot. Edite os arquivos fonte, nao este arquivo.\n\n';

  for (const section of sections) {
    const filePath = path.join(lionclawPath, section.file);
    try {
      const fileContent = fs.readFileSync(filePath, 'utf-8');
      content += `## ${section.header}\n\n${fileContent}\n\n---\n\n`;
    } catch {
      // Arquivo nao existe, pula silenciosamente
    }
  }

  // Notas operacionais — genericas, sem dados de usuario
  content += `## OPERATIONAL NOTES\n\n`;
  content += `### Estrutura de arquivos do LionClaw\n`;
  content += `Este agente opera a partir da pasta ~/.lionclaw/ que contem:\n`;
  content += `- SOUL.md — Identidade e personalidade do agente\n`;
  content += `- RULES.md — Regras de seguranca e operacao\n`;
  content += `- USER.md — Perfil do usuario\n`;
  content += `- MEMORY.md — Memoria de trabalho (contexto volatil)\n`;
  content += `- BOOTSTRAP.md — Ritual de onboarding (usado apenas na primeira sessao)\n`;
  content += `- conversations/ — Historico de conversas por data\n`;
  content += `- data/ — Banco de dados local e segredos\n`;
  content += `- agents/ — Definicoes de sub-agentes\n`;
  content += `- skills/ — Skills customizadas do usuario\n\n`;
  content += `### Gestao de memoria\n`;
  content += `Para registrar informacao nova, edite o arquivo fonte apropriado (USER.md, MEMORY.md, etc).\n`;
  content += `Este CLAUDE.md e regenerado automaticamente a cada boot do app.\n`;
  content += `Para efeito imediato na sessao atual, edite este arquivo diretamente.\n`;

  fs.writeFileSync(path.join(lionclawPath, 'CLAUDE.md'), content, 'utf-8');
  logger.info('Generated CLAUDE.md from source files');
}

const WATCHED_FILES = ['SOUL.md', 'RULES.md', 'USER.md', 'MEMORY.md'];

/**
 * Watch source files for changes and regenerate CLAUDE.md automatically.
 * Uses fs.watchFile (polling) instead of fs.watch because it works even
 * if the file doesn't exist yet (important for first-run/onboarding).
 */
function watchMemoryFiles(): void {
  const home = getLionClawHome();
  let regenerateTimeout: NodeJS.Timeout | null = null;

  for (const file of WATCHED_FILES) {
    const filePath = path.join(home, file);

    fs.watchFile(filePath, { interval: 2000 }, (curr, prev) => {
      if (curr.mtimeMs !== prev.mtimeMs) {
        // Debounce 500ms — multiple files may change at once (e.g. onboarding)
        if (regenerateTimeout) clearTimeout(regenerateTimeout);
        regenerateTimeout = setTimeout(() => {
          logger.info({ file }, 'Source file changed, regenerating CLAUDE.md');
          generateClaudeMd();
        }, 500);
      }
    });
  }

  logger.info({ files: WATCHED_FILES }, 'Watching memory files for changes');
}

/**
 * Stop watching memory files. Call on app quit.
 */
function stopWatchingMemoryFiles(): void {
  const home = getLionClawHome();
  for (const file of WATCHED_FILES) {
    fs.unwatchFile(path.join(home, file));
  }
}

function ensureBuiltinMCPServers(): void {
  const existing = getAllMCPServers();

  // Registry of all built-in MCP servers
  const builtinServers = [
    {
      id: 'memory-search',
      name: 'Memory Search',
      dir: 'memory-search',
      envKeys: ['OPENAI_API_KEY', 'COHERE_API_KEY'],
      isActive: true,
    },
    {
      id: 'excalidraw',
      name: 'Excalidraw',
      dir: 'excalidraw',
      envKeys: [] as string[],
      isActive: true,
    },
    {
      id: 'elevenlabs',
      name: 'ElevenLabs',
      dir: 'elevenlabs',
      envKeys: ['ELEVENLABS_API_KEY'],
      isActive: false,
    },
    {
      id: 'nano-banana',
      name: 'Nano Banana (Imagens)',
      dir: 'nano-banana',
      envKeys: ['GOOGLE_GEMINI_API_KEY'],
      isActive: false,
    },
    {
      id: 'shopify',
      name: 'Shopify',
      dir: 'shopify',
      envKeys: ['SHOPIFY_STORE_URL', 'SHOPIFY_CLIENT_ID', 'SHOPIFY_CLIENT_SECRET'],
      isActive: false,
    },
    // Google Calendar: usando o MCP built-in do Agent SDK (ja funciona)
    // Nossos custom MCPs: apenas Gmail e Drive
    {
      id: 'google-gmail',
      name: 'Gmail',
      dir: 'google-gmail',
      envKeys: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN', 'GOOGLE_ACCESS_TOKEN'],
      isActive: false,
    },
    {
      id: 'google-drive',
      name: 'Google Drive',
      dir: 'google-drive',
      envKeys: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN', 'GOOGLE_ACCESS_TOKEN'],
      isActive: false,
    },
    {
      id: 'google-sheets',
      name: 'Google Sheets',
      dir: 'google-sheets',
      envKeys: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN', 'GOOGLE_ACCESS_TOKEN'],
      isActive: false,
    },
    {
      id: 'youtube',
      name: 'YouTube',
      dir: 'youtube',
      envKeys: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN', 'GOOGLE_ACCESS_TOKEN'],
      isActive: false,
    },
    {
      id: 'google-calendar',
      name: 'Google Calendar',
      dir: 'google-calendar',
      envKeys: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN', 'GOOGLE_ACCESS_TOKEN'],
      isActive: false,
    },
    {
      id: 'local-llm',
      name: 'Local LLM',
      dir: 'local-llm',
      envKeys: [] as string[],
      isActive: true,
    },
    {
      id: 'knowledge-base',
      name: 'Knowledge Base',
      dir: 'knowledge-base',
      envKeys: [] as string[],
      isActive: true,
    },
    {
      id: 'skills',
      name: 'Skills',
      dir: 'skills',
      envKeys: [] as string[],
      isActive: true,
    },
    {
      id: 'graph-search',
      name: 'Graph Search',
      dir: 'graph-search',
      envKeys: [] as string[],
      isActive: true,
      conditional: 'mgraph_mode',
    },
  ];

  for (const srv of builtinServers) {
    // Registro condicional: so registra se a setting correspondente estiver habilitada
    if ('conditional' in srv && srv.conditional) {
      const settingVal = getSetting(srv.conditional as string);
      if (settingVal !== 'true') {
        logger.debug({ id: srv.id, condition: srv.conditional }, 'Built-in MCP server skipped (condition not met)');
        continue;
      }
    }
    const candidates = [
      path.join(__dirname, `../../mcp-servers/${srv.dir}/dist/index.js`),
      path.join(app.getAppPath(), `mcp-servers/${srv.dir}/dist/index.js`),
    ];
    const serverPath = candidates.find((p) => fs.existsSync(p));

    if (!serverPath) {
      logger.warn({ id: srv.id, candidates }, 'Built-in MCP server not found - skipping');
      continue;
    }

    const existingEntry = existing.find((s) => s.id === srv.id);
    if (existingEntry) {
      // Update path and env keys. For servers that start inactive (e.g. Google MCPs
      // that need OAuth first), preserve current isActive state instead of forcing true.
      const shouldBeActive = srv.isActive === false ? existingEntry.isActive : true;
      updateMCPServer(srv.id, {
        command: 'node',
        args: [serverPath],
        envKeys: srv.envKeys,
        isActive: shouldBeActive,
      });
      logger.info({ id: srv.id, serverPath, isActive: shouldBeActive }, 'Built-in MCP server updated');
    } else {
      createMCPServer({
        id: srv.id,
        name: srv.name,
        command: 'node',
        args: [serverPath],
        envKeys: srv.envKeys,
        isActive: srv.isActive,
      });
      logger.info({ id: srv.id, serverPath }, 'Built-in MCP server registered');
    }
  }

  // Remote MCPs: HTTP/SSE servers proxied via `mcp-remote` (stdio<->HTTP bridge
  // with OAuth handling). The bridge stores tokens in ~/.mcp-auth/, opens a
  // browser on first activation, then runs silently on subsequent boots.
  // Definicoes vivem em seed-mcps.ts (registry declarativo, fonte unica).
  const remoteServers = getRemoteSeedMcps();

  for (const srv of remoteServers) {
    const command = srv.command;
    const args = srv.args;
    const envKeys = srv.envKeys;
    const existingEntry = existing.find((s) => s.id === srv.id);
    if (existingEntry) {
      const shouldBeActive = srv.isActive === false ? existingEntry.isActive : true;
      updateMCPServer(srv.id, { command, args, envKeys, isActive: shouldBeActive });
      logger.info({ id: srv.id, command, args, envKeys, isActive: shouldBeActive }, 'Remote MCP server updated');
    } else {
      createMCPServer({
        id: srv.id,
        name: srv.name,
        command,
        args,
        envKeys,
        isActive: srv.isActive,
      });
      logger.info({ id: srv.id, command, args, envKeys }, 'Remote MCP server registered');
    }
  }

  // SPEC-001 §11.6 helper MCPs. Default visibleTo 'codex-lion-only' (Codex SDK +
  // Lion SDK surfaces); lionclaw-pipeline-control e a excecao visibleTo 'all'
  // (seam unico de pipeline-control para todos os runtimes, I6).
  // Dist layout differs from the standard built-ins: dist/<id>/src/index.js.
  const helperServers: Array<{ id: string; name: string; visibleTo?: 'all' | 'codex-lion-only' }> = [
    { id: 'lionclaw-agents', name: 'LionClaw Agents' },
    { id: 'lionclaw-skills', name: 'LionClaw Skills' },
    { id: 'lionclaw-user-question', name: 'LionClaw User Question' },
    // Helpers de efeito colateral com handshake de identidade (helper-identity.ts).
    // visibleTo 'all': subprocess e o seam unico para todos os runtimes; o gate de
    // caller (assertOrchestratorCaller) + arm-state (telegram) vive no dispatch
    // (jsonrpc-methods.ts).
    { id: 'lionclaw-preview', name: 'LionClaw Preview', visibleTo: 'all' },
    { id: 'lionclaw-telegram', name: 'LionClaw Telegram', visibleTo: 'all' },
    // tools pipeline_* do drive do orquestrador. visibleTo 'all': o tool-search do
    // Claude SO indexa MCP de SUBPROCESS (nao in-process via createSdkMcpServer),
    // entao este subprocess e o seam UNICO de pipeline para TODOS os runtimes
    // (Claude/Compat/Codex/Lion) - findavel via tool-search/MCP em todos. Gate de
    // WRITE/caller no dispatch (jsonrpc-methods.ts) protege contra subagentes.
    { id: 'lionclaw-pipeline-control', name: 'LionClaw Pipeline Control', visibleTo: 'all' },
    // (SPEC-010 14.1) tools dynamic_workflow_* do orquestrador. visibleTo 'all':
    // subprocess e o seam UNICO de dynamic-workflow-control para TODOS os runtimes
    // (Claude/Compat/Codex/Lion), findavel via tool-search/MCP. Gate de WRITE/caller
    // no dispatch (jsonrpc-methods.ts) protege contra subagentes. Anuncio condicional
    // ao modelo via buildDynamicWorkflowSection() (prompt-builder.ts).
    { id: 'lionclaw-dynamic-workflows', name: 'LionClaw Dynamic Workflows', visibleTo: 'all' },
    // (SPEC kanban-nativo secao 4) tools board_*/card_* do Kanban nativo.
    // visibleTo 'all': subprocess e o seam unico para todos os runtimes; SEM
    // gate de caller no dispatch (D6: scheduler usa a mesma superficie; actor
    // resolvido por chamada em jsonrpc-methods.ts via kanban-actor.ts).
    { id: 'lionclaw-kanban', name: 'LionClaw Kanban', visibleTo: 'all' },
    // (A2) tools repo_graph_* (reader-only) do repo mode do chat. visibleTo
    // 'all' (F10): subprocess e o seam unico para todos os runtimes; o anuncio
    // condicional ao modelo vem de buildRepoGraphSection()
    // (prompt-builder-repo-graph.ts), SO com repo ativo + graph ready/stale.
    // Escrita (build/update) NAO existe no dispatch agent-facing (5.2).
    { id: 'repo-graph', name: 'Repo Graph', visibleTo: 'all' },
  ];

  // (Fase B, SPEC chat-context-reduction B.1/B.8) runner do Tool Script:
  // helper stdio REAL, always-on, visibleTo 'all' (mesmo seam unico dos demais
  // helpers — os 5 runtimes o recebem pela composicao, sem codigo por
  // runtime). Registro CONDICIONADO (S4) a python3 presente E ao setting
  // tool_script_enabled (V128). Qualquer um ausente -> nao registra E desativa
  // um registro de boot anterior (senao o updateMCPServer do loop abaixo /
  // startActiveMCPServers ressuscitariam o server) — rollback AC-B10/AC-B12.
  const toolScriptDecision = resolveToolScriptRegistration();
  if (toolScriptDecision.register) {
    helperServers.push({ id: 'lionclaw-toolscript', name: 'LionClaw Tool Script', visibleTo: 'all' });
  } else {
    logger.warn(
      { available: toolScriptDecision.available, enabled: toolScriptDecision.enabled },
      `Tool Script indisponivel (${toolScriptDecision.reason ?? 'razao desconhecida'}): helper lionclaw-toolscript NAO registrado no boot`,
    );
    const staleToolScript = existing.find((s) => s.id === 'lionclaw-toolscript');
    if (staleToolScript !== undefined && staleToolScript.isActive) {
      updateMCPServer('lionclaw-toolscript', { isActive: false });
      logger.info(
        'helper lionclaw-toolscript de boot anterior DESATIVADO (rollback por disponibilidade/setting)',
      );
    }
  }

  for (const helper of helperServers) {
    const candidates = [
      path.join(__dirname, `../../mcp-servers/${helper.id}/dist/${helper.id}/src/index.js`),
      path.join(app.getAppPath(), `mcp-servers/${helper.id}/dist/${helper.id}/src/index.js`),
    ];
    const serverPath = candidates.find((p) => fs.existsSync(p));

    if (!serverPath) {
      logger.warn({ id: helper.id, candidates }, 'Helper MCP server not found - skipping');
      continue;
    }

    const existingEntry = existing.find((s) => s.id === helper.id);
    if (existingEntry) {
      updateMCPServer(helper.id, {
        command: 'node',
        args: [serverPath],
        envKeys: [],
        isActive: true,
        visibleTo: helper.visibleTo ?? 'codex-lion-only',
      });
      logger.info({ id: helper.id, serverPath }, 'Helper MCP server updated');
    } else {
      createMCPServer({
        id: helper.id,
        name: helper.name,
        command: 'node',
        args: [serverPath],
        envKeys: [],
        isActive: true,
        visibleTo: helper.visibleTo ?? 'codex-lion-only',
      });
      logger.info({ id: helper.id, serverPath }, 'Helper MCP server registered');
    }
  }
}

// Register custom protocol for serving local assets (must be before app.ready)
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'lionclaw-asset',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
  // (SPEC kanban-nativo 6.1) anexos do Kanban no viewer in-app (img/PDF). SEM
  // supportFetchAPI de proposito: fetch de protocolo custom cai no default-src
  // da CSP; markdown/texto vao pelo IPC kanban:read-attachment.
  {
    scheme: 'lionclaw-kanban',
    privileges: { standard: true, secure: true },
  },
]);

app.whenReady().then(async () => {
  logger.info('LionClaw starting...');

  // Hide GTK menubar on Linux (default Electron menu is noisy and unused on this app).
  // macOS keeps its native menu; Windows menubar is hidden via BrowserWindow's titleBarStyle.
  if (process.platform === 'linux') {
    Menu.setApplicationMenu(null);
  }

  // Set dock icon on macOS (needed for dev mode)
  if (process.platform === 'darwin' && app.dock) {
    const iconPath = path.join(__dirname, '../../resources/icon.png');
    if (fs.existsSync(iconPath)) {
      app.dock.setIcon(iconPath);
    }
  }

  // 0a. Register protocol handler for local assets + excalidraw views
  protocol.handle('lionclaw-asset', (request) => {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // Serve Excalidraw view HTML: lionclaw-asset://host/excalidraw-view/{viewId}
    if (pathname.startsWith('/excalidraw-view/')) {
      const viewId = pathname.replace('/excalidraw-view/', '');
      const view = getExcalidrawView(viewId);
      if (!view) {
        return new Response('View not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
      }

      const sceneJson = JSON.stringify({
        elements: view.elements,
        appState: { viewBackgroundColor: '#191919', theme: 'dark', ...view.appState },
        files: {},
      }).replace(/<\/script>/gi, '<\\/script>');

      const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body,#root{width:100%;height:100%;overflow:hidden;background:#191919}
.loading{display:flex;align-items:center;justify-content:center;height:100%;color:#888;font-family:system-ui;font-size:14px}
.error{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:#ef4444;font-family:system-ui;font-size:13px;padding:20px;text-align:center;gap:8px}
.excalidraw .App-menu,
.excalidraw .layer-ui__wrapper__top-right,
.excalidraw .layer-ui__wrapper__footer,
.excalidraw .Island,
.excalidraw .HintViewer,
.excalidraw .ToolIcon,
.excalidraw .App-toolbar,
.excalidraw .App-bottom-bar,
.excalidraw .MainMenu,
.excalidraw .main-menu-trigger,
.excalidraw .undo-redo-buttons,
.excalidraw .help-icon,
.excalidraw .zoom-actions,
.excalidraw .footer-center,
.excalidraw button:not(.excalidraw-button){display:none!important}
.excalidraw .layer-ui__wrapper{pointer-events:none}
</style>
</head>
<body>
<div id="root"><div class="loading">Carregando Excalidraw...</div></div>
<script>window.__EXCALIDRAW_SCENE__=${sceneJson};</script>
<script src="lionclaw-asset://host/excalidraw-bundle.js"></script>
<script>
(async function(){
  try{
    var scene=window.__EXCALIDRAW_SCENE__;
    var svg=await ExcalidrawBundle.exportToSvg({
      elements:scene.elements||[],
      appState:scene.appState||{},
      files:scene.files||{}
    });
    svg.style.width='100%';
    svg.style.height='100%';
    var el=document.getElementById('root');
    el.innerHTML='';
    el.appendChild(svg);
  }catch(err){
    document.getElementById('root').innerHTML='<div class="error"><span>Erro: '+err.message+'</span></div>';
  }
})();
</script>
</body>
</html>`;

      return new Response(html, { headers: { 'Content-Type': 'text/html' } });
    }

    // Serve locked design HTML: lionclaw-asset://host/locked-design/{projectId}
    // O HTML do design pode importar Google Fonts, Three.js do CDN, etc. — a
    // CSP do app inteira (index.html) restringe a `'self' lionclaw-asset:`, o
    // que quebra esses recursos quando o iframe usa `srcdoc` (herda o CSP do
    // parent). Servindo via protocolo dedicado, podemos emitir um CSP proprio
    // permissivo APENAS para o iframe sandboxed do LockedDesignViewer.
    if (pathname.startsWith('/locked-design/')) {
      try {
        const projectId = decodeURIComponent(pathname.replace('/locked-design/', ''));
        const cfg = getOpenDesignConfig(projectId);
        if (!cfg?.runDir) {
          return new Response('Design nao travado', { status: 404, headers: { 'Content-Type': 'text/plain' } });
        }
        const htmlPath = cfg.artifactHtmlPath
          ?? path.join(cfg.runDir, 'open-design', 'snapshots', 'latest', 'artifact', 'index.html');
        const snapshotDir = cfg.snapshotDir
          ?? path.join(cfg.runDir, 'open-design', 'snapshots', 'latest');
        const resolvedHtml = path.resolve(htmlPath);
        const resolvedDir = path.resolve(snapshotDir);
        if (!resolvedHtml.startsWith(resolvedDir + path.sep) && resolvedHtml !== resolvedDir) {
          return new Response('path fora do snapshotDir', { status: 403, headers: { 'Content-Type': 'text/plain' } });
        }
        if (!fs.existsSync(resolvedHtml)) {
          return new Response('Arquivo nao encontrado', { status: 404, headers: { 'Content-Type': 'text/plain' } });
        }
        const html = fs.readFileSync(resolvedHtml, 'utf-8');
        // CSP permissiva apenas para esse documento — runs em iframe sandboxed
        // pelo LockedDesignViewer (sem allow-same-origin), entao mesmo com
        // permissoes amplas o iframe nao acessa o DOM/cookies do app host.
        const previewCsp = [
          "default-src * data: blob: 'unsafe-inline' 'unsafe-eval'",
          "script-src * data: blob: 'unsafe-inline' 'unsafe-eval'",
          "style-src * data: blob: 'unsafe-inline'",
          "font-src * data: blob:",
          "img-src * data: blob:",
          "connect-src * data: blob:",
        ].join('; ');
        return new Response(html, {
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Security-Policy': previewCsp,
          },
        });
      } catch (err) {
        return new Response(`Erro ao servir design: ${(err as Error).message}`, {
          status: 500,
          headers: { 'Content-Type': 'text/plain' },
        });
      }
    }

    // Serve imagem local arbitraria referenciada pelo agente no chat:
    //   lionclaw-asset://host/local-image/<absPath via encodeURIComponent>
    // App single-user/single-machine: o agente ja tem acesso ao FS; aqui apenas
    // exibimos uma imagem que ele gerou/referenciou, sem expor file:// (bloqueado
    // pela CSP) nem descartar o caminho local. Escopo: apenas extensoes de imagem.
    if (pathname.startsWith('/local-image/')) {
      try {
        const abs = path.resolve(decodeURIComponent(pathname.replace('/local-image/', '')));
        const ext = path.extname(abs).toLowerCase();
        const allowed = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.bmp', '.avif'];
        if (!allowed.includes(ext)) {
          return new Response('Tipo de arquivo nao permitido', { status: 403, headers: { 'Content-Type': 'text/plain' } });
        }
        if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
          return new Response('Imagem nao encontrada', { status: 404, headers: { 'Content-Type': 'text/plain' } });
        }
        return net.fetch(pathToFileURL(abs).href);
      } catch (err) {
        return new Response(`Erro ao servir imagem: ${(err as Error).message}`, { status: 500, headers: { 'Content-Type': 'text/plain' } });
      }
    }

    // Serve a REMOTE image referenced by the agent in chat (image-gen MCPs like Higgsfield return
    // https URLs). The chat img-src CSP blocks remote http(s), so the main process fetches the
    // bytes here (no CSP) and serves them back via lionclaw-asset:. Single-user/single-machine: the
    // agent already has network access, so proxying an image URL it produced adds no new capability.
    //   lionclaw-asset://host/remote-image/<https URL via encodeURIComponent>
    if (pathname.startsWith('/remote-image/')) {
      const remoteUrl = decodeURIComponent(pathname.replace('/remote-image/', ''));
      if (!/^https?:\/\//i.test(remoteUrl)) {
        return new Response('URL remota invalida', { status: 400, headers: { 'Content-Type': 'text/plain' } });
      }
      return net.fetch(remoteUrl);
    }

    // Serve static files from resources/ directory
    const candidates = [
      path.join(__dirname, '../../resources', pathname),
      path.join(app.getAppPath(), 'resources', pathname),
    ];
    const filePath = candidates.find((p) => fs.existsSync(p));
    if (filePath) {
      return net.fetch(pathToFileURL(filePath).href);
    }
    return new Response('Not found', { status: 404 });
  });

  // 0a2. (SPEC kanban-nativo 6.1) lionclaw-kanban://<attachment_id> — serve o
  // arquivo fisico de um anexo do Kanban para o viewer in-app (img inline e
  // PDF via iframe; a CSP do index.html ganhou lionclaw-kanban: em
  // img-src/frame-src, e NADA alem). O id e resolvido na tabela
  // kanban_card_attachments e o engine valida que o path resolvido fica SOB
  // ~/.lionclaw/kanban/ (sem path traversal). Precedente: lionclaw-asset.
  protocol.handle('lionclaw-kanban', (request) => {
    try {
      const url = new URL(request.url);
      // Scheme standard: o id (uuid lowercase) chega como host; fallback no
      // pathname cobre forma com barra.
      const attachmentId = decodeURIComponent(url.hostname || url.pathname.replace(/^\/+/, ''));
      const resolved = getKanbanEngine().resolveAttachment(attachmentId);
      if ('error' in resolved) {
        return new Response(resolved.error, {
          status: 404,
          headers: { 'Content-Type': 'text/plain' },
        });
      }
      return net.fetch(pathToFileURL(resolved.absolutePath).href);
    } catch (err) {
      return new Response(`Erro ao servir anexo: ${(err as Error).message}`, {
        status: 500,
        headers: { 'Content-Type': 'text/plain' },
      });
    }
  });

  // 0b. Ensure .lionclaw files exist
  ensureLionClawFiles();

  // 0b2. Copy default skills (e.g. skill-creator) if not present
  copyDefaultSkills();

  // 0c. Generate CLAUDE.md from source files (SOUL, RULES, USER, MEMORY)
  generateClaudeMd();

  // 0d. Watch source files for changes and regenerate CLAUDE.md automatically
  watchMemoryFiles();

  // 1. Initialize SQLite database
  // SPEC robustez-chat SB-7 (P7, AC-B17): migration que lanca no boot mostra
  // dialog.showErrorBox (DB-MIGRATION + path do banco) ANTES de createWindow e
  // encerra o app — nunca janela em branco muda com o banco quebrado.
  try {
    initDatabase();
  } catch (error) {
    logger.error({ err: error }, 'Database initialization failed at boot');
    const box = buildDbMigrationErrorBox(error, getDatabaseFilePath());
    dialog.showErrorBox(box.title, box.message);
    app.quit();
    return;
  }
  seedToolDefaults();
  await ensureAllSeedAgents();
  ensureDreamingSkillFrontmatter();
  logger.info('Database initialized');

  // 1.1 SPEC telegram-cron-compaction 10: migracao de upgrade (primeiro boot) —
  // move os .jsonl das sessoes Telegram ativas do diretorio de projeto do
  // antigo background CWD para o de ~/.lionclaw, para a conversa em andamento
  // retomar com o contexto vivo intacto. Idempotente; apos initDatabase e antes
  // de startTelegramBot; falha NUNCA derruba o boot.
  try {
    const { moved } = migrateTelegramJsonlOnBoot();
    if (moved > 0) {
      logger.info({ moved }, 'Telegram: jsonl de sessao ativa migrado no boot (SPEC 10)');
    }
  } catch (error) {
    logger.warn({ error }, 'Telegram: migracao de jsonl no boot falhou (boot continua)');
  }

  // Register external provider vault entries (OpenRouter, OpenAI) so they appear in the Vault UI
  registerExternalProviderVaultEntries();

  // 1.5 Start Knowledge Base IPC bridge (UDS for MCP subprocess)
  // Await to guarantee socket exists before MCPs try to connect
  await startKnowledgeBridge();
  logger.info('Knowledge bridge started');

  // 1.6 Start ingest queue watcher (monitors .ingest-queue for MCP graph_ingest jobs)
  if (getSetting('mgraph_mode') === 'true') {
    startIngestQueueWatcher();
    logger.info('Ingest queue watcher started');
  }

  // 2. Register all IPC handlers
  harnessEngine = new HarnessEngine(() => mainWindow);
  pipelineEngine = new PipelineEngine(() => mainWindow, harnessEngine);
  // SPEC pipe-control S4: expoe o MESMO getter do engine para as tools
  // pipeline-control (in-process MCP do orquestrador, sem ctx).
  registerPipelineEngineRef(() => pipelineEngine);
  // SPEC pipe-control S6: coordenador de drive (event-driven). Assina o
  // pipeline-event-bus, espelha config.drive em RAM e roda o recovery de boot
  // (drives 'driving' -> 'awaiting-human', NAO retoma sozinho; AC-20). ADITIVO:
  // so escuta o bus e chama metodos publicos do PipelineEngine.
  initPipelineDriveCoordinator(getMainWindow);
  // (F4 - SPEC estrada-fixes) cache de pipeline:phase-changed das tools
  // pipeline_*: o estado awaiting-dev-confirmation (gate pre-codigo) so transita
  // no bus; pipelineApproveCore consulta este cache para mapear o approve em
  // confirmStartDevelopment. Assinado AQUI (antes de qualquer pipeline rodar),
  // mesmo padrao do coordinator.
  startPipelineControlPhaseCache();
  registerIPCHandlers(getMainWindow, () => harnessEngine, () => pipelineEngine);
  logger.info('IPC handlers registered');

  // 2.4 (SPEC-010 10.3/AC-25) Boot recovery do dynamic-workflow: garante o runner
  //     construido com deps reais e recupera runs que ficaram `running` apos um
  //     crash (running -> interrupted; aguardam Retomar - nenhuma morte silenciosa,
  //     13.8). try/catch proprio: falha de recovery NUNCA derruba o boot (mesmo
  //     padrao de startActiveMCPServers). Unico ponto de chamada do recovery.
  try {
    const { recovered } = await recoverWorkflowRunsOnBoot();
    logger.info({ recovered }, 'Dynamic workflow boot recovery complete');
  } catch (error) {
    logger.error({ error }, 'Dynamic workflow boot recovery failed (boot continues)');
  }

  // 2.5 Ensure built-in MCP servers exist
  ensureBuiltinMCPServers();

  // 2.6 Start local IPC server BEFORE spawning helper MCPs so they can read
  //     ipc-endpoint.json at startup (SPEC §15 boot order; SPEC §11.6).
  await startLocalIpcServer();

  // 2.7 Restore remote MCP OAuth sessions materialized from Vault before any
  //     SDK or MCP subprocess starts. Higgsfield uses mcp-remote's OAuth store,
  //     with the Vault as the encrypted source of truth.
  try {
    await restoreHiggsfieldSessionFromVault();
    watchHiggsfieldSession();
  } catch (error) {
    logger.warn({ error }, 'Failed to restore Higgsfield MCP session from Vault');
  }

  // 3. Start MCP servers
  try {
    await startActiveMCPServers();
  } catch (error) {
    logger.error({ error }, 'Failed to start some MCP servers');
  }

  // 3.1 Sync Codex MCP config (LIONCLAW_MANAGED block in ~/.codex/config.toml).
  //     Stub in Sprint 8; real body lands in Sprint 9 (SPEC §11.3).
  await syncCodexMcpConfig();

  // 3.5 Discover SDK MCP servers in background
  discoverSDKMcpServers().catch((err) => {
    logger.warn({ err }, 'Background MCP discovery failed - will retry on page load');
  });

  // 4. Start scheduler
  startScheduler(getMainWindow);
  logger.info('Scheduler started');

  // 5. Start Telegram bot in background (fire-and-forget). Telegram startup
  //    awaits getSecret() which can hang silently on keytar/keychain reads,
  //    so it MUST NOT block window creation. Boot order anchor preserved per
  //    SPEC-001 §16 #47: startTelegramBot still appears before createWindow.
  void startTelegramBot(getMainWindow).catch((error) => {
    logger.error({ error }, 'Failed to start Telegram bot');
  });

  // 6. Create the window
  createWindow();

  // 6.1 Expose the main window to the local-ipc server so the
  //     ask_user_question RPC can reach the renderer (SPEC §11.6).
  registerWindowProvider(getMainWindow);

  // 6.2 Wrapper central de invoke MCP (SPEC mcp-index-invoke 4): injeta o
  //     supplier de janela e instancia o permission guard das meta-tools
  //     (AC-13) — mesmo desenho do gatePipelineWrite/registerWindowProvider.
  initMcpInvoke({ getWindow: getMainWindow });

  // 6.5 Kick off Open Design vendor install in background (SPEC L457-462).
  // Idempotente: no-op se sentinela + node_modules ja presentes; senao
  // dispara `pnpm install --frozen-lockfile`. UI observa via IPC.
  void import('./open-design/boot-installer')
    .then((m) => m.ensureVendorReady())
    .catch((err) => {
      logger.error({ err }, 'open-design: ensureVendorReady kickoff failed');
    });

  // 6.6 Checagem do Node do sidecar Cursor (SPEC cursor-runtime E3): valida
  //     Node >=22.13 (dev: sistema; empacotado: interno) em background, com
  //     erro claro no log. Nao bloqueia o boot; status consultavel pelo
  //     executor via getCursorSidecarNodeStatus.
  void import('./agent-runtime/cursor-sidecar/node-resolver')
    .then((m) => m.checkCursorSidecarNodeAtBoot())
    .catch((err) => {
      logger.error({ err }, 'cursor-sidecar: checagem de Node no boot falhou');
    });

  // 6.7 Cleanup dos workspaces de chat cursor (SPEC cursor-runtime E9, secao
  //     "Rules materializadas"): remove residuos de crash/reset/troca de
  //     agente — as rules materializadas carregam SOUL/USER/MEMORY e cada
  //     turno re-materializa o proprio workspace.
  void import('./cursor-sdk/workspace')
    .then((m) => m.cleanupCursorChatWorkspaces())
    .catch((err) => {
      logger.error({ err }, 'cursor-sdk: cleanup de workspaces de chat no boot falhou');
    });

  // 6. Initialize auto-updater (production only)
  if (process.env.NODE_ENV !== 'development') {
    const updaterLogger = createLogger('auto-updater');

    autoUpdater.on('checking-for-update', () => {
      updaterLogger.info('Checking for update...');
    });

    autoUpdater.on('update-available', (info) => {
      updaterLogger.info({ version: info.version }, 'Update available');
    });

    autoUpdater.on('update-not-available', (info) => {
      updaterLogger.info({ version: info.version }, 'Update not available');
    });

    autoUpdater.on('download-progress', (progress) => {
      updaterLogger.info(
        { percent: Math.floor(progress.percent), bytesPerSecond: Math.floor(progress.bytesPerSecond) },
        'Update download progress'
      );
    });

    autoUpdater.on('update-downloaded', (info) => {
      updaterLogger.info({ version: info.version }, 'Update downloaded, will install on next restart');
    });

    autoUpdater.on('error', (error) => {
      updaterLogger.error({ error: error.message }, 'Auto-updater error');
    });

    autoUpdater.checkForUpdatesAndNotify().catch((error) => {
      updaterLogger.error({ error: error.message }, 'Failed to check for updates');
    });
  }

  // 7. Register power monitor events for auto-lock on sleep or lid close
  powerMonitor.on('suspend', () => {
    lockSession('suspend');
  });

  powerMonitor.on('lock-screen', () => {
    lockSession('lock-screen');
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });

  logger.info('LionClaw ready');
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

ipcMain.handle('app:check-update', async () => {
  await autoUpdater.checkForUpdatesAndNotify();
});

ipcMain.handle('app:get-version', () => {
  const version = getAppVersion();
  return {
    version,
    label: formatAppVersionLabel(version),
  };
});

let isQuitting = false;
app.on('before-quit', async (e) => {
  if (isQuitting) return; // Already cleaning up, let it proceed
  isQuitting = true;
  e.preventDefault();
  // SPEC terminal-chat DN-6: mata os shells do terminal integrado PRIMEIRO
  // (sincrono e barato) — este handler tem awaits de rede no meio e termina em
  // app.exit(0), que NAO emite will-quit; um await pendurado nao pode deixar
  // shells vivos.
  try { killAllTerminalSessions(); } catch { /* ignore */ }
  stopWatchingMemoryFiles();
  stopIngestQueueWatcher();
  // SPEC telegram-cron-compaction 1.3: aborta queries em voo das lanes
  // telegram/cron para um cron ou turno de Telegram longo nao travar o
  // encerramento. Toca APENAS as lanes proprias (desktop intocado).
  try { stopTelegramQuery(); } catch { /* ignore */ }
  try { stopCronQuery(); } catch { /* ignore */ }
  try { await stopTelegramBot(); } catch { /* ignore */ }
  stopScheduler();
  stopAllMCPServers();
  try { await stopLocalIpcServer(); } catch { /* ignore */ }
  stopKnowledgeBridge();
  // F-3 (gate codex-chat-persistent): fecha as threads persistentes do chat
  // Codex oficial (processos app-server imunes ao idle-reaper). Sem laneName =
  // todas (o braco de shutdown do helper).
  try {
    const { closeAllCachedChatCodexSessions } = await import('./codex-sdk');
    closeAllCachedChatCodexSessions('app-shutdown');
  } catch { /* ignore */ }
  // Drivers Codex oficiais dos pipelines/agentes (app-servers fora do cache do
  // chat) — sem isso, quit deixa processo codex app-server orfao.
  try {
    const { shutdownOfficialCodexDrivers } = await import('./agent-runtime/codex-session-factory');
    await shutdownOfficialCodexDrivers('app-shutdown');
  } catch { /* ignore */ }
  try {
    const { stopAll } = await import('./open-design/manager');
    await stopAll();
  } catch { /* ignore */ }
  try {
    const { getKimiBridgeRegistry } = await import('./kimi-acp/mcp-bridge-registry');
    await getKimiBridgeRegistry().stopAll();
  } catch { /* ignore */ }
  try { await shutdownKimiRuntime(); } catch { /* ignore */ }
  try { await shutdownGrokRuntime(); } catch { /* ignore */ }
  // Sidecars Node do runtime Cursor (SPEC cursor-runtime E3): kill no
  // shutdown do app — sem isso, quit deixa processo Node orfao com run vivo.
  try {
    const { shutdownCursorSidecars } = await import('./agent-runtime/cursor-sidecar/sidecar-manager');
    await shutdownCursorSidecars('app-shutdown');
  } catch { /* ignore */ }
  logger.info('Cleanup complete, quitting');
  app.exit(0);
});

export { getMainWindow };
