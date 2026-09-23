import './boot-env-snapshot';
import { getSwarmService } from './swarm';
import { startSwarmDeliveryPump } from './swarm/delivery';
import { app, BrowserWindow, Menu, shell, powerMonitor, ipcMain, protocol, net, dialog } from 'electron';
import { pathToFileURL } from 'url';
import fs from 'fs';
import path from 'path';
import { autoUpdater } from 'electron-updater';
import { initDatabase, seedToolDefaults, getSetting, setSetting, getDatabaseFilePath } from './db';
import { buildDbMigrationErrorBox } from './db-init-error';
import { ensureAllSeedAgents } from './seed-agents/ensure';
import { registerIPCHandlers } from './ipc-handlers';
import { rebuildClearingSessionsOnBoot } from './chat-clear';
import { startScheduler, stopScheduler } from './scheduler';
import { startTelegramBot, stopTelegramBot } from './telegram-bridge';
import { stopTelegramQuery, stopCronQuery, stopCurrentQuery } from './orchestrator';
import { killAllTerminalSessions } from './terminal-pty';
import { migrateTelegramJsonlOnBoot } from './telegram-jsonl-migration';
import {
  startActiveMCPServers,
  stopAllMCPServers,
  getAllMCPServers,
  createMCPServer,
  updateMCPServer,
} from './mcp-manager';
import { initMcpInvoke } from './mcp-invoke';
import { discoverSDKMcpServers } from './mcp-discovery';
import { getExcalidrawView } from './excalidraw-views';
import { HTML_ARTIFACT_PROTOCOL_PREFIX, serveHtmlArtifact } from './html-artifact';
import { getKanbanEngine } from './kanban-engine';
import { resolveMcpServerEntry } from './mcp-path-resolver';
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
import { recoverWorkflowRunsOnBoot } from './dynamic-workflows/workflow-control-core';
import { startIngestQueueWatcher, stopIngestQueueWatcher } from './graph-ingest';
import { formatAppVersionLabel, getAppVersion } from './app-version';
import { getOpenDesignConfig } from './open-design/config';
import {
  startLocalIpcServer,
  stopLocalIpcServer,
  registerWindowProvider,
  publishExternalClientServers,
} from './local-ipc';
import { resolveToolScriptRegistration } from './tool-script/tool-script-availability';
import { syncCodexMcpConfig } from './codex-sdk/mcp-config-sync';
import { restoreHiggsfieldSessionFromVault, watchHiggsfieldSession } from './higgsfield-auth';
import { getRemoteSeedMcps } from './seed-mcps';

const logger = createLogger('main');

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
}

if (process.platform === 'linux' && process.env.LIONCLAW_ENABLE_HARDWARE_ACCELERATION !== '1') {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
}

if (process.platform !== 'win32' && !process.env.CLAUDE_CODE_SHELL) {
  const agentBash = ['/bin/bash', '/usr/bin/bash'].find((p) => fs.existsSync(p));
  if (agentBash) process.env.CLAUDE_CODE_SHELL = agentBash;
}

