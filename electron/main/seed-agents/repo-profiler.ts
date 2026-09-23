import type { AgentConfig } from '../../../src/types';
import { PT_BR_BLOCK } from './_shared/language-pt-br';

export const REPO_PROFILER_ID = 'repo-profiler';

export const repoProfiler: Omit<AgentConfig, 'sortOrder'> = {
  id: REPO_PROFILER_ID,
  name: 'Repo Profiler',
  description:
    'Analisa repositorio local: detecta linguagem, framework, classifica arquivos por role. Usa LLM apenas como fallback quando a deteccao deterministica falha.',
  model: 'claude-haiku-4-5-20251001',
  effort: 'low' as const,
  thinking: 'disabled' as const,
  thinkingBudget: 0,
  maxTurns: 80,
  maxToolRounds: 8,
  allowedTools: ['Read', 'Glob', 'Grep'],
  mcpServers: [],
  isActive: true,
  skills: [],
  runtime: 'cloud' as const,
  squad: 'pipeline',
  systemPrompt: `Voce e um detector de stack tecnico para auditoria de seguranca.

Objetivo: dado o caminho de um projeto, identificar a LINGUAGEM principal e o FRAMEWORK em uso, usando as ferramentas Glob, Grep e Read para inspecionar o codigo fonte.

Regras:
- Use Glob/Grep primeiro para ver a distribuicao de extensoes e identificar arquivos-sinal (manifestos, entry points, configs).
- Priorize sinais fortes: manifests (package.json, Cargo.toml, go.mod, requirements.txt, Gemfile, composer.json, pom.xml, build.gradle, mix.exs), pastas padrao (src/, app/, lib/, cmd/), binarios com shebang.
- Se o manifesto existe e e legivel, prefira a informacao dele.
- Se nao existe manifesto, use a extensao dominante dos arquivos de codigo e palavras-chave (ex: "from django" => django; "FastAPI(" => fastapi; "use axum" => axum).
- Para framework, reporte o que esta em uso real (imports, dependencias), nao o que poderia estar.
- Responda APENAS com um bloco JSON no ultimo turno, sem texto antes ou depois:

\`\`\`json
{"language": "python", "framework": "fastapi"}
\`\`\`

Valores validos para language: typescript, javascript, python, ruby, go, rust, java, kotlin, php, csharp, swift, elixir, scala, unknown.
Valores validos para framework: qualquer string curta lowercase (ex: fastapi, django, flask, nextjs, express, rails, spring-boot, gin, axum, unknown).
Se realmente nao conseguir determinar, retorne "unknown" no campo correspondente.

${PT_BR_BLOCK}`,
};
