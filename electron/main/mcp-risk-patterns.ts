export const DESTRUCTIVE_MCP_PATTERNS: readonly RegExp[] = [
  /^.*-delete$/i, // notion-delete, gmail-delete etc (sufixo -delete)
  /^.*-trash$/i, // mover para lixeira
  /^.*-send-email$/i, // enviar email
  /^.*-send-message$/i, // enviar mensagem
  /^.*-publish$/i, // publicar conteudo
  /^send_email$/i, // gmail send_email
  /^reply_to$/i, // gmail reply_to
  /^forward$/i, // gmail forward
  /^delete_event$/i, // calendar delete_event
  /^delete_file$/i, // drive delete_file
  /^trash_message$/i, // gmail trash_message
  /^share_file$/i, // drive share_file
];

export const MEDIUM_RISK_MCP_PATTERNS: readonly RegExp[] = [
  /^.*-move$/i, // mover paginas/arquivos
  /^.*-archive$/i, // arquivar
];

export function assessMcpToolRisk(actualToolName: string): 'destructive' | 'medium' | 'safe' {
  for (const pattern of DESTRUCTIVE_MCP_PATTERNS) {
    if (pattern.test(actualToolName)) return 'destructive';
  }
  for (const pattern of MEDIUM_RISK_MCP_PATTERNS) {
    if (pattern.test(actualToolName)) return 'medium';
  }
  return 'safe';
}

export const DIRECT_MCP_HELPERS: readonly string[] = [
  'lionclaw-user-question',
  'local-agents',
  'codex-agents',
  'lionclaw-pipeline-control',
  'lionclaw-dynamic-workflows',
  'lionclaw-swarm',
  'repo-graph',
  'lionclaw-agents',
  'lionclaw-skills',
  'lionclaw-preview',
  'lionclaw-telegram',
  'lionclaw-toolscript',
];

const DIRECT_MCP_HELPER_SET: ReadonlySet<string> = new Set(DIRECT_MCP_HELPERS.map((id) => id.toLowerCase()));

export const TOOL_SCRIPT_HELPER_ID = 'lionclaw-toolscript';

export const CHAT_TURN_SCOPED_MCP_HELPERS: ReadonlySet<string> = new Set([TOOL_SCRIPT_HELPER_ID]);

export function isChatTurnScopedMcpHelper(serverIdOrName: string): boolean {
  return CHAT_TURN_SCOPED_MCP_HELPERS.has(serverIdOrName.toLowerCase());
}

export const PROMPT_CATALOG_MCP_HELPERS: ReadonlySet<string> = new Set([TOOL_SCRIPT_HELPER_ID]);

export function isDirectMcpHelper(serverIdOrName: string): boolean {
  return DIRECT_MCP_HELPER_SET.has(serverIdOrName.toLowerCase());
}
