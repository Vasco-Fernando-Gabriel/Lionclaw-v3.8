import { DYNAMIC_WORKFLOW_AGENT_DENYLIST } from './types';

export type AuthoredAgentLookup = (id: string) => { access?: string | null; squad?: string | null } | undefined;

export const AUTHORED_WORKFLOW_SQUAD_ALLOWLIST = new Set<string>(['dynamic-workflow']);

export const AUTHORED_WORKFLOW_AGENT_DENYLIST = new Set<string>(DYNAMIC_WORKFLOW_AGENT_DENYLIST);

export const AGENT_DENYLIST_REASON =
  'builder (modo manifest removido), closer (escreve fora do gate de entrega), narrator e ' +
  'maestro (papeis de chat, nao de node) nao podem ser referenciados por workflows autorados. ' +
  'Use scout, doc-writer, coder/-codex/-glm, fixer, validator-*, refuter, sprint-planner ou plan-validator-*.';

export function extractAgentTypeLiterals(
  workflowJsSource: string,
): { dynamic: false; agentTypes: string[] } | { dynamic: true; sample?: string } {
  const keyRe = /(?:["']agentType["']|\bagentType)\s*:/g;
  const literalRe = /^\s*(["'])((?:\\.|(?!\1).)*)\1/;
  const agentTypes = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = keyRe.exec(workflowJsSource)) !== null) {
    const after = workflowJsSource.slice(m.index + m[0].length);
    const lit = literalRe.exec(after);
    if (!lit) {
      const sample = after.slice(0, 40).trim();
      return { dynamic: true, ...(sample ? { sample } : {}) };
    }
    agentTypes.add(lit[2]);
  }
  return { dynamic: false, agentTypes: Array.from(agentTypes) };
}

export function validateAuthoredAgentTypes(
  workflowJsSource: string,
  deps: {
    getAgent: AuthoredAgentLookup;
    squadAllowlist?: Set<string>;
  },
): { ok: true; agentTypes: string[] } | { ok: false; error: string } {
  const extracted = extractAgentTypeLiterals(workflowJsSource);
  if (extracted.dynamic) {
    return {
      ok: false,
      error:
        'workflow autorado usa agentType nao-literal (dinamico). No 1o corte da autoria por ' +
        'conversa, todo agentType deve ser um literal de string (ex: agentType: "dynamic-workflow-scout") ' +
        `para que a seguranca (writer/squad) seja verificada estaticamente${
          extracted.sample ? `; trecho: "${extracted.sample}"` : ''
        }.`,
    };
  }
  const allowlist = deps.squadAllowlist ?? AUTHORED_WORKFLOW_SQUAD_ALLOWLIST;
  for (const agentType of extracted.agentTypes) {
    if (AUTHORED_WORKFLOW_AGENT_DENYLIST.has(agentType)) {
      return {
        ok: false,
        error:
          `workflow autorado referencia o agentType "${agentType}", que esta na denylist: ` + AGENT_DENYLIST_REASON,
      };
    }
    const agent = deps.getAgent(agentType);
    if (!agent) {
      return {
        ok: false,
        error: `workflow autorado referencia agentType "${agentType}" que nao existe no catalogo de agentes.`,
      };
    }
    const squad = agent.squad ?? '';
    if (!allowlist.has(squad)) {
      return {
        ok: false,
        error:
          `workflow autorado referencia o agentType "${agentType}" da squad "${squad || '(sem squad)'}", ` +
          `fora da allowlist de squads permitidas para autoria (${Array.from(allowlist).join(', ')}). ` +
          'D-F4a: workflows autorados so podem usar agentType da squad dynamic-workflow.',
      };
    }
  }
  return { ok: true, agentTypes: extracted.agentTypes };
}
