
export const KIMI_AGENT_DETAILS_TOOL_NAME = 'mcp__lionclaw-agents__agent_details';

export function appendAgentDetailsSteering(
  prompt: string,
  materializedToolNames: ReadonlySet<string>,
): string {
  if (!materializedToolNames.has(KIMI_AGENT_DETAILS_TOOL_NAME)) return prompt;
  return `${prompt}\n\nFicha completa de um subagente do indice: chame ${KIMI_AGENT_DETAILS_TOOL_NAME} com { agent_id } quando o resumo de 1 linha nao bastar para decidir a delegacao.`;
}
