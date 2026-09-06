
export interface CredentialUsage {
  agentsReferencing: Array<{ id: string; name: string; runtime: string; provider?: string }>;
}

function matchesVaultKey(
  vaultKey: string,
  apiKeyRef: string | undefined,
  provider: string | undefined,
): boolean {
  if (apiKeyRef === vaultKey) return true;
  if (provider !== 'gemini-agent-platform') return false;

  const geminiRefs = new Set([
    'ORCHESTRATOR_VERTEX_API_KEY',
    'orchestrator_vertex_api_key_ref',
  ]);
  return geminiRefs.has(vaultKey) && apiKeyRef !== undefined && geminiRefs.has(apiKeyRef);
}

export async function getAgentsUsingVaultKey(vaultKey: string): Promise<CredentialUsage> {
  const agents = await window.lionclaw.agents.list();
  const agentsReferencing = agents
    .filter((a) => {
      if (matchesVaultKey(vaultKey, a.externalConfig?.apiKeyRef, a.externalConfig?.provider)) return true;
      if (vaultKey === 'ORCHESTRATOR_MINIMAX_API_KEY' && a.runtime === 'minimax-tp') return true;
      if (vaultKey === 'ORCHESTRATOR_ZAI_API_KEY' && a.runtime === 'zai') return true;
      return false;
    })
    .map((a) => ({
      id: a.id,
      name: a.name,
      runtime: a.runtime,
      provider: a.externalConfig?.provider,
    }));
  return { agentsReferencing };
}
