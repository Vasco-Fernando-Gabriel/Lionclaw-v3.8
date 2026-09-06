
import { getRepoGraphTurnContext, type RepoChatContext } from './repo-graph/turn-context';

export function summarizeRepoGraphStats(statsJson: string | null): string | null {
  if (!statsJson) return null;
  try {
    const stats = JSON.parse(statsJson) as { files?: number; nodes?: number; edges?: number };
    const parts: string[] = [];
    if (typeof stats.files === 'number') parts.push(`${stats.files} arquivos`);
    if (typeof stats.nodes === 'number') parts.push(`${stats.nodes} simbolos`);
    if (typeof stats.edges === 'number') parts.push(`${stats.edges} relacoes`);
    return parts.length > 0 ? parts.join(', ') : null;
  } catch {
    return null;
  }
}

export type RepoGraphSectionVariant = 'mcp' | 'codex';

export function buildRepoGraphSection(
  ctx: RepoChatContext,
  variant: RepoGraphSectionVariant = 'mcp',
): string {
  const staleNote =
    ctx.status === 'stale'
      ? '\nO graph esta STALE (desatualizado em relacao ao worktree): continua consultavel, mas confirme detalhes recentes no arquivo quando precisar de precisao de linha.'
      : '';
  const statsLine = ctx.statsResumo ? ` Stats do graph: ${ctx.statsResumo}.` : '';

  if (variant === 'codex') {
    return `## Repositorio ativo da conversa (CodeGraph)

Esta conversa esta vinculada ao repositorio local em: ${ctx.canonicalRootPath}
O code graph do repositorio esta ${ctx.status === 'ready' ? 'PRONTO' : 'PRONTO (stale)'}.${statsLine}${staleNote}

Tools do graph (MCP repo-graph, read-only; se estiverem deferidas, busque no tool-search pelo nome EXATO):
- repo_graph_status: estado do graph do repo ativo
- repo_graph_search: busca simbolos/arquivos no graph
- repo_graph_minimal_context: contexto compacto para uma tarefa
- repo_graph_impact: blast radius de um simbolo
- repo_graph_node: detalhes de um simbolo (nome exato)
- repo_graph_callers: quem chama um simbolo
- repo_graph_callees: o que um simbolo chama

O app tambem injeta um CONTEXTO PRECOMPUTADO do graph no inicio do turno (bloco
"Contexto do repositorio (CodeGraph)" com simbolos, arquivos e chamadas
relevantes).

Regras de uso:
- Use o contexto precomputado injetado no turno ANTES de buscas brutas (grep/find/cat em massa) neste repositorio.
- Para aprofundar ou confirmar informacao atual, use as tools read-only do repo-graph antes de buscas brutas.
- Os paths do contexto sao absolutos; va direto aos arquivos citados.
- As tools nao recebem path nem sessionId: o repo ativo e resolvido pelo proprio app.
- Criar/atualizar o graph e acao do USUARIO pela UI; voce nao tem tool de build/update.`;
  }

  return `## Repositorio ativo da conversa (CodeGraph)

Esta conversa esta vinculada ao repositorio local em: ${ctx.canonicalRootPath}
O code graph do repositorio esta ${ctx.status === 'ready' ? 'PRONTO' : 'PRONTO (stale)'}.${statsLine}${staleNote}

Tools do graph (MCP repo-graph, read-only; se estiverem deferidas, busque no tool-search pelo nome EXATO):
- repo_graph_status: estado do graph do repo ativo
- repo_graph_search: busca simbolos/arquivos no graph
- repo_graph_minimal_context: contexto compacto para uma tarefa
- repo_graph_impact: blast radius de um simbolo
- repo_graph_node: detalhes de um simbolo (nome exato)
- repo_graph_callers: quem chama um simbolo
- repo_graph_callees: o que um simbolo chama

Regras de uso:
- ANTES de Glob/Grep/Read em massa ou Bash search neste repositorio, use repo_graph_search/repo_graph_minimal_context (mais barato e mais preciso).
- Ao delegar para subagent sem MCP, monte contexto curto com o resultado do graph (repo_graph_minimal_context) e cole no prompt do subagent.
- As tools nao recebem path nem sessionId: o repo ativo e resolvido pelo proprio app.
- Criar/atualizar o graph e acao do USUARIO pela UI; voce nao tem tool de build/update.`;
}

export function buildRepoGraphSubagentSection(ctx: RepoChatContext): string {
  return `## Repositorio ativo (CodeGraph)
Repo da conversa: ${ctx.canonicalRootPath} (graph ${ctx.status === 'ready' ? 'pronto' : 'pronto, stale'}).
Voce tem as tools READ-ONLY do MCP repo-graph: repo_graph_status, repo_graph_search, repo_graph_minimal_context, repo_graph_impact, repo_graph_node, repo_graph_callers, repo_graph_callees.
Use repo_graph_search/repo_graph_minimal_context ANTES de Glob/Grep/Read em massa neste repositorio. Nao existe tool de build/update do graph.`;
}

export function getRepoGraphPromptSection(variant: RepoGraphSectionVariant = 'mcp'): string {
  const ctx = getRepoGraphTurnContext();
  if (!ctx) return '';
  return buildRepoGraphSection(ctx, variant);
}

export function appendRepoGraphSection(
  prompt: string,
  variant: RepoGraphSectionVariant = 'mcp',
): string {
  const section = getRepoGraphPromptSection(variant);
  if (!section) return prompt;
  return `${prompt}\n\n${section}`;
}