process.env.CLAUDE_CODE_ENABLE_TODO_TOOLS = '1';

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

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, async () => {
    logger.info({ signal }, 'Received signal, cleaning up');
    try {
      killAllTerminalSessions();
    } catch {
      /* ignore */
    }
    try {
      stopCurrentQuery();
    } catch {
      /* ignore */
    }
    try {
      stopTelegramQuery();
    } catch {
      /* ignore */
    }
    try {
      stopCronQuery();
    } catch {
      /* ignore */
    }
    try {
      await stopTelegramBot();
    } catch {
      /* ignore */
    }
    try {
      await shutdownGrokRuntime();
    } catch {
      /* ignore */
    }
    try {
      await shutdownKimiRuntime();
    } catch {
      /* ignore */
    }
    try {
      const { shutdownCursorSidecars } = await import('./agent-runtime/cursor-sidecar/sidecar-manager');
      await shutdownCursorSidecars(signal);
    } catch {
      /* ignore */
    }
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

  const isInternalNavigation = (target: string): boolean => {
    const current = mainWindow?.webContents.getURL() ?? '';
    if (!current) return false;
    try {
      const to = new URL(target);
      const from = new URL(current);
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

  const dirs = [
    'data',
    'data/sessions',
    'agents',
    'skills',
    'conversations',
    'background',
    'cron',
    'artifacts',
    'artifacts/state',
  ];
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

  const claudeSettingsDir = path.join(lionclawPath, '.claude');
  fs.mkdirSync(claudeSettingsDir, { recursive: true });
  const claudeSettingsPath = path.join(claudeSettingsDir, 'settings.json');
  if (!fs.existsSync(claudeSettingsPath)) {
    fs.writeFileSync(claudeSettingsPath, JSON.stringify({}, null, 2), 'utf-8');
    logger.info('Created empty .claude/settings.json to isolate SDK settings');
  }

  const bgClaudeMd = path.join(lionclawPath, 'background', 'CLAUDE.md');
  if (!fs.existsSync(bgClaudeMd)) {
    fs.writeFileSync(
      bgClaudeMd,
      [
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
      ].join('\n'),
      'utf-8',
    );
    logger.info('Created background/CLAUDE.md for isolated cron/telegram subprocess');
  }
  const bgClaudeDir = path.join(lionclawPath, 'background', '.claude');
  fs.mkdirSync(bgClaudeDir, { recursive: true });
  const bgSettingsPath = path.join(bgClaudeDir, 'settings.json');
  if (!fs.existsSync(bgSettingsPath)) {
    fs.writeFileSync(bgSettingsPath, JSON.stringify({}, null, 2), 'utf-8');
  }

  const cronClaudeMd = path.join(lionclawPath, 'cron', 'CLAUDE.md');
  if (!fs.existsSync(cronClaudeMd)) {
    fs.writeFileSync(
      cronClaudeMd,
      [
        '# LionClaw Cron Worker',
        '',
        'Voce e um worker de tarefa agendada. Execute a tarefa do prompt e encerre.',
        'Voce nao tem continuidade, nao conhece conversas anteriores, nao tem acesso ao Telegram nem ao chat do usuario.',
        'Reporte o resultado e pare.',
        'Responda em portugues brasileiro.',
        'Nao faca git push.',
        'Nao modifique arquivos de sistema sem que a tarefa mande.',
      ].join('\n'),
      'utf-8',
    );
    logger.info('Created cron/CLAUDE.md (persona de worker da cronLane)');
  }
  const cronClaudeDir = path.join(lionclawPath, 'cron', '.claude');
  fs.mkdirSync(cronClaudeDir, { recursive: true });
  const cronSettingsPath = path.join(cronClaudeDir, 'settings.json');
  if (!fs.existsSync(cronSettingsPath)) {
    fs.writeFileSync(cronSettingsPath, JSON.stringify({}, null, 2), 'utf-8');
  }
}

function copyDefaultSkills(): void {
  const destSkills = path.join(getLionClawHome(), 'skills');

  const templateDirs = [
    path.join(__dirname, '../../.lionclaw/skills'), // dev mode
    path.join(app.getAppPath(), '.lionclaw/skills'), // packaged
  ];

  const templateDir = templateDirs.find((d) => fs.existsSync(d));
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

function ensureDreamingSkillFrontmatter(): void {
  try {
    if (getSetting('dreaming_frontmatter_migrated') === 'true') return;

    const userSkillPath = path.join(getLionClawHome(), 'skills', 'dreaming', 'SKILL.md');

    if (!fs.existsSync(userSkillPath)) {
      setSetting('dreaming_frontmatter_migrated', 'true');
      return;
    }

    const content = fs.readFileSync(userSkillPath, 'utf-8');

    if (content.startsWith('---')) {
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

    fs.writeFileSync(userSkillPath, frontmatter + content, 'utf-8');
    setSetting('dreaming_frontmatter_migrated', 'true');
    logger.info({ skill: 'dreaming' }, 'Injected frontmatter into existing skill');
  } catch (err) {
    logger.warn({ err }, 'ensureDreamingSkillFrontmatter failed; will retry on next boot');
  }
}

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

function watchMemoryFiles(): void {
  const home = getLionClawHome();
  let regenerateTimeout: NodeJS.Timeout | null = null;

  for (const file of WATCHED_FILES) {
    const filePath = path.join(home, file);

    fs.watchFile(filePath, { interval: 2000 }, (curr, prev) => {
      if (curr.mtimeMs !== prev.mtimeMs) {
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

function stopWatchingMemoryFiles(): void {
  const home = getLionClawHome();
  for (const file of WATCHED_FILES) {
    fs.unwatchFile(path.join(home, file));
  }
}

function ensureBuiltinMCPServers(): void {
  const existing = getAllMCPServers();

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

  const helperServers: Array<{ id: string; name: string; visibleTo?: 'all' | 'codex-lion-only' }> = [
    { id: 'lionclaw-agents', name: 'LionClaw Agents' },
    { id: 'lionclaw-skills', name: 'LionClaw Skills' },
    { id: 'lionclaw-user-question', name: 'LionClaw User Question' },
    { id: 'lionclaw-preview', name: 'LionClaw Preview', visibleTo: 'all' },
    { id: 'lionclaw-telegram', name: 'LionClaw Telegram', visibleTo: 'all' },
    { id: 'lionclaw-pipeline-control', name: 'LionClaw Pipeline Control', visibleTo: 'all' },
    { id: 'lionclaw-swarm', name: 'LionClaw Swarm', visibleTo: 'all' },
    { id: 'lionclaw-dynamic-workflows', name: 'LionClaw Dynamic Workflows', visibleTo: 'all' },
    { id: 'lionclaw-kanban', name: 'LionClaw Kanban', visibleTo: 'all' },
    { id: 'repo-graph', name: 'Repo Graph', visibleTo: 'all' },
  ];

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
      logger.info('helper lionclaw-toolscript de boot anterior DESATIVADO (rollback por disponibilidade/setting)');
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

  publishKanbanEntryForExternalClients();
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'lionclaw-asset',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
  {
    scheme: 'lionclaw-kanban',
    privileges: { standard: true, secure: true },
  },
]);

app.whenReady().then(async () => {
  logger.info('LionClaw starting...');

  if (process.platform === 'linux') {
    Menu.setApplicationMenu(null);
  }

  if (process.platform === 'darwin' && app.dock) {
    const iconPath = path.join(__dirname, '../../resources/icon.png');
    if (fs.existsSync(iconPath)) {
      app.dock.setIcon(iconPath);
    }
  }

  protocol.handle('lionclaw-asset', (request) => {
    const url = new URL(request.url);
    const pathname = url.pathname;

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

    if (pathname.startsWith('/locked-design/')) {
      try {
        const projectId = decodeURIComponent(pathname.replace('/locked-design/', ''));
        const cfg = getOpenDesignConfig(projectId);
        if (!cfg?.runDir) {
          return new Response('Design nao travado', { status: 404, headers: { 'Content-Type': 'text/plain' } });
        }
        const htmlPath =
          cfg.artifactHtmlPath ?? path.join(cfg.runDir, 'open-design', 'snapshots', 'latest', 'artifact', 'index.html');
        const snapshotDir = cfg.snapshotDir ?? path.join(cfg.runDir, 'open-design', 'snapshots', 'latest');
        const resolvedHtml = path.resolve(htmlPath);
        const resolvedDir = path.resolve(snapshotDir);
        if (!resolvedHtml.startsWith(resolvedDir + path.sep) && resolvedHtml !== resolvedDir) {
          return new Response('path fora do snapshotDir', { status: 403, headers: { 'Content-Type': 'text/plain' } });
        }
        if (!fs.existsSync(resolvedHtml)) {
          return new Response('Arquivo nao encontrado', { status: 404, headers: { 'Content-Type': 'text/plain' } });
        }
        const html = fs.readFileSync(resolvedHtml, 'utf-8');
        const previewCsp = [
          "default-src * data: blob: 'unsafe-inline' 'unsafe-eval'",
          "script-src * data: blob: 'unsafe-inline' 'unsafe-eval'",
          "style-src * data: blob: 'unsafe-inline'",
          'font-src * data: blob:',
          'img-src * data: blob:',
          'connect-src * data: blob:',
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

    if (pathname.startsWith(HTML_ARTIFACT_PROTOCOL_PREFIX)) {
      return serveHtmlArtifact(pathname);
    }

    if (pathname.startsWith('/local-image/')) {
      try {
        const abs = path.resolve(decodeURIComponent(pathname.replace('/local-image/', '')));
        const ext = path.extname(abs).toLowerCase();
        const allowed = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.bmp', '.avif'];
        if (!allowed.includes(ext)) {
          return new Response('Tipo de arquivo nao permitido', {
            status: 403,
            headers: { 'Content-Type': 'text/plain' },
          });
        }
        if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
          return new Response('Imagem nao encontrada', { status: 404, headers: { 'Content-Type': 'text/plain' } });
        }
        return net.fetch(pathToFileURL(abs).href);
      } catch (err) {
        return new Response(`Erro ao servir imagem: ${(err as Error).message}`, {
          status: 500,
          headers: { 'Content-Type': 'text/plain' },
        });
      }
    }

    if (pathname.startsWith('/remote-image/')) {
      const remoteUrl = decodeURIComponent(pathname.replace('/remote-image/', ''));
      if (!/^https?:\/\//i.test(remoteUrl)) {
        return new Response('URL remota invalida', { status: 400, headers: { 'Content-Type': 'text/plain' } });
      }
      return net.fetch(remoteUrl);
    }

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

  protocol.handle('lionclaw-kanban', (request) => {
    try {
      const url = new URL(request.url);
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

  ensureLionClawFiles();

  copyDefaultSkills();

  generateClaudeMd();

  watchMemoryFiles();

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

  try {
    const { moved } = migrateTelegramJsonlOnBoot();
    if (moved > 0) {
      logger.info({ moved }, 'Telegram: jsonl de sessao ativa migrado no boot (SPEC 10)');
    }
  } catch (error) {
    logger.warn({ error }, 'Telegram: migracao de jsonl no boot falhou (boot continua)');
  }

  registerExternalProviderVaultEntries();

  await startKnowledgeBridge();
  logger.info('Knowledge bridge started');

  if (getSetting('mgraph_mode') === 'true') {
    startIngestQueueWatcher();
    logger.info('Ingest queue watcher started');
  }

  harnessEngine = new HarnessEngine(() => mainWindow);
  pipelineEngine = new PipelineEngine(() => mainWindow, harnessEngine);
  registerPipelineEngineRef(() => pipelineEngine);
  try {
    rebuildClearingSessionsOnBoot();
  } catch (error) {
    logger.error({ err: error }, 'Reconstrucao de Clear interrompido falhou (boot continua)');
  }
  initPipelineDriveCoordinator(getMainWindow);
  startPipelineControlPhaseCache();
  registerIPCHandlers(
    getMainWindow,
    () => harnessEngine,
    () => pipelineEngine,
  );
  logger.info('IPC handlers registered');
  try {
    await getSwarmService().recover();
  } catch (error) {
    logger.error({ error }, 'Swarm indisponível após falha de recuperação');
  }
  stopSwarmDeliveryPump = startSwarmDeliveryPump(getMainWindow);

  try {
    const { recovered } = await recoverWorkflowRunsOnBoot();
    logger.info({ recovered }, 'Dynamic workflow boot recovery complete');
  } catch (error) {
    logger.error({ error }, 'Dynamic workflow boot recovery failed (boot continues)');
  }

  ensureBuiltinMCPServers();

  await startLocalIpcServer();

  try {
    await restoreHiggsfieldSessionFromVault();
    watchHiggsfieldSession();
  } catch (error) {
    logger.warn({ error }, 'Failed to restore Higgsfield MCP session from Vault');
  }

  try {
    await startActiveMCPServers();
  } catch (error) {
    logger.error({ error }, 'Failed to start some MCP servers');
  }

  await syncCodexMcpConfig();

  discoverSDKMcpServers().catch((err) => {
    logger.warn({ err }, 'Background MCP discovery failed - will retry on page load');
  });

  startScheduler(getMainWindow);
  logger.info('Scheduler started');

  void startTelegramBot(getMainWindow).catch((error) => {
    logger.error({ error }, 'Failed to start Telegram bot');
  });

  createWindow();

  registerWindowProvider(getMainWindow);

  initMcpInvoke({ getWindow: getMainWindow });

  void import('./open-design/boot-installer')
    .then((m) => m.ensureVendorReady())
    .catch((err) => {
      logger.error({ err }, 'open-design: ensureVendorReady kickoff failed');
    });

  void import('./agent-runtime/cursor-sidecar/node-resolver')
    .then((m) => m.checkCursorSidecarNodeAtBoot())
    .catch((err) => {
      logger.error({ err }, 'cursor-sidecar: checagem de Node no boot falhou');
    });

  void import('./cursor-sdk/workspace')
    .then((m) => m.cleanupCursorChatWorkspaces())
    .catch((err) => {
      logger.error({ err }, 'cursor-sdk: cleanup de workspaces de chat no boot falhou');
    });

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
        'Update download progress',
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

let stopSwarmDeliveryPump: (() => void) | undefined;
let isQuitting = false;
app.on('before-quit', async (e) => {
  if (isQuitting) return;
  isQuitting = true;
  e.preventDefault();
  stopSwarmDeliveryPump?.();
  try {
    killAllTerminalSessions();
  } catch {
    /* ignore */
  }
  await getSwarmService().shutdown();
  stopWatchingMemoryFiles();
  stopIngestQueueWatcher();
  try {
    stopCurrentQuery();
  } catch {
    /* ignore */
  }
  try {
    stopTelegramQuery();
  } catch {
    /* ignore */
  }
  try {
    stopCronQuery();
  } catch {
    /* ignore */
  }
  try {
    await stopTelegramBot();
  } catch {
    /* ignore */
  }
  stopScheduler();
  stopAllMCPServers();
  try {
    await stopLocalIpcServer();
  } catch {
    /* ignore */
  }
  stopKnowledgeBridge();
  try {
    const { closeAllCachedChatCodexSessions } = await import('./codex-sdk');
    closeAllCachedChatCodexSessions('app-shutdown');
  } catch {
    /* ignore */
  }
  try {
    const { shutdownOfficialCodexDrivers } = await import('./agent-runtime/codex-session-factory');
    await shutdownOfficialCodexDrivers('app-shutdown');
  } catch {
    /* ignore */
  }
  try {
    const { stopAll } = await import('./open-design/manager');
    await stopAll();
  } catch {
    /* ignore */
  }
  try {
    const { getKimiBridgeRegistry } = await import('./kimi-acp/mcp-bridge-registry');
    await getKimiBridgeRegistry().stopAll();
  } catch {
    /* ignore */
  }
  try {
    await shutdownKimiRuntime();
  } catch {
    /* ignore */
  }
  try {
    await shutdownGrokRuntime();
  } catch {
    /* ignore */
  }
  try {
    const { shutdownCursorSidecars } = await import('./agent-runtime/cursor-sidecar/sidecar-manager');
    await shutdownCursorSidecars('app-shutdown');
  } catch {
    /* ignore */
  }
  logger.info('Cleanup complete, quitting');
  app.exit(0);
});

export { getMainWindow };

function publishKanbanEntryForExternalClients(): void {
  const id = 'lionclaw-kanban';
  try {
    const { entryPath, candidates } = resolveMcpServerEntry(id, `dist/${id}/src/index.js`, {
      appPath: app.getAppPath(),
      cwd: process.cwd(),
    });
    if (!entryPath) {
      logger.warn({ id, candidates }, 'entrypoint do MCP do kanban nao encontrado; clientes externos nao o descobrem');
      return;
    }
    publishExternalClientServers({ [id]: entryPath }).catch((err) => {
      logger.warn({ err, id }, 'falha ao publicar o entrypoint do MCP para clientes externos');
    });
  } catch (err) {
    logger.warn({ err, id }, 'falha ao resolver o entrypoint do MCP do kanban para clientes externos');
  }
}
