<div align="center">
  <img src="LionLogoGit.png" alt="LionClaw logo" />
</div>

# LionClaw

Assistente pessoal de IA em app desktop Electron. Single-user, single-machine, com acesso ao terminal, filesystem, internet, MCPs locais e agentes especializados.

Versao atual do pacote: `v3.8.0` (`package.json`).

---

## Indice

1. [Visao Geral](#visao-geral)
2. [Novidades desta versao](#novidades-desta-versao)
3. [Pre-requisitos](#pre-requisitos)
4. [Instalacao do zero](#instalacao-do-zero)
5. [Atualizar da versao anterior](#atualizar-da-versao-anterior)
6. [Configuracao de Chaves](#configuracao-de-chaves)
7. [OpenRouter e Providers Externos](#openrouter-e-providers-externos)
8. [Codex CLI](#codex-cli)
9. [Pipelines](#pipelines)
10. [LionDesign Studio](#liondesign-studio)
11. [Funcionalidades](#funcionalidades)
12. [Permissoes](#permissoes)
13. [Arquitetura](#arquitetura)
14. [Boot Sequence](#boot-sequence)
15. [MCP Servers](#mcp-servers)
16. [Comandos](#comandos)
17. [Estrutura do Projeto](#estrutura-do-projeto)
18. [Empacotamento e Release](#empacotamento-e-release)
19. [Troubleshooting](#troubleshooting)
20. [Licenca](#licenca)
21. [v3.8](#v38)
22. [v3.7.1](#v371)

---

## Visao Geral

LionClaw roda localmente como aplicativo desktop. Ele nao e um chatbot web: o main process do Electron orquestra agentes, banco SQLite, scheduler, MCPs, Knowledge Base, Telegram, Vault, CodeBurn e pipelines de implementacao. O renderer React so conversa com o main process via Electron IPC tipado.

Em producao nao existe servidor web separado nem API HTTP exposta. Dados ficam na maquina do usuario: `~/.lionclaw/`, SQLite local, keychain do sistema operacional para segredos e sqlite-vec para busca vetorial.

O orquestrador (o SDK que conduz o chat principal) suporta **6 runtimes**: Claude Agent SDK, Claude-compat SDK, Codex SDK, Lion-SDK, Kimi-SDK (Kimi K3 via CLI de assinatura) e Grok-SDK (Grok 4.5 via CLI da xAI). O wizard do primeiro setup apresenta os 4 primeiros; Kimi-SDK e Grok-SDK sao escolhidos depois em **Settings > Orquestrador**:

| SDK | Backend | Provedores |
|-----|---------|------------|
| **Claude Agent SDK** | `@anthropic-ai/claude-agent-sdk` 0.3.x (engine Claude Code nativo, binario por plataforma) | Anthropic direto |
| **Claude-compat SDK** | Mesmo engine do Claude SDK, em uma copia/funcao separada (`claude-compat-sdk/index.ts`) com env override do endpoint por chamada | Z.ai (GLM), MiniMax Token Plan |
| **Codex SDK** | Driver oficial (app-server) do OpenAI Codex CLI, autenticado por OAuth | OpenAI Codex |
| **Lion-SDK** | Adapters proprios (`lion-sdk/`) | Ollama, LM Studio, OpenAI-compat (Kimi global/China, Qwen, DeepSeek, MiniMax PAYG, Custom), Vertex AI via `@google/genai` |

> [!NOTE]
> "Claude-compat" nao e um SDK separado: e o mesmo executor do Claude oficial, numa funcao copiada de proposito, que so troca o endpoint via variavel de ambiente por chamada (`claude-compat-sdk/index.ts:1-25`).

Agentes individuais (sub-agentes, pipelines, harness) tambem podem usar runtimes proprios independentes do orquestrador:

- runtime `cloud` via Claude Agent SDK;
- runtime `codex` via driver oficial do OpenAI Codex CLI autenticado por OAuth;
- runtime `grok` para Grok Build (assinatura via CLI da xAI);
- runtime `zai` (GLM por assinatura Z.ai) e `minimax-tp` (MiniMax TokenPlan);
- runtime `kimi` (assinatura via CLI);
- runtime `external` para OpenRouter, OpenAI direto, Kimi, DeepSeek, Qwen, MiniMax PAYG, Gemini Agent Platform e endpoints OpenAI-compatible;
- runtime `local` para Ollama, LM Studio e endpoints locais compativeis.

Dois caminhos fazem o orquestrador propagar para os agentes:

- **Heranca implicita**: um sub-agente `cloud` com `model` igual a `default` herda o modelo do orquestrador em tempo de execucao (`orchestrator.ts:555`);
- **Sincronizacao em massa**: o botao "Sincronizar com orquestrador" em Sub-Agentes reescreve runtime, modelo e configs de todos os agentes (ou de um subconjunto filtrado) para alinhar com o SDK escolhido (`agent-sync.ts:409`). Ver [Funcionalidades > Sub-Agentes](#sub-agentes).

Trocar o SDK orquestrador depois do onboarding e feito em **Settings > Orquestrador**. Selecionar um modelo incompativel com o runtime escolhido retorna erro de validacao (`InvalidOrchestratorSelectionError`, `orchestrator-selection.ts`).

---

## Novidades desta versao

### Workflows Dinamicos reescritos

O workflow nasce de conversa, nao de formulario: voce descreve o processo no chat e o orquestrador escreve o `.js`, cria e inicia num passo so. O modal de criacao manual saiu. Sem teto de custo: o freio e pausar ou abortar pelo chat. Cockpit proprio do run com Execucao, Custo, Saidas e Linha do tempo. Detalhe em [v3.8](#v38).

### Kanban nativo

Gestao de demandas dentro do app, um quadro por repositorio registrado, operado tanto pela tela quanto pelo orquestrador no chat. A entrada **Canais** do menu lateral deu lugar a **Kanban**. Ver [Funcionalidades > Kanban nativo](#kanban-nativo).

### Runtime Cursor

Nono runtime: o agente do Cursor (Composer, mais Claude, GPT, Grok e Gemini pelo seu plano Cursor) com chat, pipelines, workflows, sub-agentes e memoria. Sidecar Node empacotado na distribuicao.

### Agent SDK 0.3 com engine nativo

Sai o `cli.js` interpretado, entra o binario nativo do Claude Code por plataforma, empacotado na distribuicao, com tela propria e login pelo engine resolvido. A lista de tarefas do agente passa a funcionar em todos os modelos, e os runtimes compativeis (Z.ai, MiniMax) recebem a janela de contexto real via `CLAUDE_CODE_MAX_CONTEXT_TOKENS`.

### GPT-6 Astra e Claude Fable 5.1

`gpt-6-astra` e o novo default do runtime Codex (janela de 1.05M, esforco ate `ultra`; exige Codex CLI 0.153+). `claude-fable-5-1` substitui o Fable 5 no catalogo Claude, com migracao automatica de quem estava no modelo antigo.

### Runtimes Grok 4.5 e Kimi K3

Dois runtimes novos por assinatura via CLI. **Grok**: CLI oficial da xAI, modelo `grok-4.5` com contexto de 500k e efforts `low`/`medium`/`high`. **Kimi K3**: flagship da Moonshot com contexto de 1M e efforts `low`/`high`/`max`; exige tier Moderato+ da assinatura. Ver as secoes dedicadas no fim deste README.

### Claude Opus 5 default do orquestrador

O modelo default do app agora e `claude-opus-5` (`claude-models.ts:29`). A migration V142 atualiza DBs existentes preservando escolha customizada de modelo.

### Bug Pipeline (novo)

Novo pipeline `bug` com 9 fases para diagnostico e correcao de bugs: a analise roda 3 agentes em paralelo (root-cause, historico do git e refutacao adversarial) antes da SPEC de correcao e do ciclo Coder/Evaluator. Ver [Pipelines > Bug Pipeline](#bug-pipeline).

### Terminal integrado no chat

Dock de terminal real (node-pty + xterm.js) embutido na pagina de Chat, com ate 8 abas e shells que sobrevivem a navegacao entre paginas. Ver [Funcionalidades > Terminal integrado](#terminal-integrado).

### MCPs lionclaw-telegram e lionclaw-preview

Dois seams internos novos: `lionclaw-telegram` (tool `telegram_notify`, push proativo do orquestrador para o Telegram) e `lionclaw-preview` (tools `preview_open` e `preview_capture`, abre HTML local/localhost e captura PNG com sessao isolada).

### LionDesign

O motor de design do `development-v2` agora se chama **LionDesign** na UI. Identificadores tecnicos (pasta `vendor/open-design/`, canais `open-design:*`, `agentId: open-design-studio`) mantem o nome upstream (`electron/main/liondesign-branding.ts`).

### Onboarding com escolha de SDK

A primeira execucao agora abre um wizard de **escolha de SDK orquestrador** entre senha e credencial. O usuario decide qual runtime vai conduzir a conversa inicial e os agentes default:

| Opcao | Como autentica | Provedores |
|-------|----------------|------------|
| **Claude Agent SDK** | Anthropic API key (`sk-ant-...`) | Anthropic direto (recomendado) |
| **Codex SDK (OpenAI)** | OAuth via CLI (`codex login`) | OpenAI Codex, sem API key |
| **Claude-compat SDK** | API key do provider | Z.ai (GLM) ou MiniMax Token Plan |
| **Lion-SDK** | Varia por provider | Ollama local, LM Studio, OpenAI-compat (Kimi/Qwen/DeepSeek), Vertex AI |

O wizard valida CLI/conexao antes de prosseguir, persiste o flag `orchestratorSetupCompleted` e tem gate de recuperacao: se o usuario fechar o app entre senha e escolha de SDK, no proximo login retorna direto a tela de escolha sem perder a senha cadastrada.

> [!NOTE]
> Instalacoes existentes com Anthropic ja configurada nao sao redirecionadas ao wizard, passam direto ao chat. So fresh installs e wizards interrompidos veem a tela.

Ao concluir o onboarding, o app dispara um sync best-effort one-shot que alinha os seed agents default ao SDK escolhido (`agent-sync.ts:409`, via `electron/main/ipc/agents.ts`). Esse mesmo sync pode ser reexecutado a qualquer momento pelo botao "Sincronizar com orquestrador" (ver [Sub-Agentes](#sub-agentes)).

### Voz e chat ao vivo

O chat agora tem **conversa por voz ao vivo**: orquestracao client-side com deteccao de fala (VAD), barge-in (voce interrompe o agente falando), transcricao em streaming e TTS em streaming. Nao e uma API duplex de servidor - e composto no renderer (`src/hooks/useVoiceConversation.ts`, `VoiceConversationPanel.tsx`).

- **STT** (fala -> texto): OpenAI (`whisper-1` / `gpt-4o-transcribe` / `gpt-4o-mini-transcribe`, exige `OPENAI_API_KEY`).
- **TTS** (texto -> fala): **ElevenLabs** (provider default do chat ao vivo, `ELEVENLABS_API_KEY`) ou **Cartesia** (TTS de baixa latencia, `CARTESIA_API_KEY`, `cartesia-engine.ts`). O provider, a voz e a velocidade sao escolhidos em Settings.

### Dreaming (manutencao automatica de memoria)

O **Dreaming** mantem a memoria do agente sem intervencao manual, em duas camadas:

- **Gate de Dreaming** (obrigatorio, com fail-safe): roda automaticamente nos pontos certos para revisar e consolidar memoria (`dreaming-gate.ts`). E fail-safe: se o passo de IA falhar, o fluxo principal nao quebra.
- **Turn-Based Dreaming** (opt-in): a cada N turnos do chat, dispara um ciclo de manutencao. Configurado em **Settings > Dreaming**: toggle (default OFF) e intervalo de turnos (10 a 500, default 20) (`dreaming-turn-engine.ts`, migration V74 `dreaming_state`). O Dreaming so faz operacoes REMOVE/UPDATE na memoria - nunca cria conteudo do nada.

> [!NOTE]
> O Turn-Based Dreaming herda a selecao de compactacao - roda na assinatura/credencial do orquestrador ativo (a mesma que o chat usa), sem fallback silencioso para outro modelo: se a selecao nao resolver, o ciclo falha com erro tipado.

### Sincronizacao do orquestrador para os sub-agentes

Novo botao "Sincronizar com orquestrador" em Sub-Agentes: reescreve runtime, modelo e configs de todos os agentes (ou de um subconjunto filtrado) para o que o orquestrador usa, preservando tools, MCP servers e skills de cada agente (`agent-sync.ts:409`). Tem preview (dryRun) antes de aplicar. Ver [Sub-Agentes](#sub-agentes).

### Memory Graph (mgraph)

**Memory Graph** (mgraph): um vault de notas e relacionamentos, com pagina **Graph** dedicada e ingestao de documentos. Desligado por padrao; o toggle exige reinicio do app. Ver [Memory Graph](#memory-graph).

### Pipeline unificado

A tela **Pipeline** concentra seis tipos de fluxo:

| Tipo | Uso |
|------|-----|
| `development` | Criar produto do zero: discovery, PRD, SPEC, planejamento e implementacao |
| `development-v2` | Pipeline 2.0 com **LionDesign Studio** integrado (17 fases, design lock) |
| `feature` | Adicionar uma feature a um projeto existente |
| `security` | Auditoria multi-agente de seguranca e qualidade, gerando SPEC de correcao |
| `architecture-review` | Mapeamento arquitetural, triagem de alvo, diagnostico, decisoes e SPEC |
| `bug` | Diagnostico e correcao de bug: analise multi-agente, SPEC de correcao e ciclo Coder/Evaluator (9 fases) |

### Development V2 + LionDesign Studio

Novo pipeline `development-v2` com 17 fases que adiciona um **LionDesign Studio** conversacional entre o PRD e a parte tecnica (`src/types/pipeline.ts:129-145`):

- Fase 4 (Design Plan): fase auto que prepara o plano de design antes do estudio.
- Fase 5 (LionDesign Studio): sessao conversacional com o agente `open-design-studio` que opera o sidecar local Open Design (`vendor/open-design/`). Saida e um `artifact.html` interativo + `design-contract.json` + `design-brief.md`.
- Fase 6 (Design Lock): congela o design aprovado em `<projectPath>/docs/Docs<pipelineDocsId>/design/`. Apos lock, fases 7 a 15 sao executaveis e as fases de design (4 e 5) ficam bloqueadas (exige escape hatch destrutivo com confirmacao para reabrir).
- Fases tecnicas (Database/Backend/Frontend/Security) recebem o `design-brief.md` como contexto.
- Sprints de UI carregam metadata `DevelopmentV2SprintMetadata` (`touchesUI`, `affectedScreenIds`, `affectedComponentIds`, `designArtifactPath`) para o coder respeitar o design lockado.

Artefatos de texto ficam em `<projectPath>/.lionclaw/pipelines/development-v2/<runId>/`; o snapshot do design lockado fica em `<projectPath>/docs/Docs<pipelineDocsId>/design/`. Detalhe completo em [Pipelines > Development V2](#development-v2-pipeline) e [LionDesign Studio](#liondesign-studio).

### Security Audit Pipeline

Novo pipeline de seguranca com Repo Profiler, sete auditores em paralelo limitado a 3 agentes, deduplicacao, validadores ceticos, SPEC, planner e ciclo Coder/Evaluator.

Auditores da fase 2:

- Secrets Scanner
- Auth Auditor
- Isolation Inspector
- Duplication Detector
- Logic Analyzer
- Standards Checker
- OWASP Scanner

O fluxo gera artefatos em `.lionclaw/Security/`, inclui `manifest.json`, relatorios parciais, relatorio consolidado, resumo executivo e `SecurityScan-*.json` para tracking de resolucao.

### Architecture Review Pipeline

Novo fluxo para entender uma codebase antes de implementar mudancas grandes:

1. Mapeamento arquitetural
2. Triagem de alvos
3. Diagnostico arquitetural
4. Entrevista de decisao
5. Spec Generation
6. Spec Validation
7. Spec Enricher
8. Planner
9. Sprint Validator
10. Coder
11. Evaluator

Os artefatos ficam em:

```text
<projectPath>/.lionclaw/pipelines/architecture-review/<runId>/
  manifest.json
  ArchitectureMap-<runId>.md
  ArchitectureMap-<runId>.json
  ArchitectureCandidates-<runId>.md
  ArchitectureCandidates-<runId>.json
  ArchitectureDiagnosis-<runId>.md
  ArchitectureDiagnosis-<runId>.json
  ArchitectureDecisions-<runId>.md
  ArchitectureDecisions-<runId>.json
  ArchitectureSpecSource-<runId>.md
  SPEC-<runId>.md
  sprints-<runId>.json
```

### OpenRouter e OpenAI externo

Agentes agora podem usar runtime `external` com providers OpenRouter, OpenAI, Kimi (Moonshot), DeepSeek, Qwen (DashScope), MiniMax Pay-as-you-go, Gemini Agent Platform ou endpoint OpenAI-compatible customizado. As chaves ficam no Vault, nao em `.env`.

### Runtime Codex

Agentes podem usar runtime `codex`, rodando o OpenAI Codex CLI por OAuth. Esse runtime usa ferramentas nativas do Codex, sandbox `workspace-write` por padrao e nao usa MCPs, Skills ou Knowledge Base do LionClaw durante a execucao.

### Codex no Windows

Existe um health check especifico para Windows para evitar falhas de `apply_patch` por CRLF e encoding PowerShell 5.1. O app pode preparar o repo com consentimento do usuario.

### CodeBurn

A tela **Usage** e um terminal embutido do CodeBurn. O LionClaw inicia `codeburn report` via `node-pty` e renderiza no xterm.js.

### Seeds e DB atualizados

O boot garante todos os seed agents por uma chamada unica (`ensureAllSeedAgents`) e materializa snapshots em `~/.lionclaw/agents/<id>/config.json`. No boot, o app aplica todas as migrations pendentes do SQLite; atualmente a ultima e a **V145** (`electron/main/db-migration-safety.ts:13`).

---

## Pre-requisitos

| Ferramenta | Versao Minima | Como verificar | Como instalar |
|------------|---------------|----------------|---------------|
| **Node.js** | v24.x | `node --version` | [nodejs.org](https://nodejs.org/) |
| **npm** | v9+ | `npm --version` | Ja vem com o Node.js |
| **Python** | 3.10+ | `python --version` | [python.org](https://www.python.org/) |
| **Git** | qualquer versao recente | `git --version` | [git-scm.com](https://git-scm.com/) |

> [!IMPORTANT]
> **Node 24 e fortemente recomendado** por causa do vendor Open Design (`vendor/open-design/package.json` declara `engines.node: ~24`). O boot-installer **nao bloqueia por versao de Node** - ele apenas loga (`installer.ts:23-32`, `boot-installer.ts:72-103`). O risco real ao usar outro major e **ABI nativo invalido**: modulos como `better-sqlite3` ficam incompativeis e a fase LionDesign Studio do `development-v2` pode nao subir. Se voce trocar o major do Node depois de instalar, o app detecta o drift de ABI e reinstala o vendor no proximo boot (ver "Primeiro boot" abaixo).

> [!NOTE]
> **Voce nao precisa instalar pnpm manualmente.** O vendor Open Design usa pnpm (10.33.2), mas o app resolve o binario por cascata pnpm > corepack > npx automaticamente (`pnpm-runner.ts:24-35`). So e preciso ter internet na primeira instalacao do vendor.

Modulos que podem exigir build nativo: `better-sqlite3`, `keytar`, `sqlite-vec` e `node-pty`. O vendor Open Design tambem usa `better-sqlite3` proprio, instalado pelo boot-installer.

Build tools por sistema:

| Sistema | Requisito |
|---------|-----------|
| macOS | Xcode Command Line Tools: `xcode-select --install` |
| Windows | Ver bloco abaixo. |
| Linux | `sudo apt install -y git build-essential python3 libsecret-1-dev` |

### Setup Windows passo a passo

> [!IMPORTANT]
> Estas etapas sao **uma unica vez por maquina**. Faltar qualquer uma delas faz o `npm run rebuild:electron` falhar de um jeito diferente. Se sua maquina ja compila modulos Node nativos, pule para "Instalacao".

**1. Instale o Visual Studio Build Tools 2022 (versao 17)**

Baixe e rode: [aka.ms/vs/17/release/vs_BuildTools.exe](https://aka.ms/vs/17/release/vs_BuildTools.exe).

> [!WARNING]
> **Nao use VS 2026 / versao 18 (preview).** O `node-gyp` que vem com o Electron deste repo ainda nao reconhece esse layout e falha com `Could not find any Visual Studio installation to use`, mesmo com o instalador presente em `C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools`. Os dois podem conviver lado a lado em pastas distintas - instale o 2022 separado.

**2. Na aba "Cargas de trabalho", marque "Desenvolvimento para desktop com C++"**

No painel **Detalhes da instalacao** (lado direito), confirme que estao marcados:

- Ferramentas de Build do MSVC para x64/x86 (v143);
- SDK do Windows 10 ou 11.

**3. Na aba "Componentes individuais", marque as bibliotecas com mitigacao Spectre**

A workload C++ padrao **nao** inclui as libs com mitigacao Spectre - elas sao componente opcional separado. Sem isso, o build do `node-pty` falha com:

```text
error MSB8040: as bibliotecas com Mitigacoes de Spectre sao necessarias para este projeto
```

Como marcar:

1. Va na aba **Componentes individuais** (nao "Cargas de trabalho").
2. Na barra de busca, digite: `spectre`.
3. Marque exatamente uma opcao: **Bibliotecas com mitigacao de Spectre do MSVC v143 - VS 2022 C++ x64/x86 (Mais recente)**.

Ignore as outras (ARM/ARM64 e as marcadas como `(Sem Suporte)`). Apos marcar, clique **Modificar** no canto inferior direito (baixa ~200MB).

**4. Configure o `node-gyp` para usar VS 2022**

> [!NOTE]
> Em npm 9+, `npm config set msvs_version 2022` falha com `'msvs_version' is not a valid npm option`. Use uma das alternativas abaixo.

Opcao A, variavel de ambiente na sessao atual:

```powershell
$env:GYP_MSVS_VERSION="2022"
$env:GYP_MSVS_OVERRIDE_PATH="C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools"
```

Opcao B, persistir nas variaveis do usuario (recomendado):

```powershell
[System.Environment]::SetEnvironmentVariable("GYP_MSVS_VERSION", "2022", "User")
[System.Environment]::SetEnvironmentVariable("GYP_MSVS_OVERRIDE_PATH", "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools", "User")
```

Depois feche e reabra o PowerShell.

Opcao C - via `.npmrc`:

Edite (ou crie) `C:\Users\<seu-usuario>\.npmrc` e adicione:

```ini
msvs_version=2022
```

O npm aceita pelo arquivo mesmo rejeitando no `set`.

**5. Rebuild dos modulos nativos para Electron**

```powershell
npx node-gyp cache clean
npm run rebuild:electron
```

Se falhar, ver [Troubleshooting](#node-gyp-nao-encontra-o-visual-studio-no-windows) para diagnostico.

---

## Instalacao do zero

### 1. Clonar o repositorio

```bash
git clone https://github.com/LionLabsCommunity/lionclawv1.0.git
cd lionclawv1.0
```

### 2. Instalar dependencias

```bash
npm install
```

O `npm install` instala todas as dependencias, incluindo modulos nativos, e roda o `postinstall` (`npm run prepare:codegraph && npm run build:mcps`), que prepara o runtime do CodeGraph e compila todos os MCP servers. Se houver erro de compilacao, verifique os Build Tools acima.

> [!WARNING]
> **Para usuarios de Windows:** apos rodar `npm install`, e necessario recompilar as bibliotecas nativas para a versao interna de Node.js que o Electron utiliza. Caso contrario, o app pode falhar ao iniciar com `ERR_DLOPEN_FAILED`.
>
> Comando recomendado neste repo:
>
> ```bash
> npm run rebuild:electron
> ```
>
> Alternativa equivalente:
>
> ```bash
> npx electron-rebuild
> ```

### 3. Configurar a API Key

O LionClaw nao usa arquivos `.env` para segredos de usuario. Chaves sao armazenadas no keychain do sistema operacional.

Na primeira execucao, o app abre o fluxo de onboarding e pede sua API Key. Depois disso, as chaves podem ser configuradas no **Vault** dentro do app.

Chave obrigatoria:

| Chave | Para que serve |
|-------|----------------|
| `ANTHROPIC_API_KEY` | Agentes Claude via Claude Agent SDK |

Chaves opcionais principais:

| Chave | Para que serve |
|-------|----------------|
| `OPENAI_API_KEY` | Embeddings (`text-embedding-3-small`), Knowledge Base e transcricao (STT do chat ao vivo: `whisper-1` / `gpt-4o-transcribe`) |
| `HARNESS_OPENROUTER_KEY` | Agentes externos via OpenRouter |
| `HARNESS_OPENAI_KEY` | Agentes externos via OpenAI direto |
| `COHERE_API_KEY` | Reranking na Knowledge Base |
| `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` + tokens OAuth | Google Calendar, Gmail, Drive, Sheets, YouTube |
| `ELEVENLABS_API_KEY` | TTS / provider default do chat de voz ao vivo |
| `CARTESIA_API_KEY` | TTS de baixa latencia (provider alternativo do chat de voz ao vivo) |
| `GOOGLE_GEMINI_API_KEY` | Geracao de imagens via Nano Banana |
| `SHOPIFY_STORE_URL` + credenciais | Integracao Shopify |

### 4. Rodar

```bash
npm run dev
```

Abre o app Electron com React dev server (Vite HMR), main process com auto-restart e DevTools.

### 5. Primeiro boot

Na primeira execucao, o app cria `~/.lionclaw/` com:

```text
~/.lionclaw/
  SOUL.md               Identidade e personalidade do agente
  RULES.md              Regras de seguranca e operacao
  USER.md               Perfil do usuario, preenchido no onboarding
  MEMORY.md             Memoria de trabalho
  BOOTSTRAP.md          Ritual de onboarding, usado na primeira sessao
  CLAUDE.md             Contexto consolidado, gerado automaticamente
  .claude/
    settings.json       Isolamento do SDK
  agents/               Configuracoes e snapshots de sub-agentes
  skills/               Skills default
  conversations/        Transcricoes arquivadas
  background/           CWD isolado para scheduler e Telegram
  data/
    lionclaw.db         Banco SQLite
    sessions/           Sessions do Agent SDK
```

O primeiro uso passa por **dois gates de onboarding independentes**, nesta ordem:

1. **Senha** (e TOTP opcional), criada na tela de Auth.
2. **Wizard de SDK orquestrador** (flag `orchestratorSetupCompleted`): escolhe e valida o SDK que conduz o chat. Se o app for fechado entre a senha e a escolha de SDK, o proximo login volta direto para esta tela, sem perder a senha.
3. **Entrevista inicial no chat** (flag `onboarding_completed`): conduzida pelo agente para conhecer o usuario e preencher `USER.md` / `SOUL.md`.

Os dois flags sao distintos: um governa o setup tecnico do SDK, o outro a entrevista de personalizacao (`App.tsx:139-147`, `onboarding.ts`, `orchestrator.ts`).

### Open Design vendor (boot-installer)

Na primeira execucao, o app detecta que `vendor/open-design/node_modules` esta ausente e dispara `pnpm install --frozen-lockfile` em background dentro do vendor. O download e da ordem de ~1.3 GB e o `node_modules` final ocupa ~3.5 GB em disco; leva 1-3 minutos dependendo da rede. O progresso aparece no indicador "Open Design" da UI; o restante do app fica funcional durante a instalacao - voce so precisa esperar para usar a fase **LionDesign Studio** do pipeline `development-v2`.

O boot-installer tambem se auto-cura nos seguintes cenarios, sem comando manual:

- Upgrade da versao do Node (ex.: 22 -> 24, 24 -> 25) - modulos nativos como `better-sqlite3` ficam com ABI incompativel; o app detecta no proximo boot e reinstala.
- Pull com mudanca em `vendor/open-design/pnpm-lock.yaml` - drift de deps; o app detecta e reinstala.
- Instalacao parcial (crash no meio do install anterior), sentinela ausente; reinstala.

Se a instalacao falhar (rede off, ABI nativo invalido apos troca de major do Node, etc), o indicador mostra erro com botao **Tentar novamente**. Se reincidir, valide:

```bash
node --version          # recomendado 24.x
cd vendor/open-design
pnpm install --frozen-lockfile   # roda manualmente para ver o stderr real
```

---

## Atualizar da versao anterior

Se voce ja tem o LionClaw instalado e quer subir para esta release, o fluxo e basicamente `git pull` + reinstalar dependencias + rebuild nativo. **Nao existe um script unico de upgrade**; siga os passos do seu sistema.

> [!NOTE]
> O banco SQLite e o vendor Open Design se **auto-curam no boot**: as migrations pendentes (ate V151) sao aplicadas automaticamente e o boot-installer reinstala o vendor se detectar drift de ABI ou de lockfile. Voce nao roda migration na mao.

Antes de comecar, garanta que sua working tree esta limpa (`git status`) - o LionClaw nunca faz commit por voce.

### Passos comuns (todos os sistemas)

```bash
git pull
npm install            # reinstala deps + recompila MCP servers via postinstall
```

### macOS / Linux

```bash
npm run rebuild:electron   # recompila better-sqlite3 / node-pty para o Electron
npm run dev
```

### Windows

```powershell
npm run rebuild:electron   # obrigatorio: senao o app falha com ERR_DLOPEN_FAILED
npm run dev
```

> [!IMPORTANT]
> Se voce trocou o **major** do Node (ex.: 22 -> 24) nesta atualizacao, o ABI nativo muda. Rode `npm run rebuild:electron` e, no primeiro boot apos a troca, deixe o boot-installer reinstalar o vendor Open Design (o indicador "Open Design" mostra o progresso). Nunca use `npm rebuild` cru para isso - sempre `rebuild:electron`.

No primeiro boot pos-upgrade:

- As migrations rodam ate V151, com backup verificado do banco antes de qualquer upgrade de schema.
- Os seed agents sao reconciliados (INSERT-ONLY; suas customizacoes sobrevivem).
- O vendor Open Design reinstala se necessario.

---

## Configuracao de Chaves

Segredos sao armazenados no keychain do sistema operacional via `node-keytar`. Se o keytar falhar, o LionClaw usa fallback criptografado local em `~/.lionclaw/data/.secrets`.

Abra **Vault** dentro do app e configure as chaves necessarias.

| Chave | Obrigatoria | Uso |
|-------|-------------|-----|
| `ANTHROPIC_API_KEY` | Condicional | Obrigatoria quando orquestrador = Claude Agent SDK |
| `ORCHESTRATOR_ZAI_API_KEY` | Condicional | Obrigatoria quando orquestrador = Claude-compat SDK / Z.ai (GLM) |
| `ORCHESTRATOR_MINIMAX_API_KEY` | Condicional | Obrigatoria quando orquestrador = Claude-compat SDK / MiniMax Token Plan |
| `ORCHESTRATOR_OPENAI_COMPAT_API_KEY` | Condicional | Obrigatoria quando orquestrador = Lion-SDK / OpenAI-compat (Kimi/Qwen/DeepSeek/Custom) |
| `ORCHESTRATOR_VERTEX_API_KEY` | Condicional | Obrigatoria quando orquestrador = Lion-SDK / Vertex AI |
| `OPENAI_API_KEY` | Nao | Embeddings `text-embedding-3-small` e transcricao |
| `HARNESS_OPENROUTER_KEY` | Nao | Agentes runtime `external` via OpenRouter |
| `HARNESS_OPENAI_KEY` | Nao | Agentes runtime `external` via OpenAI direto |
| `HARNESS_KIMI_KEY` | Nao | Agentes runtime `external` via Kimi (Moonshot) |
| `HARNESS_DEEPSEEK_KEY` | Nao | Agentes runtime `external` via DeepSeek |
| `HARNESS_QWEN_KEY` | Nao | Agentes runtime `external` via Qwen (DashScope) |
| `HARNESS_MINIMAX_PAYG_KEY` | Nao | Agentes runtime `external` via MiniMax Pay-as-you-go |
| `COHERE_API_KEY` | Nao | Reranking na Knowledge Base (`rerank-multilingual-v3.0`) |
| `ELEVENLABS_API_KEY` | Nao | TTS / provider default do chat de voz ao vivo |
| `CARTESIA_API_KEY` | Nao | TTS de baixa latencia (provider alternativo do chat de voz ao vivo) |
| `GOOGLE_GEMINI_API_KEY` | Nao | Nano Banana, geracao de imagens |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `GOOGLE_ACCESS_TOKEN` | Nao | Gmail, Drive, Sheets, Calendar, YouTube |
| `SHOPIFY_STORE_URL`, `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET` | Nao | MCP Shopify |

> [!NOTE]
> Codex SDK como orquestrador NAO usa API key - autentica via `codex login` no terminal (OAuth). Kimi-SDK e Grok-SDK tambem autenticam pela assinatura do proprio CLI (`kimi` / `grok`), sem API key. Ollama e LM Studio (Lion-SDK) tambem nao exigem key, so a URL do servidor local. As chaves `ORCHESTRATOR_*` sao gravadas pelo wizard de onboarding (ou pela tela Settings -> Orquestrador) e propagadas para `orchestrator_*_api_key_ref` em `settings`.

O app nao deve depender de chaves commitadas em `.env`. Para development local, `.env` pode existir para tooling auxiliar, mas segredos de usuario devem ir para o Vault.

---

## OpenRouter e Providers Externos

### Configurar OpenRouter

1. Crie uma API key no OpenRouter: [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys).
2. No LionClaw, abra **Vault**.
3. Edite **OpenRouter API Key**.
4. Cole a chave no formato `sk-or-v1-...`.
5. Clique em **Testar conexao**.
6. Em **Sub-Agentes**, crie ou edite um agente.
7. Em **Runtime**, escolha `External`.
8. Em **Provider**, escolha `OpenRouter`.

Preset aplicado pelo app:

| Campo | Valor |
|-------|-------|
| Base URL | `https://openrouter.ai/api/v1` |
| Vault key | `HARNESS_OPENROUTER_KEY` |
| Test endpoint | `/auth/key` |
| Default model | `deepseek/deepseek-v4-pro` |
| Headers extras | `HTTP-Referer: https://lionclaw.app`, `X-Title: LionClaw` |

O runtime `external` chama endpoints OpenAI-compatible (`/v1/chat/completions`) e suporta tool calling quando o provider/modelo suporta.

Referencia oficial: [OpenRouter API Authentication](https://openrouter.ai/docs/api-keys).

### Modelos OpenRouter no catalogo

| Modelo | Label no app | Contexto |
|--------|--------------|----------|
| `deepseek/deepseek-v4-pro` | DeepSeek V4 Pro | 1M |
| `deepseek/deepseek-v4-flash` | DeepSeek V4 Flash | 1M |
| `moonshotai/kimi-k2.6` | Kimi K2.6 | 256K |
| `moonshotai/kimi-k2-thinking` | Kimi K2 Thinking | 256K |
| `moonshotai/kimi-k3` | Kimi K3 | 1M |
| `qwen/qwen3.6-max-preview` | Qwen 3.6 Max Preview | 262K |
| `qwen/qwen3.6-plus` | Qwen 3.6 Plus | 262K |
| `minimax/minimax-m2.7` | MiniMax M2.7 | 196K |
| `minimax/minimax-m2.5` | MiniMax M2.5 | 196K |
| `minimax/minimax-m1` | MiniMax M1 | 1M |
| `z-ai/glm-4.7` | GLM 4.7 | 202K |
| `z-ai/glm-4.7-flash` | GLM 4.7 Flash | 202K |

### OpenAI direto

Provider `OpenAI` usa:

| Campo | Valor |
|-------|-------|
| Base URL | `https://api.openai.com/v1` |
| Vault key | `HARNESS_OPENAI_KEY` |
| Modelos | `gpt-5.5`, `gpt-5.5-pro` |

Essa chave e separada de `OPENAI_API_KEY`, que e usada para embeddings e audio.

### Custom OpenAI-compatible

Use provider `Custom (OpenAI-compatible)` para APIs locais ou de terceiros.

Campos:

- Base URL manual
- Model slug manual ou carregado via `/v1/models`
- Vault key no formato `HARNESS_CUSTOM_<SLUG>_KEY`
- Context window manual
- Headers extras em JSON

---

## Codex CLI

O runtime `codex` usa o OpenAI Codex CLI. A resolucao do binario segue esta ordem: **Path customizado** em Settings (se preenchido e existente) e depois o primeiro `codex` do PATH - rodando pelo repo (`npm run dev`), isso resolve o CLI **embarcado** em `node_modules/.bin/codex` (dependencia do `@openai/codex`), nao o global (`resolveCodexBinary`, `electron/main/codex-runtime/binary.ts:42`). O LionClaw nao pede API key separada para esse runtime; ele usa a autenticacao local do CLI (`~/.codex/auth.json`).

Referencias oficiais: [Codex CLI Getting Started](https://help.openai.com/en/articles/11096431-openai-codex-ci-getting-started) e [Codex CLI Sign in with ChatGPT](https://help.openai.com/en/articles/11381614).

### Instalar

```bash
npm install -g @openai/codex
```

### Versao do Codex CLI

> [!IMPORTANT]
> **A familia GPT-5.6 (Sol/Terra/Luna) exige Codex CLI `0.144.x` ou superior** (ver [Codex oficial](#codex-oficial-app-server--novo-sdk)). O LionClaw valida os modelos contra o `model/list` do CLI instalado: se o CLI nao anunciar `gpt-5.6-*`, o run falha com erro claro pedindo atualizacao (`codex-session-factory.ts`), nunca degrada silenciosamente. A serie `0.144.x` e a validada; o app embarca a `0.144.1`.

Voce provavelmente nao precisa fazer nada: rodando pelo repo (`npm run dev`), o app resolve primeiro o binario **embarcado** em `node_modules/.bin/codex` (dependencia do `@openai/codex@0.144.1`, `package.json`), que ja anuncia a familia GPT-5.6. O binario global e usado para o `codex login` (a autenticacao em `~/.codex/auth.json` e compartilhada) e pelo sidecar Open Design, entao mantenha-o atualizado tambem:

```bash
codex --version                 # confirme >= 0.144
npm install -g @openai/codex    # atualiza o global
```

> [!WARNING]
> Se voce configurou um **Path customizado do binario** em Settings apontando para um CLI anterior a `0.144`, a familia GPT-5.6 e os efforts `max`/`ultra` vao falhar. Remova o path customizado ou aponte para um CLI `0.144+`.

### Conectar no LionClaw

1. Abra **Settings**.
2. Va para **Codex CLI**.
3. Clique em **Conectar Codex**.
4. O app abre um terminal externo executando `codex login`.
5. Complete o login no browser.
6. Volte ao LionClaw e clique em **Testar conexao**.

O status checa:

- se o binario `codex` existe;
- a versao via `codex --version`;
- se existe `~/.codex/auth.json`;
- se `codex login status` retorna sucesso.

Se o binario nao estiver no `PATH`, configure **Path customizado do binario** em Settings. No Windows, o app tambem procura em `%APPDATA%\npm\codex.cmd` e caminhos equivalentes do usuario.

### Modelos Codex no app

| Modelo | Descricao no app |
|--------|------------------|
| `gpt-5.6-sol` | Frontier agentic (recomendado, **default**) |
| `gpt-5.6-terra` | Equilibrado, ~5.5 pela metade do preco |
| `gpt-5.6-luna` | Rapido e barato |
| `gpt-5.5` | Frontier, codex-tuned |
| `gpt-5.4` | Generalista frontier |
| `gpt-5.4-mini` | Mais barato e rapido |
| `gpt-5.3-codex` | Variante codex-tuned (legado) |
| `gpt-5.2` | Anterior, generalista |

O catalogo estatico e complementado por **descoberta dinamica**: o app consulta o `model/list` do CLI instalado, entao modelos novos anunciados pelo Codex aparecem sem precisar de release (`src/constants/codex-models.ts`, `codex-runtime/model-capabilities.ts`).

O agente Codex tambem tem `reasoningEffort`, na escala `low` -> `medium` -> `high` -> `xhigh` -> `max` -> `ultra`:

- `low` / `medium` / `high`: todos os modelos.
- `xhigh`: `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex` e toda a familia 5.6.
- `max`: exclusivo da familia 5.6 (Sol, Terra e Luna).
- `ultra`: apenas Sol e Terra (delega a subagentes internos do Codex; consumo 2 a 3x).
- Um effort nao suportado pelo modelo sofre **clamp graduado** para o maior valor suportado abaixo (ex.: `ultra` em Luna vira `max`; `max` em `gpt-5.5` vira `xhigh`), nunca um salto direto para `high`.

> [!IMPORTANT]
> Todo run Codex passa pelo driver oficial (App Server). Modelos `gpt-5.6-*` e os efforts `max`/`ultra` exigem CLI `0.144+`: se o CLI resolvido nao suporta, o run falha com erro claro (`codex-session-factory.ts:194`). Ver [Codex oficial (App Server / novo SDK)](#codex-oficial-app-server--novo-sdk).

### Como criar um agente Codex

1. Abra **Sub-Agentes**.
2. Crie ou edite um agente.
3. Em **Runtime**, escolha `Codex`.
4. Escolha modelo e reasoning effort.
5. Salve.

Notas importantes:

- Codex usa sandbox `workspace-write` por padrao.
- Codex usa ferramentas nativas de read/write/exec do CLI.
- Tools, MCPs, Skills e Knowledge Base do LionClaw sao ignorados nesse runtime.
- O permission guard do LionClaw nao intermedeia as operacoes internas do Codex. A protecao vem do sandbox e das regras do Codex CLI.
- O pipeline captura metricas, comandos executados, arquivos alterados e falhas repetidas de patch.

### Windows Health Check do Codex

No Windows, o Codex CLI pode sofrer com CRLF e encoding do PowerShell 5.1. O LionClaw implementa um fluxo de preparo com consentimento.

O dialog aparece somente quando todas as condicoes abaixo sao verdadeiras:

- sistema operacional Windows;
- path do projeto resolve para um repo Git;
- Codex CLI esta instalado e autenticado;
- existe pelo menos um agente Codex ativo;
- o health check detecta issues acionaveis;
- o usuario ainda nao autorizou ou pulou a preparacao para aquela versao do prep.

Issues detectadas:

| Issue | Severidade | O que significa |
|-------|------------|-----------------|
| `autocrlf-true` | Alta | `core.autocrlf=true`, checkout pode converter LF para CRLF |
| `no-gitattributes` | Media | `.gitattributes` ausente ou sem regra `eol=lf` |
| `mixed-line-endings` | Media | index e working tree divergem em line endings |
| `powershell-5.1` | Baixa | informativo sobre encoding CP-1252 |

Ao clicar **Preparar**, o app executa:

```bash
git config core.autocrlf false
git add --renormalize .
git reset
```

E cria ou atualiza `.gitattributes` com:

```text
* text=auto eol=lf
```

Guardrails:

- nao roda fora do Windows;
- nao roda em repos com submodules;
- exige working tree limpo antes de aplicar;
- nao faz commit;
- permite **Agora nao** ou **Nunca para este projeto**;
- reemite warning se o problema persistir e o usuario nao tiver optado por pular.

Se o Codex acumular 3 falhas de `apply_patch verification failed`, o pipeline mostra um warning especifico sugerindo Health Check.

---

## Pipelines

### Development Pipeline

| Fase | Nome | Tipo |
|------|------|------|
| 1 | Discovery | Conversa |
| 2 | PRD Generator | Auto |
| 3 | PRD Validator | Conversa |
| 4 | PRD Completo | Auto |
| 5 | Database | Conversa |
| 6 | Backend | Conversa |
| 7 | Frontend | Conversa |
| 8 | Security | Conversa |
| 9 | Spec Generation | Auto |
| 10 | Spec Enricher | Conversa |
| 11 | Planner | Auto |
| 12 | Sprint Validator | Conversa |
| 13 | Coder | Loop |
| 14 | Evaluator | Loop |

Entry points disponiveis:

- Discovery: comecar do zero.
- Spec Builder: quando ja existe PRD e decisoes tecnicas.
- Planner: quando ja existe SPEC aprovada.

### Feature Pipeline

Versao do Development Pipeline voltada a um repositorio existente. Comeca por Feature Discovery e segue por PRD, tech review, SPEC, planner e implementacao.

Entry point atual: Feature Discovery.

### Security Pipeline

| Fase | Nome | Tipo |
|------|------|------|
| 1 | Repo Profiler | Auto |
| 2 | Security Audit | Auto multi-agente |
| 3 | Deduplicador | Auto |
| 4 | Skeptic Security | Conversa |
| 5 | Skeptic Quality | Conversa |
| 6 | SPEC Generator | Auto |
| 7 | SPEC Enricher | Conversa |
| 8 | Planner | Auto |
| 9 | Sprint Validator | Conversa |
| 10 | Coder | Loop |
| 11 | Evaluator | Loop |

Entry points:

- Scan Completo: profiling, auditoria, validacao e correcao automatizada.
- SPEC a partir de relatorio: quando ja existe um `Security-*.md`.

### Architecture Review Pipeline

| Fase | Nome | Tipo |
|------|------|------|
| 1 | Mapeamento Arquitetural | Auto |
| 2 | Triagem de Alvos | Conversa |
| 3 | Diagnostico Arquitetural | Auto |
| 4 | Entrevista de Decisao | Conversa |
| 5 | Spec Generation | Auto |
| 6 | Spec Validation | Conversa |
| 7 | Spec Enricher | Conversa |
| 8 | Planner | Auto |
| 9 | Sprint Validator | Conversa |
| 10 | Coder | Loop |
| 11 | Evaluator | Loop |

Entry point atual: Mapeamento Completo.

### Bug Pipeline

| Fase | Nome | Tipo |
|------|------|------|
| 1 | Bug Discovery | Conversa |
| 2 | Analise Paralela | Auto multi-agente |
| 3 | Consolidacao | Conversa |
| 4 | Spec Generation | Auto |
| 5 | Spec Validator | Conversa |
| 6 | Planner | Auto |
| 7 | Sprint Validator | Conversa |
| 8 | Coder | Loop |
| 9 | Evaluator | Loop |

O fluxo tem 4 estagios: Diagnostico (fase 1), Analise (fases 2-3), Spec (fases 4-5) e Execution (fases 6-9). A fase 2 roda 3 analistas em paralelo: root-cause, historico do git e refutacao adversarial. O gate da fase 3 tem 2 desfechos: aprovar o plano de correcao (segue para a SPEC) ou encerrar o pipeline sem bug.

### Development V2 Pipeline

Evolucao do Development Pipeline com **LionDesign Studio integrado** entre PRD e fases tecnicas. 17 fases (`src/types/pipeline.ts:129-145`):

| Fase | Nome | Tipo | Agente |
|------|------|------|--------|
| 1 | Discovery | Conversa | `discovery-agent` |
| 2 | User Stories | Auto | `prd-generator` |
| 3 | PRD Validator | Conversa | `prd-validator` |
| 4 | Design Plan | Auto | `design-plan` |
| 5 | LionDesign Studio | Conversa | `open-design-studio` |
| 6 | Design Lock | Auto | `design-lock` |
| 7 | PRD Completo | Auto | `pipe2-prd-completo` |
| 8 | Database | Conversa | `tech-database` |
| 9 | Backend | Conversa | `tech-backend` |
| 10 | Frontend Tecnico | Conversa | `pipe2-tech-frontend` |
| 11 | Security | Conversa | `tech-security` |
| 12 | Spec Generation | Auto | `pipe2-spec-builder` |
| 13 | Spec Enricher | Conversa | `pipe2-spec-enricher` |
| 14 | Planner | Auto | `harness-planner` |
| 15 | Sprint Validator | Conversa | `sprint-validator` |
| 16 | Coder | Loop | `harness-coder` |
| 17 | Evaluator | Loop | `harness-evaluator` |

Caracteristicas exclusivas:

- **Design Plan** (fase 4): fase auto que prepara o plano de design antes do estudio.
- **LionDesign Studio** (fase 5): sessao conversacional com sidecar local Open Design. Saida = `artifact.html` interativo + `design-contract.json` + `design-brief.md`.
- **Design Lock** (fase 6): congela o design aprovado em `<projectPath>/docs/Docs<pipelineDocsId>/design/` (`pipeline-paths.ts:119-162`, `lock.ts:79-86`). Antes do lock, as fases 1 a 5 sao resetaveis; apos o lock, as fases resetaveis sao 7 a 15 e as fases de design (4 e 5) ficam bloqueadas, reabertas so via escape hatch destrutivo (`open-design:destructive-unlock`, exige digitar a frase `DESBLOQUEAR DESIGN`). As fases 16 e 17 (loop) nunca sao resetaveis (`src/types/pipeline.ts`).
- **Sprint metadata UI**: sprints de UI carregam `DevelopmentV2SprintMetadata { touchesUI, affectedScreenIds, affectedComponentIds, designArtifactPath }` para o coder respeitar o design lockado.
- Identificadores: `runId` (`YYYYMMDD_HHmmss-<hex6>`), `pipelineDocsId` (sufixo de artefatos de texto), `designRevisionId` (apos unlock destrutivo, `rev-<ts>-<hex6>`).

> [!NOTE]
> As fases Planner/Coder/Evaluator (e a fase Spec Generation/Enricher quando faz loop interno) sao executadas pelo **HarnessEngine** compartilhado, o mesmo motor descrito em [Funcionalidades > Harness](#harness).

Artefatos de texto em `<projectPath>/.lionclaw/pipelines/development-v2/<runId>/`; snapshot do design em `<projectPath>/docs/Docs<pipelineDocsId>/design/`.

#### Codex-kill nos gates de aprovacao

Quando um pipeline usa o runtime **Codex** em alguma fase, o LionClaw mantem um processo `codex app-server` vivo de proposito (processos Codex ociosos nao consomem rate-limit). Para evitar acumulo de processos orfaos que deixam o app lento, ha uma limpeza cirurgica nos **dois gates de acao humana** do pipeline: ao **Aprovar uma fase** (`pipeline:approve`) e ao **Iniciar Desenvolvimento** (`pipeline:confirm-development`). A limpeza roda no momento em que o projeto esta parado esperando o clique, antes da proxima fase nascer.

A limpeza so dispara quando **as 3 condicoes** abaixo sao todas verdadeiras (helper `maybeKillIdleCodexOnGate` em `pipeline-engine/codex-sessions.ts:137`, delegador em `pipeline-engine/index.ts:1463`, compartilhado pelos dois gates):

1. **A fase deixada nao e fase de loop** (Coder/Evaluator). Fases loop nunca disparam o kill.
2. **REGRA MAXIMA: a fase deixada realmente usou Codex.** Verdadeiro quando o agente da fase tem `runtime === 'codex'`, ou quando ha uma sessao Codex rastreada para aquela fase no estado. Se a fase rodou em cloud (Opus), local ou external, nada e morto.
3. **Existe pelo menos um run oficial ativo desse projeto na superficie pipeline** (guarda anti-no-op, `hasActiveOfficialRun({ surface: 'pipeline', projectId })`, `agent-runtime/codex-session-factory.ts:75`).

Quando dispara, chama `resetOfficialProjectRunsNow(projectId, 'pipeline-gate')` (`codex-session-factory.ts:71`), que e **escopado pelo lifecycle registry** (`codex-runtime/lifecycle-registry.ts:136-142,306`) e estruturalmente seguro:

- Fecha so handles com `surface: 'pipeline'` daquele `projectId`: pipelines de **outros projetos** ficam intocados;
- Sessoes Codex do **chat / orquestrador** (`ownerKind === 'chat'`) nunca sao fechadas sem pedido explicito;
- Fecha apenas processos que o proprio LionClaw spawnou. **Nao e `pkill`, nao varre o SO, nao casa por nome** - e impossivel tocar um Codex CLI aberto no terminal ou em outro app;
- Nao toca os runtimes cloud/local/external, nem o loop coder/evaluator do HarnessEngine, nem `advanceToNextPhase` (transicoes automaticas continuam sem matar nada).

A acao aparece no **log normal do Lion** ("maybeKillIdleCodexOnGate: pool Codex resetado no gate"). Apos a limpeza, a proxima fase Codex sobe com processo fresco.

### Reset, pausa e historico

A tela Pipeline suporta:

- pausar e abortar pipeline;
- retry de fase;
- reset de fase ou sprint com preview;
- historico por fase;
- preview de documentos gerados;
- metricas por fase e por agente;
- tracking de sprints, rounds, custo e duracao.

---

## LionDesign Studio

Sidecar local em `vendor/open-design/` que gera artefatos visuais de design (HTML interativo + contrato JSON + briefing markdown) usados pelo pipeline `development-v2` nas fases de design (LionDesign Studio e Design Lock).

> [!NOTE]
> **LionDesign** e o nome do motor de design na UI. Os identificadores tecnicos mantem o nome upstream: a pasta `vendor/open-design/`, os canais IPC `open-design:*` e o `agentId: open-design-studio`. O mapeamento de branding vive em `electron/main/liondesign-branding.ts`.

### Como funciona

1. Na fase LionDesign Studio (fase 5) do pipeline `development-v2`, o agente `open-design-studio` conversa com o usuario para iterar sobre o design.
2. O sidecar roda a partir do data dir do app - `<userData>/open-design/runtime/.od/` (`open-design/paths.ts:30-43`), exposto ao app por uma WebContentsView embutida. **Nao ha variavel `OPEN_DESIGN_ROOT`** (o env foi removido; o diretorio do sidecar `.od/projects/` pertence ao Open Design e nao entra nos artefatos do pipeline).
3. Os 24 canais IPC `open-design:*` registrados no preload cobrem o ciclo de vida (`preflight`, `setup`, `start`, `stop`, `status`, `snapshot`), o boot-installer, a ponte de view e o `destructive-unlock` (escape hatch).
4. Quando o usuario aprova o design, a fase Design Lock (fase 6) gera o snapshot no destino canonico `<projectPath>/docs/Docs<pipelineDocsId>/design/` (`pipeline-paths.ts:119-162`) com **5 arquivos** (`pipeline-paths.ts:122-127,155-160`):
   - `manifest.json` - metadados do lock
   - `design-contract.json` - schema do design (telas, componentes, props)
   - `artifact.html` - artefato interativo
   - `design-brief.md` - briefing textual que vai pro contexto das fases tecnicas
   - `design-lock-report.md` - relatorio do lock

### Seguranca do artifact HTML

O HTML gerado pelo modelo e **conteudo nao confiavel**. O artefato lockado e renderizado num iframe `sandbox="allow-scripts"` (sem `allow-same-origin`), carregado via protocolo custom `lionclaw-asset://host/locked-design/<projectId>` com CSP propria e path-scoping (`src/components/open-design/LockedDesignViewer.tsx:120-126`, `electron/main/index.ts`). Nunca acessa o DOM do renderer.

### Boot do vendor

Na primeira execucao, o boot-installer roda `pnpm install --frozen-lockfile` em `vendor/open-design/`. Recomenda-se **Node 24** (ver Pre-requisitos); o instalador nao bloqueia por versao, mas troca de major do Node invalida o ABI nativo. Se o pnpm falhar, a fase LionDesign Studio do `development-v2` nao sobe - veja Troubleshooting > "LionDesign daemon nao sobe".

---

## Funcionalidades

### Chat

Chat com streaming, tool calls visiveis, Markdown com GFM, anexos, imagens, audio, artefatos e slash commands. Sessoes e mensagens ficam no SQLite.

**Contexto vivo e auto-compactacao.** A barra de contexto mostra o uso real da janela do modelo ativo, model-aware, em todos os runtimes de chat (cloud, Claude-compat, Codex, Grok, Kimi e Lion), com fonte unica de context window (`getContextWindow`). O chip in/out so exibe usage real medido - estimativas nao aparecem como se fossem medicao. Quando o historico se aproxima do limite, o chat se **auto-compacta em qualquer provedor**: gatilho pos-turno com alvo configuravel (`chat_compaction_target_tokens`, migration V129), compactacao in-place da conversa e guardas anti-thrashing com cooldown (`chat-compaction-trigger.ts`, `chat-compaction-inplace.ts`).

**Chips de Pipeline e Workflows.** Toggles por conversa no composer ligam/desligam as capacidades de dirigir pipelines e workflows dinamicos naquela sessao (`ChatCapabilityToggle.tsx`). Vem desligados por padrao e o toggle vale para o proximo envio; o gate de capability roda em modo shadow por padrao (observa sem bloquear, `chat-capability-gate.ts`).

### Terminal integrado

Dock de terminal real (node-pty + xterm.js) embutido na pagina de Chat (`src/components/chat/TerminalDock.tsx`, `XtermView.tsx`), com backend em `electron/main/terminal-pty.ts`. Os canais `terminal:{open,write,resize,close}` e os eventos `terminal:data`/`terminal:exit` sao expostos em `window.lionclaw.terminal`. Suporta ate 8 abas; os shells sobrevivem a navegacao entre paginas. Abre o shell real do usuario (PowerShell no Windows, zsh/bash com rc no unix) no home.

### Kanban nativo

Gestao de demandas dentro do LionClaw, sem depender de ferramenta externa. Um quadro por repositorio registrado, com colunas fixas **Backlog / Desenvolvimento / Testes / Done** e cards identificados por prefixo do quadro mais numero sequencial (`LC-26`). Pagina propria no menu lateral, que substituiu a entrada **Canais**.

**Dois consumidores, um dominio.** A tela (canais IPC `kanban:*`) e o orquestrador (MCP `lionclaw-kanban`, 10 tools `board_*`/`card_*`) passam pelo MESMO engine (`electron/main/kanban-engine.ts`), entao criar, consultar, mover e entregar card funcionam igual pelo chat e pela interface. Toda escrita emite `kanban:changed` e fica registrada em `card_events` com o autor aproximado da chamada (`user`, `orchestrator` ou `scheduler`).

**Sem travas.** Nenhuma operacao recusa por campo vazio ou por transicao de coluna: tudo executa e devolve `warnings` informativos. Card sem criterio de aceite, bug sem reproducao ou feature sem teste de aceite entram normalmente, so ficam marcados. As unicas recusas reais sao de integridade: prefixo duplicado, repositorio que ja tem quadro, card sem titulo, referencia ou anexo inexistente, entrega sem commit, coluna inexistente e falha de IO. A doutrina de qualidade vive no prompt do orquestrador (`buildKanbanSection`), nunca em codigo que trava o seu fluxo.

**Anexos.** Arquivos colados ou soltos no card sao copiados para `~/.lionclaw/kanban/<board_id>/<local_id>/` e servidos ao viewer interno pelo protocolo `lionclaw-kanban://` (imagem e PDF) ou por `kanban:read-attachment` (texto).

**Do card ao codigo.** Card aprovado vira insumo direto para pipelines e workflows, e a entrega formal (`card_deliver`) exige o commit, que fica linkado no quadro.

Tabelas `kanban_boards`, `kanban_cards`, `kanban_card_events` e `kanban_card_attachments` (migration V147).

### Sub-Agentes

Cada agente tem configuracao propria:

- runtime: `cloud`, `codex`, `grok`, `zai`, `minimax-tp`, `kimi`, `local` ou `external`;
- modelo;
- prompt;
- tools;
- MCP servers;
- skills;
- effort;
- thinking;
- max turns;
- max tool rounds;
- squad.

Agentes `cloud` rodam pelo Claude Agent SDK. Agentes `codex` usam Codex CLI. Agentes `grok` usam a CLI oficial da xAI via assinatura Grok Build (`agent-runtime/grok-executor.ts`, catalogo em `src/constants/grok-models.ts`). Agentes `zai` e `minimax-tp` usam o executor Claude-compat (Z.ai GLM e MiniMax Token Plan). Agentes `kimi` usam a CLI nativa do Kimi via assinatura (ver [Kimi como runtime CLI nativo](#kimi-como-runtime-cli-nativo)). Agentes `local` usam Ollama, LM Studio ou OpenAI-compatible local. Agentes `external` usam HTTP OpenAI-compatible.

A pagina Sub-Agentes tem busca, filtro por modelo e abas (Workflow / Library / por squad) para navegar entre os agentes (`SubAgentsPage.tsx:124,277-297`).

**Sincronizar com orquestrador.** Um botao reescreve runtime, modelo e configs de todos os agentes (ou de um subconjunto filtrado) para casar com o SDK orquestrador atual, preservando tools, MCP servers e skills de cada agente (`agent-sync.ts:409`). Ha preview (dryRun) antes de aplicar. O sync fica indisponivel enquanto houver pipeline ativo, lock de projeto ou sessao enrich em andamento - nesse caso a UI mostra o motivo (`agent-sync.ts`). Um sub-agente `cloud` com `model = default` ja herda o modelo do orquestrador em runtime, sem precisar de sync (`orchestrator.ts:555`).

O **reasoning effort** acompanha: o sync leva o effort do orquestrador junto (Claude e Codex), e sub-agentes disparados pelo chat herdam o effort do orquestrador em runtime. No formulario de agente Codex, o select de effort e model-aware - so oferece os valores que o modelo suporta (`xhigh`/`max`/`ultra` conforme o caso, ver [Modelos Codex no app](#modelos-codex-no-app)).

### Knowledge Base

Ingestao de **PDF, DOCX, TXT, Markdown e CSV** (`knowledge-engine.ts:267-281`). O sistema faz parse, chunking e embeddings, com limite de **100 MB** por arquivo.

- **Embeddings**: OpenAI `text-embedding-3-small` quando `OPENAI_API_KEY` existe, com fallback Ollama se configurado e se as dimensoes baterem (o default Ollama de 768 dims e rejeitado; ver Troubleshooting).
- **Busca hibrida**: combina BM25 (lexica) + vetorial e funde com **RRF (k=60)**; opcionalmente faz **rerank** via Cohere `rerank-multilingual-v3.0` e usa **HyDE** (geracao de documento hipotetico) para enriquecer a query (`knowledge-engine.ts:612,631,733,872`).
- **Chunking agentic**, **reprocessamento** de documentos e **config por agente** (cada agente pode ter sua KB e parametros) estao disponiveis na pagina Knowledge (`KnowledgePage.tsx:904,1147`).
- **Benchmark** de busca embutido para comparar estrategias (`knowledge-benchmark.ts`).

> [!NOTE]
> HyDE, chunking agentic e benchmark usam Claude (`ANTHROPIC_API_KEY`), alem da chave OpenAI usada para os embeddings.

### Memoria

O agente mantem uma **memoria de trabalho** em `~/.lionclaw/MEMORY.md`, injetada em todo prompt. Ela e organizada em quatro secoes e e atualizada por compactacao.

A **compactacao** (`memory-pipeline.ts` `runCompaction`) resume e consolida o historico. Ela e disparada manualmente, na troca de orquestrador, e na rotacao de sessao do Telegram - **nao ha cron**. Roda na assinatura/credencial do orquestrador ativo (a mesma que o chat usa), sem fallback silencioso para outro modelo: se a selecao nao resolver, a operacao falha com erro tipado (`resolveCompactionSelection`). A pagina **Cerebro** (MemoryPage) permite inspecionar e editar a memoria.

O **USER.md e governado**: o perfil do usuario tem estrutura canonica com saneamento e atualizacao controlada (`memory-pipeline/user-profile.ts`), para o arquivo nao inchar nem corromper com o tempo. As atualizacoes passam por operacoes validadas em vez de reescrita livre.

Ver tambem [Dreaming](#dreaming-manutencao-automatica-de-memoria), que faz manutencao automatica REMOVE/UPDATE da memoria.

### Memory Graph

O **Memory Graph** (mgraph) e um vault de notas com relacionamentos, com pagina **Graph** dedicada (`mgraph-engine.ts`, `GraphPage.tsx`). E desligado por padrao; o toggle fica em Settings e **exige reiniciar o app** para valer (`SettingsPage.tsx:490,558`). Quando ligado (`mgraph_mode=true`), o MCP `graph-search` fica ativo.

O graph tambem ingere documentos (`graph-ingest.ts:854-878`): PDF, DOCX, XLSX/CSV, Markdown/TXT/JSON/YAML, imagens (`.png`, `.jpg`, `.jpeg`, `.webp`, com OCR) e audio (`.mp3`, `.wav`, `.ogg`, `.m4a`, `.flac`, com STT via API OpenAI ou ElevenLabs, setting `ingest_stt_provider`), alem de URLs com protecao contra SSRF. So roda com `mgraph_mode=true`.

### Skills

Skills sao instrucoes em Markdown com frontmatter. O MCP `skills` expoe `list_skills`, `load_skill` e `get_skill_metadata`. Agentes com skills vinculadas recebem o MCP automaticamente.

### Enrich

Fluxo conversacional de duas fases para melhorar uma SPEC antes da implementacao:

1. Validator: cruza SPEC, PRD e codigo existente.
2. Enricher: adiciona edge cases, estados de UI, fluxos alternativos, tratamento de erros e permissoes.

### Harness

O **HarnessEngine** e o motor standalone do loop Planner -> Coder -> Evaluator (`harness-engine.ts`). Ele NAO e uma pagina navegavel na Sidebar; e um motor interno reusado pelos pipelines: as fases Planner, Coder e Evaluator de todos os pipelines (dev, feature, security, architecture-review, development-v2) sao executadas por esse mesmo HarnessEngine compartilhado (`pipeline-engine/index.ts`). O Coder implementa, o Evaluator valida contra criterios, e o loop repete ate o numero maximo de rounds.

### Scheduler e Tasks

Duas coisas diferentes:

- **Scheduled Tasks** (IA agendada): scheduler baseado em `cron-parser` que roda agentes em horario. Os cron sao avaliados em **UTC** (a UI converte do horario local para UTC), com poll a cada 30s (`scheduler.ts:22,39`). As execucoes rodam em **modo silent** (sessao isolada, vista via "Ver Sessao"). Nao existe "executar agora" - voce pode **pausar/retomar** uma task e **revisar** runs (`scheduler.ts:30-32`, `ipc-handlers.ts:972-1055`). Inclui historico de runs, calendario, kanban e filtros.
- **Personal Tasks** ("Minhas Tasks"): um kanban manual de to-do, **sem IA** (`TasksPage.tsx`).

### Canais (Telegram)

A pagina **Canais** integra o LionClaw a apps de mensagem. Hoje so o **Telegram** esta ativo; Slack, Discord e WhatsApp aparecem como "Em breve" (placeholders), com botao "Testar Conexao" (`ChannelsPage.tsx:171-190`).

O **Telegram** e uma bridge bidirecional via bot token, **single-user** (so o seu chat). Conversas sao roteadas para o orquestrador e retornam ao Telegram. E multimodal: aceita texto, **voz** (transcrita; exige `OPENAI_API_KEY`), fotos e documentos, e responde com texto, imagem e audio. Setup: crie o bot no BotFather, pegue seu chat id no userinfobot e configure na pagina Canais.

Comandos de controle de contexto (`telegram-bridge.ts:688-791`):

| Comando | O que faz |
|---------|-----------|
| `/compact` | Compacta a conversa atual (mesma conversa, contexto condensado) |
| `/clear` | Salva na memoria e encerra; a proxima mensagem comeca do zero |
| `/reset` | Alias de `/clear` |
| `/status` | Status do sistema e contexto ativo vs threshold de compactacao |
| `/help` | Lista os comandos disponiveis |

### Vault

Vault com keychain do SO e fallback criptografado. A UI permite salvar, testar e apagar chaves conhecidas.

### CodeBurn

Dashboard de uso via CodeBurn embutido em terminal xterm.js. O main process resolve o binario Node do sistema e executa `codeburn report`.

### Auth

Autenticacao local com bcrypt e TOTP. O app bloqueia a sessao em suspend e lock-screen. (A implementacao de TOTP e propria, sem `otplib`; `auth.ts:14-92`.)

---

## Permissoes

Configuravel em **Settings > Permissoes** (`SettingsPage.tsx:92-99,427-430`). A pagina tem dois blocos: o **toggle de bypass** e o **catalogo de ferramentas**.

> [!IMPORTANT]
> O **bypass total de permissoes vem LIGADO por padrao** (`db.ts:3788-3802`). Com bypass ligado, o agente do **chat** executa acoes destrutivas (por exemplo `rm`, `sudo`, escrita em `.env`) **sem pedir confirmacao**. Desligue o toggle se quiser o guard com popups de confirmacao.

### Toggle de bypass

- Default: **ligado** (ausencia da chave = ligado). Mudar o toggle tem efeito imediato.
- O bypass e do guard de **chat** apenas. Ele **nao** afeta:
  - o **bloqueio total de git** (regra de produto independente, ver abaixo);
  - os **pipelines / harness / security**, que rodam com `PERM_BYPASS_NO_GUARD` e nem passam pelo guard de chat (`permission-profiles.ts:4-7`). Desligar o bypass **nao** protege os pipelines.

### Catalogo de ferramentas

Cada ferramenta pode ser habilitada/desabilitada com nivel de risco (`PermissionsPage.tsx`, `db.ts:3834`). Algumas vem **desligadas por padrao**: `WebSearch`, `WebFetch` e `NotebookEdit`. O `WebSearch` tem custo extra (~$0.01 por busca).

### Comandos Git bloqueados (deny total)

Comandos git que mudam o estado do repositorio sao **negados diretamente, sempre - mesmo com bypass ligado** (`permission-guard.ts:66-95,187-192`). A lista inclui: `commit`, `push` (e `push --force`), `reset`, `rebase`, `merge`, `rm`, `stash drop`, `tag`, `remote add/set-url/remove/rename`, `fetch --force`, `checkout -- <path>` e `clean -f`. O versionamento e **manual** - o LionClaw nunca commita por voce. Git read-only (`status`, `diff`, `log`) e permitido, e troca de branch (`git checkout main`, `git checkout -b`) nao e bloqueada.

### Acoes destrutivas e auditoria

Com o bypass **desligado**, acoes destrutivas exigem confirmacao via popup, com niveis de risco `medium`/`high`/`critical` (`permission-guard.ts:301-309,87-97`, `ConfirmDialog.tsx:11-21`). Durante a auditoria de seguranca, leitura direta de `.env*` e bloqueada: o agente deve verificar historico Git e `.gitignore` sem abrir secrets. Todas as tool calls geram audit trail.

---

## Arquitetura

```text
Renderer React + Vite
        |
        | Electron IPC via contextBridge
        v
Main Process Node.js + TypeScript
        |
        +-- Orchestrator
        +-- Agent Runtime Executors
        |     +-- cloud: Claude Agent SDK
        |     +-- local: Ollama, LM Studio, OpenAI-compatible
        |     +-- external: OpenRouter, OpenAI, custom HTTP
        |     +-- codex: OpenAI Codex CLI (app-server)
        |     +-- grok: Grok Build CLI (xAI, ACP)
        |     +-- kimi: Kimi CLI (Moonshot, ACP)
        |     +-- zai / minimax-tp: executor Claude-compat
        |
        +-- SQLite + sqlite-vec
        +-- PipelineEngine
        +-- HarnessEngine
        +-- KnowledgeEngine
        +-- Scheduler
        +-- MCP Manager
        +-- Telegram Bridge
        +-- Vault
```

Regras importantes:

- Renderer nunca acessa Node.js diretamente.
- Todo acesso a banco fica no main process.
- Todos os IPCs passam pelo preload.
- Todas as operacoes SQLite usam prepared statements.
- Segredos nunca ficam no banco nem em arquivos plaintext.
- MCPs rodam como subprocessos stdio.
- Pipelines gravam artefatos no projeto alvo, normalmente dentro de `.lionclaw/`.

---

## Boot Sequence

Sequencia do boot atual, na ordem real do `app.whenReady` (`electron/main/index.ts:1019-1416`):

1. Registra handlers de excecao e shutdown e o protocolo `lionclaw-asset://`.
2. Cria arquivos base em `~/.lionclaw/` (`ensureLionClawFiles`).
3. Copia skills default se ainda nao existem (`copyDefaultSkills`).
4. Gera `CLAUDE.md` a partir de `SOUL.md`, `RULES.md`, `USER.md`, `MEMORY.md` e inicia o watcher desses arquivos.
5. Inicializa SQLite e aplica todas as migrations pendentes (atualmente ate **V145**). Antes de migrar, o app faz backup verificado do banco com marker de recuperacao (`db-migration-safety.ts`); em falha de migration, mostra um dialog com o path do backup e encerra.
6. Roda `seedToolDefaults`, `ensureAllSeedAgents` e `ensureDreamingSkillFrontmatter`.
7. Migra transcripts `.jsonl` legados do Telegram para o DB (`migrateTelegramJsonlOnBoot`).
8. Registra entradas do Vault para os providers externos.
9. Inicia Knowledge Bridge (UDS para o MCP subprocess).
10. Inicia watcher de ingestao graph quando `mgraph_mode=true`.
11. Instancia HarnessEngine e PipelineEngine e registra os IPC handlers; inicializa o drive coordinator (`initPipelineDriveCoordinator`) e recupera drives interrompidos.
12. Recupera runs de Workflows Dinamicos interrompidos (`recoverWorkflowRunsOnBoot`).
13. Garante MCPs built-in (`ensureBuiltinMCPServers`).
14. Inicia o local IPC server (`startLocalIpcServer`) antes de spawnar os MCPs helper.
15. Restaura sessoes OAuth de MCP remoto a partir do Vault (`restoreHiggsfieldSessionFromVault`).
16. Inicia MCPs ativos (`startActiveMCPServers`).
17. Sincroniza o bloco `LIONCLAW_MANAGED` do Codex MCP config (`syncCodexMcpConfig`).
18. Descobre MCPs remotos do SDK em background (`discoverSDKMcpServers`).
19. Inicia o Scheduler.
20. Inicia o Telegram bot em background (fire-and-forget).
21. Cria a BrowserWindow e expoe a janela ao local IPC server (`registerWindowProvider`).
22. Inicializa o wrapper central de meta-tools MCP (`initMcpInvoke`, modo MCP Index/gateway).
23. Dispara o boot-installer do Open Design em background (`ensureVendorReady`, idempotente).
24. Inicializa o auto-updater (somente fora de development).
25. Registra power monitor para auto-lock.

### Diretorio `~/.lionclaw`

```text
~/.lionclaw/
  SOUL.md
  RULES.md
  USER.md
  MEMORY.md
  BOOTSTRAP.md
  CLAUDE.md
  .claude/
    settings.json
  agents/
    <agent-id>/
      config.json
  skills/
  conversations/
  background/
  data/
    lionclaw.db
    sessions/
```

---

## MCP Servers

A pasta `mcp-servers/` traz **26 MCP servers standalone** (mais a lib interna `_shared/`). MCPs built-in sao registrados no banco no boot. Servidores que exigem chave podem ficar inativos ate a configuracao no Vault. As tabelas abaixo cobrem 25 deles; o 26o e o `local-agents`, que aparece apenas no auto-inject no fim da secao.

| ID | Ativo por padrao | Chaves | Uso |
|----|------------------|--------|-----|
| `memory-search` | Sim | `OPENAI_API_KEY`, `COHERE_API_KEY` opcionais | Busca em memoria semantica |
| `excalidraw` | Sim | Nenhuma | Diagramas e whiteboard |
| `local-llm` | Sim | Nenhuma | Ollama e modelos locais |
| `knowledge-base` | Sim | Nenhuma | Busca em documentos indexados |
| `skills` | Sim | Nenhuma | Carregamento de skills |
| `graph-search` | Condicional | Nenhuma | Knowledge graph quando `mgraph_mode=true` |
| `elevenlabs` | Nao | `ELEVENLABS_API_KEY` | Text-to-speech |
| `nano-banana` | Nao | `GOOGLE_GEMINI_API_KEY` | Geracao de imagens |
| `shopify` | Nao | Shopify | Integracao Shopify |
| `google-gmail` | Nao | Google OAuth | Gmail |
| `google-drive` | Nao | Google OAuth | Drive |
| `google-sheets` | Nao | Google OAuth | Sheets |
| `google-calendar` | Nao | Google OAuth | Calendar |
| `youtube` | Nao | Google OAuth | YouTube |

Helpers internos visiveis apenas para o orquestrador Codex (`visibleTo='codex-lion-only'`, seedados ativos, `electron/main/index.ts:926-947,974-1007`):

| ID | Uso |
|----|-----|
| `lionclaw-agents` | Expoe os sub-agentes do Lion ao Codex |
| `lionclaw-skills` | Expoe as skills do Lion ao Codex |
| `lionclaw-user-question` | Permite ao Codex fazer perguntas ao usuario |

Seams internos do LionClaw (proxies finos para o main process via local IPC, servem os quatro runtimes):

| ID | Uso |
|----|-----|
| `lionclaw-pipeline-control` | Tools `pipeline_*` (orquestrador dirigindo pipelines) |
| `lionclaw-telegram` | Tool `telegram_notify` (push proativo do orquestrador para o Telegram; so envia com o icone ARMADO no chat) |
| `lionclaw-preview` | Tools `preview_open` e `preview_capture` (abre HTML local/localhost e captura PNG com sessao isolada) |
| `lionclaw-dynamic-workflows` | Tools `dynamic_workflow_*` (autorar, iniciar e conduzir Workflows Dinamicos) |
| `lionclaw-toolscript` | Tool `run_tool_script` (executa um script de tool calls num unico turno) |
| `repo-graph` | 7 tools read-only `repo_graph_*` do Repo Mode (ver [CodeGraph](#codegraph)) |
| `gateway` | Meta-tools `mcp_invoke`/`mcp_schema` do modo MCP Index: os MCPs de negocio saem do contexto da sessao e viram um indice no system prompt; a execucao passa por aqui. Disponivel nas superficies Claude, Claude-compat e no chat Codex oficial |

### MCPs remotos (via mcp-remote)

Dois MCPs remotos (HTTP/SSE via `mcp-remote`) shipam no app como seed (`seed-mcps.ts:30-47`):

- `higgsfield`
- `blotato`

O `remote-bridge` e o proxy stdio<->HTTP que carrega os MCPs remotos (`electron/main/remote-mcp-wrapper.ts:77`).

Auto-inject:

- `knowledge-base` e injetado quando o agente tem Knowledge Base habilitada e documentos indexados.
- `skills` e injetado quando o agente tem skills vinculadas.
- `local-agents` e injetado quando existe agente `runtime=local`/`external` (`orchestrator.ts:377-417`).
- `codex-agents` e criado **in-process** (sem pasta) quando existe agente `runtime=codex` ativo (`codex-agents-mcp.ts:34-35`).

---

## Comandos

| Comando | Descricao |
|---------|-----------|
| `npm run dev` | Inicia Electron + Vite em modo desenvolvimento |
| `npm run build` | Compila main e renderer |
| `npm run preview` | Preview do build Electron Vite |
| `npm run dist` | Build e empacotamento com electron-builder |
| `npm run dist:mac` | Empacota para macOS |
| `npm run dist:win` | Empacota para Windows |
| `npm run build:mcps` | Compila todos os MCP servers |
| `npm run prepare:codegraph` | Prepara o runtime do CodeGraph |
| `npm run build:excalidraw-bundle` | Gera bundle do Excalidraw |
| `npm run rebuild:electron` | Rebuild de `better-sqlite3` e `node-pty` para Electron |
| `npm run rebuild:node` | Rebuild de `better-sqlite3` e `node-pty` para Node |
| `npm run typecheck` | TypeScript geral |
| `npm run typecheck:main` | TypeScript main process |
| `npm run typecheck:renderer` | TypeScript renderer |
| `npm run test` | Vitest |
| `npm run test:e2e` | Testes E2E Playwright no Electron real |
| `npm run test:watch` | Vitest em watch |

---

## Estrutura do Projeto

```text
LionClaw/
  electron/
    main/
      index.ts
      orchestrator.ts
      agent-runtime/
      pipeline-engine/
      harness-engine.ts
      security-audit-runner.ts
      repo-profiler.ts
      bug-analysis-runner.ts
      codex-runtime/
      codex-windows-prep.ts
      grok-acp/
      grok-sdk/
      kimi-acp/
      kimi-sdk/
      claude-compat-sdk/
      dynamic-workflows/
      repo-graph/
      codeburn-pty.ts
      cartesia-engine.ts
      voice-engine.ts
      dreaming-gate.ts
      dreaming-turn-engine.ts
      agent-sync.ts
      memory-pipeline.ts
      mgraph-engine.ts
      graph-ingest.ts
      permission-guard.ts
      terminal-pty.ts
      preview-open.ts
      db.ts
      db-migration-safety.ts
      liondesign-branding.ts
      ipc-handlers.ts
      mcp-manager.ts
      knowledge-engine.ts
      scheduler.ts
      telegram-bridge.ts
      vault-registry.ts
      open-design/
      seed-agents/
    preload/
      index.ts
  src/
    App.tsx
    hooks/
      useVoiceConversation.ts
    pages/
      AuthPage.tsx
      ChatPage.tsx
      SubAgentsPage.tsx
      PipelinePage.tsx
      DynamicWorkflowPage.tsx
      HarnessPage.tsx
      OpenDesignStudioPage.tsx
      KnowledgePage.tsx
      SettingsPage.tsx
      VaultPage.tsx
      PermissionsPage.tsx
      MemoryPage.tsx
      GraphPage.tsx
      RepositoriesPage.tsx
      ChannelsPage.tsx
      TasksPage.tsx
      SchedulerPage.tsx
      SkillsPage.tsx
      MCPServersPage.tsx
      LogsPage.tsx
      UsagePage.tsx
    components/
      chat/
      agents/
      pipeline/
      settings/
    stores/
      app-store.ts
      chat-store.ts
      pipeline-store.ts
    types/
      index.ts
      pipeline.ts
  mcp-servers/
  resources/
  scripts/
  tests/
```

---

## Empacotamento e Release

| Comando | Saida |
|---------|-------|
| `npm run dist:mac` | macOS `.dmg` (x64 + arm64) |
| `npm run dist:win` | Windows `.exe` (NSIS, x64) |

> [!NOTE]
> **Nao ha target nem script de empacotamento para Linux** (`electron-builder.yml` so define `mac` e `win`; nao existe `dist:linux` em `package.json`). No Linux, rode a partir do source (`npm run dev` ou `npm run build`).

### Auto-update

O `electron-builder.yml` **nao tem bloco `publish:`** (sem feed de update configurado). Apesar do `auto-updater` ser inicializado em producao (`index.ts:1364-1398`), sem feed ele nao tem de onde baixar. Na pratica, **a atualizacao e manual** via [Atualizar da versao anterior](#atualizar-da-versao-anterior) (`git pull` + `npm install` + `rebuild:electron`).

---

## Troubleshooting

### Chat nao funciona

Configure `ANTHROPIC_API_KEY` no Vault. Essa chave e obrigatoria para agentes Claude.

### OpenRouter falha

Verifique:

- `HARNESS_OPENROUTER_KEY` esta no Vault;
- a chave comeca com `sk-or-v1-`;
- o provider do agente e `OpenRouter`;
- a Base URL esta em `https://openrouter.ai/api/v1`;
- o teste de conexao no Vault passa.

### LionDesign daemon nao sobe (`Falha ao iniciar sessao` na Fase 5)

Mensagens tipicas: `Open Design daemon did not become healthy in time` ou erro `NODE_MODULE_VERSION` nos logs do sidecar (`<projectPath>/.lionclaw/pipelines/development-v2/<runId>/open-design/runtime/logs/sidecar-*.log`).

Causa comum: drift de ABI do Node (modulos nativos como `better-sqlite3` compilados contra um Node diferente do atual). O boot-installer atual detecta esse cenario e reinstala automaticamente - **basta reiniciar o LionClaw**. Se mesmo assim falhar:

1. Confirme o Node (recomendado 24.x): `node --version`.
2. Confira o status do boot-installer no indicador "Open Design" da UI; clique **Tentar novamente** se estiver em failed.
3. Como ultima diagnose, rode `pnpm install --frozen-lockfile` dentro de `vendor/open-design/` no terminal e veja o stderr.

Paths uteis do Open Design (`open-design/paths.ts:30-43`):

- **Data dir do sidecar**: `<userData>/open-design/runtime/.od/`
- **Sentinela de install OK**: `<userData>/open-design/runtime/.install/lionclaw-install-ok`
- **Logs do sidecar**: `<projectPath>/.lionclaw/pipelines/development-v2/<runId>/open-design/runtime/logs/sidecar-*.log`

### Codex nao conecta

Verifique:

```bash
codex --version
```

Depois rode o login pelo app ou manualmente no terminal. Se a sua versao do CLI nao aceitar `codex login`, atualize:

```bash
npm install -g @openai/codex
```

Depois autentique com o comando indicado pelo proprio CLI e clique **Testar conexao** no LionClaw.

### GPT-5.6 falha antes de comecar o run

Sintoma: um run com `gpt-5.6-sol` (ou Terra/Luna), ou com effort `max`/`ultra`, falha imediatamente. Causa tipica:

1. **CLI desatualizado** ("modelo nao anunciado pelo Codex CLI instalado"): o binario resolvido nao anuncia a familia GPT-5.6 no `model/list` (CLI anterior a `0.144`). Cenario comum: **Path customizado do binario** em Settings apontando para um CLI antigo. Remova o path (o app volta ao CLI embarcado `0.144.1`) ou atualize o binario para `0.144+`. Confira o indicador **App Server** em Settings > Provedores externos > Codex CLI (`src/components/settings/CodexSection.tsx:228-249`). Ver [Versao do Codex CLI](#versao-do-codex-cli).

### Codex no Windows falha em patches

Use o Health Check do Pipeline. O preparo exige working tree limpo. Se houver mudancas locais, commit ou stash antes. Repos com submodules sao pulados por seguranca.

### `node-gyp` nao encontra o Visual Studio no Windows

Sintomas tipicos durante `npm install` ou `npm run rebuild:electron`:

```text
Error: Could not find any Visual Studio installation to use
    at VisualStudioFinder.fail (...\node_modules\node-gyp\lib\find-visualstudio.js)
...
node-gyp failed to rebuild '...\node_modules\node-pty'
Rebuild Failed
```

O modulo `node-pty` (e outros nativos como `better-sqlite3`, `keytar`, `sqlite-vec`) precisa ser compilado contra a versao interna de Node usada pelo Electron. No Linux/macOS o compilador C++ ja vem no sistema. No Windows, e necessario o **MSVC** instalado via Visual Studio Build Tools - e o `node-gyp` so reconhece versoes estaveis suportadas (15 / 2017, 16 / 2019, 17 / 2022).

#### Causas mais comuns

1. **Build Tools nao instalados.** Falta a workload C++.
2. **Apenas VS 2026 / versao 18 (preview) instalado.** Voce ve `C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools` no Locais de instalacao. O `node-gyp` que vem com o Electron deste repo nao conhece esse layout ainda e ignora a instalacao, retornando o erro acima. Esse e o caso mais sorrateiro: o instalador esta presente, mas o gyp nao enxerga.
3. **Build Tools instalados sem a workload "Desktop development with C++".** Faltam MSVC, Windows SDK ou CMake.
4. **`msvs_version` apontando pra versao errada.**

#### Solucao recomendada

Siga o passo a passo completo em [Setup Windows passo a passo](#setup-windows-passo-a-passo) (5 etapas: instalar VS 2022 17, marcar workload C++, marcar Spectre libs em Componentes individuais, configurar `GYP_MSVS_VERSION`, rodar `npm run rebuild:electron`).

Os erros mais comuns mapeiam para cada etapa pulada:

| Erro | Etapa que falta |
|------|-----------------|
| `Could not find any Visual Studio installation to use` | (1) VS 2022 nao instalado, ou so VS 18 preview presente |
| `error MSB8040: as bibliotecas com Mitigacoes de Spectre sao necessarias` | (3) componente individual Spectre nao marcado |
| `'msvs_version' is not a valid npm option` | (4) tentou `npm config set` em vez de env var / .npmrc |

#### Verificacoes uteis

```powershell
# Versao do node-gyp interno (Electron usa essa)
npx node-gyp --version

# Qual msvs_version o npm vai pedir
npm config get msvs_version

# Onde o Windows acha o compilador (deve mostrar algum cl.exe)
where /r "C:\Program Files (x86)\Microsoft Visual Studio" cl.exe

# Variavel setada pelo "Developer Command Prompt for VS 2022"
$env:VCINSTALLDIR
```

Se `cl.exe` nao aparece em nenhum lugar abaixo de `Microsoft Visual Studio\2022\`, a workload C++ nao foi marcada - abra o instalador, clique **Modificar** e marque "Desenvolvimento para desktop com C++".

#### E se eu so quiser manter a versao 18 preview?

Da pra funcionar, mas e fragil. Voce precisaria atualizar manualmente o `node-gyp` interno e exportar overrides toda vez:

```powershell
npm install --save-dev node-gyp@latest
$env:GYP_MSVS_VERSION="2026"
$env:GYP_MSVS_OVERRIDE_PATH="C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools"
npm run rebuild:electron
```

Nem todos os modulos nativos do stack respeitam o override (`better-sqlite3` e `sqlite-vec` entre eles). Para evitar problemas, mantenha o 2022 instalado em paralelo e use-o como toolchain default.

### CodeBurn nao abre

Verifique:

- `npm install` foi executado;
- `node` esta no PATH do sistema;
- `node-pty` foi recompilado para Electron com `npm run rebuild:electron`.

### MCP nao inicia

Rode:

```bash
npm run build:mcps
```

Depois veja logs na pagina **Logs**.

### Knowledge Base nao retorna resultados

Verifique se os documentos estao com status `completed`. Para embeddings, o caminho recomendado e configurar `OPENAI_API_KEY` (`text-embedding-3-small`). O fallback Ollama exige um modelo que retorne **1536 dimensoes**; o default Ollama `nomic-embed-text` (768 dims) e **rejeitado** porque nao bate com a dimensao esperada (`embedding-provider.ts:89,111-117`).

### Erro de keytar no Linux

Instale:

```bash
sudo apt install libsecret-1-dev
```

Se o keytar ainda falhar, o app usa fallback criptografado local.

---

## Licenca

UNLICENSED - Proprietary (LionLabs)

## v3.8

### Workflows Dinamicos: modo unico, orquestrador no comando

O modo baseado em manifesto e builder foi aposentado. O arquivo `.js` E o workflow: `agent()`, `parallel()`, `pipeline()`, `phase()`, com modelo e esforco escolhidos por node. A criacao e exclusiva do orquestrador do chat pelas tools do MCP `lionclaw-dynamic-workflows`; nao existe modal de criacao.

Nao ha teto de custo por desenho: nenhum limite artificial interrompe um desenvolvimento no meio, e o freio operacional e pausar ou abortar pela conversa. O custo autoritativo do run fica em `dynamic_workflow_runs.total_cost_usd`.

O commit de entrega chega no repositorio sem arquivo interno da plataforma, e arquivos seus versionados dentro de `.lionclaw/` sao preservados.

### Orquestrador-driver e cockpit do run

O host deriva um veredito deterministico por evento (sem LLM) e so o evento terminal de uma cadeia acorda o orquestrador. Nas fronteiras de fase vale um semaforo fail-closed: achado P1 aberto, retry pendente ou writer sem green-check pausam o run num gate para o orquestrador decidir. Ausencia de sinal nunca conta como verde.

O wake e duravel: sobrevive a reinicio do app, e um run bloqueado no gate de entrega volta a acordar o orquestrador depois do restart. Contra loop, ha limite de wakes por run, com o turno seguinte entrando em modo somente-leitura.

`intervene rerun-node` reexecuta um node travado com instrucao nova sem perder o journal ja gravado, e `adjust-next-node` injeta ajuste no proximo node que iniciar.

A pagina do run ganhou cockpit com quatro abas: **Execucao**, **Custo** (por fase), **Saidas** e **Linha do tempo** com hora local. No chat, o workflow em execucao fica fixo no painel de Atividade, fora do scroll, e volta ao turno quando termina.

### Runtime Cursor (nono runtime)

Agente do Cursor via `@cursor/sdk` num sidecar Node dedicado, empacotado na distribuicao. Catalogo multi-frontier: `composer-2.5` mais Claude, GPT, Grok e Gemini servidos pelo seu plano Cursor. Cobre chat, pipelines, workflows dinamicos, sub-agentes e memoria.

Limites conhecidos e documentados: a leitura nativa do SDK nao e confinada ao workspace (por isso as tools guardadas rodam no processo principal), `sandboxOptions` nao existe no Windows, a policy e reaplicada a cada execucao porque nao persiste no resume, e na superficie de chat as skills do ambiente Cursor da maquina carregam junto.

### Agent SDK 0.3 com engine nativo

Migracao para `@anthropic-ai/claude-agent-sdk` 0.3.x com o engine Claude Code **nativo por plataforma** (`claude[.exe]`), sem `cli.js` interpretado. O binario vai na distribuicao via `asarUnpack`, ha tela propria de Claude Code e o login usa o engine que o app realmente resolveu.

A lista de tarefas do agente passa a valer em todos os modelos, e os runtimes Claude-compat recebem a janela de contexto real por `CLAUDE_CODE_MAX_CONTEXT_TOKENS`.

### Modelos

`gpt-6-astra` e o novo default do runtime Codex: janela de 1.05M, escala de esforco ate `ultra`, tarifa de long-context acima de 272K. **Exige Codex CLI 0.153 ou superior**; em versao anterior o app recusa na hora, com a mensagem dizendo o motivo (migration V150).

`claude-fable-5-1` substitui o Fable 5 no catalogo Claude, com migracao automatica de `orchestrator_model` e `agents.model` (migration V148).

No Z.ai, o **GLM-5.2 voltou a ser o padrao**. O 5.3 continua selecionavel, agora com aviso: a rota dele ainda entrega tool-calling instavel, e o 5.2 serve o mesmo modelo por alias.

### Kanban nativo

Ver [Funcionalidades > Kanban nativo](#kanban-nativo). Migration V147.

### Contador de tokens da sessao

O numero de tokens e o custo da sessao no chat passam a ser **so do orquestrador**. O consumo dos sub-agentes sai da soma e fica no detalhe por tarefa. O rotulo "tokens nao reportados" foi removido: o numero aparece sempre.

### Correcoes

- **Gateway MCP em desenvolvimento**: em dev o gateway subia sem ferramentas e a sessao nascia sem memoria, grafo, skills e integracoes, em qualquer modelo. Corrigido com `ELECTRON_RUN_AS_NODE` no spawn.
- **Guard de versao do banco**: apos a migration do Fable 5.1 o app recusava o proprio banco recem-migrado.
- **Painel de Atividade**: o bloco do workflow nao sequestra mais a rolagem do painel.

### Repositorio

Comentarios removidos do codigo do produto e a pasta `docs/` saiu do repositorio. Documento envelhece e desencontra do codigo; o nome e o teste valem mais que a explicacao.

## v3.7.1

Esta secao reune as features que entraram nesta release e ainda nao tinham entrada propria nas secoes acima. O que ja esta coberto em outras secoes (pipeline unificado, Development V2 + Open Design, Security e Architecture Review, voz/chat ao vivo, Dreaming, sincronizacao do orquestrador, Memory Graph, Knowledge Base) nao e repetido aqui.

### Modelos Claude e janelas de 1M

O catalogo Claude desta release (`src/constants/claude-models.ts`):

| Modelo | Observacao |
|--------|------------|
| `claude-fable-5-1` | Tier Mythos |
| `claude-opus-5` | **Default do app** (`claude-models.ts:29`) |
| `claude-opus-4-8` | |
| `claude-opus-4-7` | |
| `claude-sonnet-5` | |
| `claude-sonnet-4-6` | |
| `claude-haiku-4-5-20251001` | |

Opus 5, Opus 4.8+, Sonnet 5+ e Fable 5.1 usam **janela de contexto de 1M tokens**. Os modelos Claude-compat (GLM, MiniMax) declaram a janela real ao engine pela variavel `CLAUDE_CODE_MAX_CONTEXT_TOKENS` (injetada por `buildCompatEnv`/`buildZaiEnv`/`buildMinimaxTpEnv` a partir de `getContextWindow`); o antigo sufixo `[1m]` no nome do modelo foi removido porque o engine 0.3.x injeta uma beta que os endpoints compat rejeitam. A janela de cada modelo vem da fonte unica `getContextWindow`, a mesma que alimenta a barra de contexto do chat.

### Ledger de execucoes

Nova tabela `task_executions` (migration V138): arvore raiz/pai/filho das execucoes de agente, com custo, tokens e runtime por execucao.

### Seguranca de migration e rotacao de log

Antes de qualquer migration, o app faz backup verificado do banco com marker `migration-in-progress.json`; em falha, mostra o path do backup e encerra (`db-migration-safety.ts`). O log do app tambem ganhou rotacao de 50 MB, no boot e em sessao (`logger.ts`).

### Erros de provedor humanizados

Modulo central de erros de LLM com contrato tipado (`electron/main/agent-runtime/llm-error.ts`): qualquer falha de provedor (Claude, GLM, MiniMax, Kimi, Codex, local, external) e classificada e chega ao chat como mensagem clara em PT-BR, dizendo o que aconteceu e o que fazer, em vez de stack trace ou erro generico. Cobertura:

- **Resposta vazia do provedor** e erro tipado (`EmptyProviderResponseError`), com guard no lion-sdk e status `is_error` nos one-shots;
- **Sessao Codex derrubada no meio do turno** e recuperada sozinha (retry no boundary de `spawnAgent`);
- **Erros de rede, quota e auth** chegam humanizados no renderer via sink universal;
- **Falhas de subsistemas** (Knowledge/embeddings, Vault/secrets, Scheduler, Telegram, MCP, banco no boot) degradam com mensagem clara em vez de derrubar o app;
- Logs estruturados: serializer do pino para `err`/`error`/`reason` em todos os modulos.

### Repositorio no orquestrador (Repo Mode)

Vincula uma pasta de codigo local a uma conversa do chat e disponibiliza o code graph (CodeGraph) desse repositorio aos agentes, so para leitura, para que eles consultem a estrutura do codigo antes de `Glob`/`Grep`/`Read` brutos. A indexacao roda 100% local (provider CodeGraph via CLI, sem API externa) e o indice fica em `.codegraph/` dentro do proprio repositorio. Distinto do `graph-search` do Memory Graph (ver [MCP Servers](#mcp-servers)).

- Como usar no chat: nos controles da conversa, "Vincular repositorio" abre o dialog de pasta do sistema, valida e canonicaliza o caminho (realpath + git toplevel) via `validateRepoRootPath` e anexa o repo a sessao (`src/components/chat/RepoSelectorControl.tsx:46`, `electron/main/repo-graph/validate-root.ts:49` chamado de `electron/main/repo-graph/engine.ts:158`, anexo da sessao em `electron/main/repo-graph/engine.ts:211`). O vinculo e 1:1 por conversa (re-anexar troca o repo) e "Remover" desfaz so naquela conversa.
- Consentimento explicito: criar ou atualizar o graph SEMPRE exige acao do usuario. Ao ativar um repo sem graph, um dialog oferece "Criar agora", "Agora nao" (suprime o aviso na sessao) e "Nao perguntar de novo neste repo" (flag global do repo). Agentes nao tem tool de build/update: o engine so expoe a visao de leitura (`asReader()`) ao caminho agent-facing, e build/update sao alcancaveis apenas pelos handlers IPC da UI (`electron/main/repo-graph/engine.ts:599`, `electron/main/ipc/repo-graph.ts:226`).
- Estado e badge no chat: uma badge mostra 8 estados (sem repo, graph ausente, indexando, pronto, usado neste turno, desatualizado, erro, runtime limitado), derivados em `badgeState()` (`src/stores/repo-graph-store.ts:240`, visuais em `src/components/chat/RepoGraphBadge.tsx:9`). "desatualizado" (stale) nunca bloqueia, apenas sinaliza que vale atualizar (`electron/main/repo-graph/engine.ts:240`); "runtime limitado" aparece quando o runtime ativo do chat nao suporta as tools `repo_graph_*` (flag por turno `markRuntimeLimited`, `src/stores/repo-graph-store.ts:237,249`).
- Tools dos agentes: 7 tools read-only `repo_graph_*` (status, search, minimal_context, impact, node, callers, callees) servidas pelo MCP `repo-graph` e despachadas ao RepoGraphReader do engine (`mcp-servers/repo-graph/src/index.ts:59`).
- Pagina Repositorios: ha uma area dedicada no menu lateral ("Repositorios") para gerenciar os repos registrados e ver metricas de economia (tool calls e tokens com e sem graph ativo) via `repo-graph:metrics` (`src/components/common/Sidebar.tsx:72`, `electron/main/ipc/repo-graph.ts:206`).

A superficie de preload e `window.lionclaw.repoGraph.*` (12 invokes + listener `onStatus` com cleanup; `electron/preload/index.ts:807`). Build e update rodam em background com run persistido em `repo_graph_runs`; o progresso chega pelo broadcast `repo-graph:on-status` (`electron/main/repo-graph/engine.ts:407`).

### CodeGraph

A peca que da ao Repo Mode o seu indice estrutural e o provider **CodeGraph**, que roda o CodeGraph como subprocesso de CLI (`@colbymchenry/codegraph`, pinado em `^0.9.9`). A lib embutida exige Node 22.5+ (`node:sqlite`) e o Electron 33 roda Node 20, entao o provider spawna o binario de `node_modules/.bin/codegraph` em vez de importar a lib (`electron/main/repo-graph/provider-codegraph.ts:6-21,81-96`, `package.json:39`). O indice fica em `<repo>/.codegraph/codegraph.db`, dentro da propria pasta do repositorio.

- Onde fica: a pagina **Repositorios** na sidebar (`src/components/common/Sidebar.tsx:72`, `src/pages/RepositoriesPage.tsx`). La voce adiciona um repo, cria o indice (botao "Criar graph"), reindexa, faz update incremental ("Atualizar" = `codegraph sync`) e remove. Remover o repo do LionClaw nao apaga o `.codegraph/` local (`src/pages/RepositoriesPage.tsx:301`).
- No system prompt: quando o graph esta `ready` (ou `stale`), o app injeta uma secao condicional no system prompt anunciando as tools e pedindo usar `repo_graph_search`/`repo_graph_minimal_context` antes de busca bruta no repo (`electron/main/prompt-builder-repo-graph.ts:60-105`). Sem repo ativo o prompt fica byte-identico (zero overhead): `appendRepoGraphSection` retorna o prompt inalterado quando `getRepoGraphPromptSection()` e vazio (`electron/main/prompt-builder-repo-graph.ts:124-143`).
- Consentimento estrutural (Reader/Writer): o agente recebe apenas a visao read-only (`engine.asReader()`); build e update (Writer) so existem nos handlers IPC da UI. Nenhum runtime alcanca escrita do graph (`electron/main/repo-graph/engine.ts:8-10,599-615`).
- Comandos da CLI mapeados: `status` (probe do indice), `query` (search/node), `callers`, `callees`, `impact`, `files`, `init --index`, `index --force` e `sync`; `node` e um wrapper de `query --json` com match exato de nome (`electron/main/repo-graph/provider-codegraph.ts:292,308-408`).
- Staleness: o graph fica `stale` quando o `HEAD`/worktree muda apos o ultimo index, mas continua consultavel (badge amarela; staleness nunca bloqueia). A pagina mostra "Economia com CodeGraph", comparando tool calls e tokens por turno com e sem o graph (`src/pages/RepositoriesPage.tsx:136-205`).

### Telegram: notify proativo

A secao [Canais (Telegram)](#canais-telegram) ja cobre o bot bidirecional single-user e multimodal. O que e novo nesta release e o **push proativo**: a tool `telegram_notify(message)` deixa o orquestrador te avisar no Telegram quando voce esta longe do PC (tarefa concluida, gate aguardando decisao). Ela e exposta pelo seam dedicado `lionclaw-telegram` (dono canonico da tool em `helper-identity.ts:87`), registrado com `visibleTo: 'all'` e alcancavel por todos os runtimes de orquestrador.

- Gate anti-spam (armar/desarmar): por padrao o push fica **DESARMADO** (setting global `telegram:armed`; ausencia da chave = desarmado; `electron/main/db.ts:3509-3515`). So o **chip Telegram** no composer do chat (icone Megaphone/MegaphoneOff) arma o estado, fora do gate de sessao (`src/pages/ChatPage.tsx:888`), via os canais `tools:get-telegram-armed` / `tools:set-telegram-armed` (`electron/main/ipc/system.ts:208-222`) expostos como `window.lionclaw.tools.get/setTelegramArmed` (`electron/preload/index.ts:154-155`).
- Comportamento sem throw: desarmado, a tool retorna `{ sent: false, disarmed: true }` com instrucao em PT-BR para o agente pedir que voce acenda o icone; com o bot offline retorna `reason: 'bot-offline'`; armado e online, dispara `sendTelegramNotification` e retorna `{ sent: true }` (`electron/main/local-ipc/jsonrpc-methods.ts:1188-1218`).
- Push orchestrator-only: so o chat ativo empurra pelo seam compartilhado, nunca subagentes; o system prompt instrui o agente a respeitar `disarmed: true` em vez de insistir (`electron/main/prompt-builder.ts:308`).

Para receber avisos proativos, acenda o chip **Telegram** ao lado do chip Repo no chat. Separado disso, existe o `notifyDriveHandoff`, aviso de handoff do drive que so envia se a flag propria `notifyOnDriveHandoff` estiver ligada (`electron/main/telegram-bridge.ts:379-384`).

### Barra lateral de Atividade do orquestrador (Activity Log v2)

Painel lateral persistente no chat (`src/components/chat/ActivityPanel.tsx`) que mostra, agrupado por turno colapsavel, tudo que o orquestrador e seus sub-agentes executaram: chamadas de tool, sub-agentes e fases de pipeline/workflow, com detalhe e metricas. Fica no lado direito da pagina de Chat: colapsado vira um trilho fino com o icone Activity (botao flutuante no mobile) e abre sozinho na primeira atividade do turno. Cada bloco de turno traz titulo (primeira linha da mensagem do usuario), status agregado e totais (sub-agentes, tools, tokens, custo); abre em andamento e colapsa ao concluir.

- Sink central `recordActivity` (`electron/main/activity-log.ts:66`) emite o evento ao vivo e persiste no `activity_log` em try/catch (falha de DB nunca trava a UI). Instrumentado nos runtimes que dirigem o loop: Claude/orquestrador (`orchestrator.ts`), Claude-compat Z.ai/MiniMax (`claude-compat-sdk/index.ts`), Lion (`lion-sdk/stream-translator.ts`), Codex (`codex-sdk/stream-translator.ts`) e Kimi (`kimi-sdk/stream-translator.ts`).
- `deriveToolDetail` (`electron/main/activity-log.ts:204`) extrai o "o que chamou" por tipo de tool: arquivo (Read/Edit/Write/MultiEdit/NotebookEdit), comando (Bash), pattern (Grep/Glob), query (ToolSearch/WebSearch), url (WebFetch), descricao (Task) e um fallback generico para tools desconhecidas e MCP (nome com ":").
- Sub-agente exibe status em PT-BR, reloginho ao vivo (congela na duracao final), tokens in/out, custo e summary; tool de escrita ganha badge "alterou" vs "leu" (heuristica `isWriteTool`, `electron/main/activity-log.ts:78`). Fases de pipeline tem bloco proprio clicavel que abre o pipeline (via `project_id`, migration V81).
- Live update vs persistencia: o evento ao vivo viaja no proprio stream do chat como `StreamChunk { type: 'activity', activity: { ..., turnIndex } }`, emitido antes de qualquer escrita em disco (`electron/main/activity-log.ts:55`), sem canal IPC dedicado. A persistencia fica na tabela `activity_log` (migration V79, `electron/main/db-migrations/v79-activity-log.ts`), uma linha por `(session_id, turn_index, activity_id)` com upsert idempotente. Ao trocar de sessao o painel rehidrata via IPC `activity:get-blocks` (`electron/main/ipc/activity.ts`, exposto em `electron/preload/index.ts:50-53`); na compactacao (que cria sessao nova) os blocos sao zerados (clear-on-compaction, `src/stores/chat-store.ts`).

### Orquestrador dirigindo Pipelines

O orquestrador do chat pode CRIAR e DIRIGIR um pipeline de ponta a ponta, fazendo o papel do humano nas fases conversacionais. Voce conversa com o Lion ("quero construir tal feature"), ele oferece dirigir um pipeline e, com o seu ok, cuida das respostas, aprovacoes e gates por voce, narrando o progresso no chat. E aditivo sobre o pipeline existente (nao altera o pipeline-engine): as tools `pipeline_*` sao anunciadas ao orquestrador (Claude, Codex, Lion) e servidas pelo seam compartilhado `lionclaw-pipeline-control` (MCP registrado com `visibleTo: 'all'`, `mcp-servers/lionclaw-pipeline-control/src/index.ts:13`; anuncio canonico em `buildPipelineControlSection`, `electron/main/prompt-builder.ts:296-316`), um coordenador event-driven (`PipelineDriveCoordinator`, assina o bus de eventos do pipeline e enfileira um turno do orquestrador a cada estado acionavel, sem polling; `electron/main/pipeline-drive-coordinator.ts:794`) e estado persistido em `config.drive` (`DriveState`, `src/types/index.ts:2603-2639`).

- Inicio: o orquestrador chama `pipeline_create(projectPath, pipelineType, name, brief, drive?)` com `drive:"semi"|"full"` para criar e dirigir num passo, ou `pipeline_drive(id, mode)` para assumir um pipeline ja existente (`electron/main/prompt-builder.ts:302-303`, `electron/main/pipeline-control-core.ts:502-576`).
- Autonomia (semi/full): em `semi` ele escala os control gates (PRD, SPEC, validacao de sprints) com `pipeline_escalate` (resumo + pede seu ok) e conduz o resto; em `full` ele decide os gates lendo o artefato vs a intencao e so escala se divergir. Os gates de decisao do humano (o design no Development V2 e a escolha de alvo no Architecture Review) sao SEMPRE seus, mesmo no full (`electron/main/prompt-builder.ts:312`).
- Fases requiresHuman: o drive cede o volante (handoff temporario) e retoma sozinho na fase seguinte quando voce conclui.
- Resiliencia: no restart do app, drives que estavam dirigindo viram `awaiting-human` (nao retomam sozinhos) e pedem retomada no chat (`recoverInterruptedDrives`, `electron/main/pipeline-drive-coordinator.ts:1441-1467`).

Na UI, o avanco aparece no chat como um bloco de pipeline na barra de Atividade mais um chip indicador com relogio (`src/components/chat/BackgroundPipeIndicator.tsx`). Voce intervem a qualquer momento respondendo direto no chat (retoma o drive parado) ou pelos botoes do header do Pipeline (`src/components/pipeline/DriveControls.tsx`): Retomar, Parar e Assumir (handoff permanente que desliga o orquestrador daquele pipeline). O seletor semi/full fica no card do pipeline ativo na barra de Atividade. Os canais `drive:get-state | start | assumir | stop | resume | set-mode` cobrem essas acoes (`electron/main/ipc/drive.ts:31-179`).

### Workflows Dinamicos

Orquestra entregas de feature de ponta a ponta rodando um `workflow.js` sandboxado que coordena subagents. O script roda fora do processo principal em `utilityProcess.fork` dentro de um contexto `vm` limpo, sem acesso ao DOM nem ao global do host (`electron/main/dynamic-workflows/workflow-sandbox.ts`, `workflow-sandbox-child.ts`). Os workflows sao **autorados em JS estilo Claude Code**: `meta` literal + corpo top-level com `agent`/`parallel`/`pipeline`/`phase` (global `args`), compilados com piso de determinismo (`Date.now`/`Math.random`/`new Date()` sem args lancam no vm); o motor deriva um manifesto interno e cria nodes implicitos on-the-fly (`workflow-js-compiler.ts`). Cada node pode declarar **model e reasoning effort proprios**, inclusive cross-provider, com enforcement por dispatch path (cloud/zai/minimax-tp aplicam via guard in-process; codex aplica com clamp model-aware; kimi/local/external e fatal fail-closed). Os papeis do dev-loop (planner, coder, fixer, refuter e validadores; ids em `dev-loop-ids.ts`) sao seed agents do squad `dynamic-workflow`, referenciados pelos workflows autorados.

- **Full-auto e o modo unico**: o run decide os gates de fase sozinho conforme o modo declarado em cada gate do proprio `workflow.js`; o freio humano e pausar/intervir pelo chat. Quando o run **escreveu codigo**, o host auto-injeta um gate de entrega `cc-delivery` (nasce `mode:'orchestrator'`) e **push externo e sempre bloqueado** (`closer-permission-guard.ts`) - integrar o codigo e decisao sua.
- **Quem dirige e o orquestrador do chat**: o driver do run e o orquestrador (tools `dynamic_workflow_author`/`start`/`inspect`/`reply`/`approve`/`intervene`/`abort`/`edit_coordinator`, MCP `lionclaw-dynamic-workflows`); o narrador (`workflow-narrator-executor.ts`) so narra o progresso, sem tools de controle. Perguntas do run sao respondidas inline no proprio banner da tela do run (`DynamicWorkflowRunView.tsx`).
- Como usar / onde fica: a criacao e EXCLUSIVA do orquestrador do chat - voce conversa com o Lion, ele escreve o `workflow.js` e cria/inicia o run via `dynamic_workflow_author` (nao ha modal de criacao na UI). A aba "Workflows Dinamicos" na sidebar acompanha e controla os runs; edicoes de topologia de um run pausado passam por `dynamic_workflow_edit_coordinator` (aceita apenas `workflowJsSource`; o manifesto interno e sempre re-derivado).
- Cockpit: abas lazy Stream, Nodes, Artefatos, Custo, Manifest e Linha do tempo (`src/components/dynamic-workflow/DynamicWorkflowRunView.tsx`).
- Nunca perde trabalho: journal ordenado de chamadas, checkpoints por node e resume idempotente (as-of plan hash) recuperam runs interrompidos (`workflow-runner.ts`); o codigo vive numa worktree dedicada por run, com sprints sequenciais (`workflow-worktree.ts`). No dev-loop, nao-progresso persistente troca o fixer por um cerebro fresco (fresh fixer). Deletar e a unica acao destrutiva e pede confirmacao; Abortar so para e preserva tudo.

O namespace IPC `dynamic-workflow:*` fica no preload (`electron/preload/index.ts`).

### Kimi como runtime CLI nativo

O runtime `kimi` roda agentes pela CLI nativa do Kimi (Moonshot) usando a sua assinatura: o LionClaw aproveita a sessao do `/login` do proprio CLI, sem API key separada (`electron/main/agent-runtime/kimi-availability.ts:270-294`). E um runtime "Campo B" (o CLI dirige o loop agentico): o executor faz spawn de `kimi acp`, conduz o handshake e o `session/prompt` via protocolo ACP e auto-responde permissoes, traduzindo os eventos ao vivo para os callbacks canonicos do agent-runtime (`electron/main/agent-runtime/execute.ts:98-99`, `electron/main/kimi-acp/acp-driver.ts:1-21`). E auth full assinatura: nao ha fallback por api-key; sem login o run falha com erro claro em vez de custo silencioso de US$ 0.

- Modelos (`src/constants/kimi-models.ts:40-60`): `kimi-code/kimi-for-coding` ("Kimi K2.7 Code", ctx 262.144, thinking sempre ligado, sem effort explicito), o default (`KIMI_DEFAULT_MODEL`, `:60`); e `kimi-code/k3` ("Kimi K3", flagship, ctx 1.048.576, efforts `low`/`high`/`max` com default `max`; exige tier Moderato+ da assinatura). Ids namespaced, formato exigido pelo CLI.
- Custo: estimativa PAYG-equivalente marcada `subscription-equivalent-payg`, calculada dentro do executor (`electron/main/agent-runtime/kimi-executor.ts:341-380`), no mesmo padrao do MiniMax Token Plan.
- Concorrencia: pool limitado de subprocessos `kimi acp` (`acquireKimiSlot`, `electron/main/agent-runtime/kimi-executor.ts:164-171`); um 429/quota degrada so aquele run, classificado como `KimiQuotaError` (`electron/main/agent-runtime/kimi-executor.ts:390-392`, definido em `electron/main/agent-runtime/kimi-concurrency.ts`), sem derrubar os demais.
- Tools: expostas ao CLI por uma bridge HTTP-MCP em loopback apenas no perfil agent-scoped; runs de pipeline e one-shot rodam sem tools externas (`electron/main/agent-runtime/kimi-executor.ts:229-240`).
- Onde fica na UI: card "Kimi CLI" em Settings > Provedores externos (`src/components/settings/ExternalProvidersPanel.tsx:195`), com status de instalacao/login, botao "Conectar Kimi" (device-auth via browser), "Testar conexao" e path custom do binario. Por agente, escolha o runtime "Kimi (assinatura via CLI)" no seletor de Runtime do formulario de sub-agente (`src/components/agents/AgentFormModal.tsx:844`). Os 4 canais IPC `kimi:*` (status, test, open-login, set-binary-path) ficam em `window.lionclaw.kimi` (`electron/preload/index.ts:690-695`).

Distinto do provider "Kimi (Moonshot)" OpenAI-compat do Lion-SDK / runtime `external` (HTTP por API key, `src/components/agents/AgentFormModal.tsx:64`) ja citado em outras secoes: este e um runtime CLI nativo com executor proprio.

### Grok Build como runtime CLI nativo

O runtime `grok` roda agentes pela CLI oficial da xAI usando a assinatura **Grok Build**, sem API key (`agent-runtime/grok-availability.ts`). O executor spawna a CLI e traduz os eventos ao vivo via protocolo ACP (`grok-acp/acp-driver.ts`, `acp-translator.ts`, `acp-transport.ts`).

- Modelo: `grok-4.5`, contexto de 500.000 tokens, efforts `low`/`medium`/`high` com default `high` (`src/constants/grok-models.ts:11-22`).
- Tools: expostas ao CLI por uma bridge HTTP-MCP em loopback (`grok-acp/mcp-http-bridge.ts`).
- Atividade: os eventos chegam ao Activity Log via `grok-sdk/stream-translator.ts`.
- Onde fica na UI: card Grok em Settings > Provedores externos (`GrokSection.tsx`); por agente, escolha o runtime "Grok Build (assinatura via CLI)" no AgentFormModal.

### Codex oficial (App Server / novo SDK)

O runtime Codex roda num driver unico: o `official-app-server`. Ele sobe um processo `codex app-server` por escopo de sessao e fala JSON-RPC sobre stdio (`initialize`/`initialized`, `thread/start`, `turn/start`, `turn/interrupt`, etc.), traduzindo os eventos do App Server para o contrato `CodexStreamCallbacks`/`CodexResponse` (`electron/main/codex-runtime/official-app-server-driver.ts`, `official-event-translator.ts`). `getActiveCodexImplementation()` retorna `'official-app-server'` e `createCodexDriver()` instancia o driver (`codex-runtime/factory.ts:3-8`), sem flag nem selecao. A autenticacao e via `codex login` (OAuth), sem API key separada.

- **Modelos**: catalogo em `src/constants/codex-models.ts:9-18`, com default `gpt-5.6-sol` (`:20`) e efforts `low` | `medium` | `high` | `xhigh` | `max` | `ultra`.
- **Lifecycle**: os processos do App Server sao escopados por surface/projectId/ownerKind pelo lifecycle registry (`codex-runtime/lifecycle-registry.ts:136-142,306`).
- **UI**: em **Settings > Provedores externos > Codex CLI**, o bloco Driver Codex mostra o driver ativo e a saude do App Server (`CodexSection.tsx:228-249`).

### Claude Code CLI (config/diagnostico)

O Claude e o runtime nativo do LionClaw: o SDK cloud usa o engine embutido do Claude Code (binario nativo `claude`/`claude.exe` do pacote `@anthropic-ai/claude-agent-sdk-<plataforma>-<arch>`, SDK 0.3.x) e autentica pela assinatura via `claude login` (OAuth em `~/.claude`) ou por `ANTHROPIC_API_KEY` (env ou Vault). Por isso ele era o unico runtime sem menu de config. A secao **Claude Code CLI** em **Settings > Provedores externos** (`src/components/settings/ClaudeCodeSection.tsx`) da paridade com as secoes de Codex e Kimi: status, versao, modo de auth, testar conexao, conectar e path customizado do binario. Toda a deteccao de auth e read-only e segue a ordem real do SDK (`ANTHROPIC_API_KEY` no env, senao `~/.claude`, senao API key no Vault) (`electron/main/ipc/claude-cli.ts:40-51`).

- Status: mostra se o binario resolve ("Claude Code CLI nao resolvido" / "Resolvido mas sem auth" / "Conectado"), a versao lida com `<engine> --version` (ou do `package.json` ao lado de um `cli.js` legado), o `authMode` (`oauth` / `api-key` / `none`) e o path resolvido (`claude-cli:status`, `electron/main/ipc/claude-cli.ts:81-93`).
- Testar conexao: roda o binario com `--version` (timeout 10s) e reporta versao + modo de auth, ou o erro real (pega o caso `ENOENT` do engine em outro HD) (`claude-cli:test`, `electron/main/ipc/claude-cli.ts:97-151`).
- Conectar Claude: abre um terminal externo rodando `claude login` para OAuth via browser (`claude-cli:open-login`, `electron/main/ipc/claude-cli.ts:160-200`); depois use "Testar conexao".
- Path customizado (opcional): grava a setting `claude_cli_binary_path`. `getClaudeCodeExecutablePath()` so honra esse path quando preenchido E existente em disco; campo vazio mantem a resolucao automatica byte-identica, e um path quebrado cai no fallback automatico sem brickar o runtime (`electron/main/pipeline-shared/sdk-bootstrap.ts:45-68`). Util quando o engine empacotado nao resolve sozinho (ex: `node_modules` em outro HD/SSD). Um `cli.js` legado ainda roda via node, mas e a versao antiga (2.1.74) e nao serve o Fable 5.1.

Os 4 canais `claude-cli:{status,test,open-login,set-binary-path}` sao expostos no renderer como `window.lionclaw.claudeCli` (`electron/preload/index.ts:700-705`).
