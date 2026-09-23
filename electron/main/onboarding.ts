import { saveUser, saveSoul } from './prompt-builder';
import { createLogger } from './logger';
import { getSetting, setSetting } from './db';
import { getLionClawHome } from './paths';
import type { StreamChunk } from '../../src/types';
import fs from 'fs';
import path from 'path';

const logger = createLogger('onboarding');

interface OnboardingData {
  user: {
    nome: string;
    apelido?: string;
    profissao: string;
    areaAtuacao?: string;
    stackPrincipal?: string[];
    projetosAtivos?: string[];
    preferenciasComunicacao?: string;
    horarioTrabalho?: string;
    notasAdicionais?: string;
  };
  agent: {
    nome: string;
    personalidade: string;
    tomDeVoz?: string;
    proatividade?: 'alta' | 'media' | 'baixa';
    limitesCustom?: string[];
  };
}

const ONBOARDING_MARKER_REGEX = /<!--\s*ONBOARDING_DATA\s*([\s\S]*?)\s*ONBOARDING_DATA\s*-->/;
const ONBOARDING_LOOSE_MARKER_REGEX = /(?:<!--\s*)?ONBOARDING_DATA\s*([\s\S]*?)\s*ONBOARDING_DATA\s*-->/;
const ONBOARDING_CLOSING_MARKER_REGEX = /ONBOARDING_DATA\s*-->/;

interface OnboardingMarkerBlock {
  json: string;
  start: number;
  end: number;
}

interface UserProfileMessage {
  userMd: string;
  agent: OnboardingData['agent'];
}

interface OnboardingChatMessage {
  role: string;
  content: string;
}

interface OnboardingCallbacks {
  sendStream: (chunk: StreamChunk) => void;
  onAudit?: (data: { toolName: string; input: string; output: string }) => void;
}

function findOnboardingMarkerBlock(assistantContent: string): OnboardingMarkerBlock | null {
  const exactMatch = assistantContent.match(ONBOARDING_MARKER_REGEX);
  if (exactMatch && exactMatch.index !== undefined) {
    return {
      json: exactMatch[1],
      start: exactMatch.index,
      end: exactMatch.index + exactMatch[0].length,
    };
  }

  const looseMatch = assistantContent.match(ONBOARDING_LOOSE_MARKER_REGEX);
  if (looseMatch && looseMatch.index !== undefined) {
    return {
      json: looseMatch[1],
      start: looseMatch.index,
      end: looseMatch.index + looseMatch[0].length,
    };
  }

  const closingMatch = assistantContent.match(ONBOARDING_CLOSING_MARKER_REGEX);
  if (!closingMatch || closingMatch.index === undefined) return null;

  const beforeClosingMarker = assistantContent.slice(0, closingMatch.index);
  const jsonStart = beforeClosingMarker.indexOf('{');
  if (jsonStart === -1) return null;

  return {
    json: beforeClosingMarker.slice(jsonStart).trim(),
    start: jsonStart,
    end: closingMatch.index + closingMatch[0].length,
  };
}

function extractFirstLineAfterLabel(content: string, label: string): string | null {
  const match = content.match(new RegExp(`^\\s*${label}\\s*:?\\s*(.+)$`, 'im'));
  const value = match?.[1]?.trim();
  if (!value) return null;
  return value.replace(/[.!?]+$/, '').trim();
}

function extractUserMdFromProfileMessage(message: string): {
  userMd: string;
  agentInstruction: string;
} | null {
  const profileStart = message.indexOf('# Sobre o Usuario');
  if (profileStart === -1) return null;

  const fromProfile = message.slice(profileStart).trim();
  const agentInstructionMatch = fromProfile.match(/\n\s*seu nome\b/i);
  const userMd = (agentInstructionMatch ? fromProfile.slice(0, agentInstructionMatch.index) : fromProfile).trim();

  if (userMd.length < 400) return null;
  if (!userMd.includes('## Dados basicos')) return null;
  if (!userMd.includes('## Perfil profissional')) return null;
  if (!/^- Nome:\s*\S+/im.test(userMd)) return null;

  const agentInstruction = agentInstructionMatch ? fromProfile.slice(agentInstructionMatch.index).trim() : '';
  return { userMd, agentInstruction };
}

function buildAgentProfile(agentName: string, style = 'proativo'): OnboardingData['agent'] {
  return {
    nome: agentName,
    personalidade: `Assistente pessoal ${style}, direto, tecnico quando necessario e critico com fundamento.`,
    tomDeVoz: 'Portugues brasileiro informal, direto e sem rodeio.',
    proatividade: style.toLowerCase().includes('reativo') ? 'media' : 'alta',
  };
}

function extractAgentNameFromInstruction(content: string): string | null {
  return extractFirstLineAfterLabel(content, 'seu nome');
}

function extractAgentNameFromShortMessage(message: string): string | null {
  const text = message.trim();
  if (!text || text.length > 80 || text.split(/\r?\n/).length > 2) return null;
  if (/^(sim|ok|okay|beleza|fechado|isso|perfeito|esta bom|está bom|ta bom|tá bom)$/i.test(text)) {
    return null;
  }

  const explicit = text.match(
    /(?:seu nome(?:\s+(?:vai ser|sera|será|e|é))?|voce vai ser|você vai ser|te chamar(?:\s+de)?|chamar(?:\s+de)?)\s+(?:a|o)?\s*([\p{L}\d][\p{L}\d ._-]{1,40})/iu,
  );
  const rawName = explicit?.[1]?.trim() ?? text;
  if (!/^[\p{L}\d][\p{L}\d ._-]{1,40}$/u.test(rawName)) return null;

  return rawName.replace(/[.!?]+$/, '').trim();
}

function normalizePersonalityMessage(message: string): string | null {
  const text = message.trim();
  if (!text || text.length > 180 || text.split(/\r?\n/).length > 3) return null;
  if (/^(sim|ok|okay|beleza|fechado|isso|perfeito|esta bom|está bom|ta bom|tá bom)$/i.test(text)) {
    return null;
  }

  const lower = text.toLowerCase();
  const personalityKeywords = [
    'tecnico',
    'técnico',
    'amigavel',
    'amigável',
    'direto',
    'proativo',
    'reativo',
    'sarcastico',
    'sarcástico',
    'critico',
    'crítico',
    'parceiro',
    'formal',
    'informal',
    'detalhado',
  ];
  if (!personalityKeywords.some((word) => lower.includes(word))) return null;
  return text.replace(/[.!?]+$/, '').trim();
}

function extractUserProfileMessage(message: string): UserProfileMessage | null {
  const profile = extractUserMdFromProfileMessage(message);
  if (!profile) return null;

  const agentName = extractAgentNameFromInstruction(profile.agentInstruction);
  if (!agentName) return null;

  const style = extractFirstLineAfterLabel(profile.agentInstruction, 'seu estilo') ?? 'proativo';
  return {
    userMd: profile.userMd,
    agent: buildAgentProfile(agentName, style),
  };
}

export function extractAndProcessOnboardingData(
  assistantContent: string,
  callbacks: OnboardingCallbacks,
): string | null {
  if (!assistantContent.includes('ONBOARDING_DATA')) return null;

  const block = findOnboardingMarkerBlock(assistantContent);
  if (!block) return null;

  try {
    const onboardingData = JSON.parse(block.json);
    processOnboardingData(onboardingData);
    setSetting('onboarding_completed', 'true');

    const cleanedContent = `${assistantContent.slice(0, block.start)}${assistantContent.slice(block.end)}`.trim();
    callbacks.sendStream({ type: 'replace_content', content: cleanedContent });
    callbacks.sendStream({ type: 'onboarding_completed' });

    callbacks.onAudit?.({
      toolName: 'system:onboarding',
      input: JSON.stringify(onboardingData),
      output: 'Onboarding data processed',
    });

    logger.info('Onboarding completed via marker');
    return cleanedContent;
  } catch (e) {
    logger.error({ error: e }, 'Failed to process onboarding data');
    return null;
  }
}

export function hasPersistedOnboardingProfile(): boolean {
  try {
    const userPath = path.join(getLionClawHome(), 'USER.md');
    if (!fs.existsSync(userPath)) return false;

    const userMd = fs.readFileSync(userPath, 'utf-8').trim();
    if (userMd.length < 80) return false;

    const normalized = userMd.toLowerCase();
    if (normalized.includes('nenhuma informacao coletada')) return false;
    if (normalized.includes('execute o onboarding')) return false;

    return true;
  } catch (e) {
    logger.debug({ error: e }, 'Failed to inspect persisted onboarding profile');
    return false;
  }
}

export function resolveOnboardingCompletedFromState(): boolean {
  if (getSetting('onboarding_completed') === 'true') return true;
  if (!hasPersistedOnboardingProfile()) return false;

  setSetting('onboarding_completed', 'true');
  logger.info('Onboarding completed from persisted profile');
  return true;
}

export function completeOnboardingFromPersistedProfile(callbacks: OnboardingCallbacks): boolean {
  if (!hasPersistedOnboardingProfile()) return false;

  setSetting('onboarding_completed', 'true');
  callbacks.sendStream({ type: 'onboarding_completed' });
  callbacks.onAudit?.({
    toolName: 'system:onboarding',
    input: 'persisted-profile',
    output: 'Onboarding completed from existing USER.md',
  });
  logger.info('Onboarding completed from existing USER.md');
  return true;
}

export function completeOnboardingFromUserProfileMessage(userMessage: string, callbacks: OnboardingCallbacks): boolean {
  const profile = extractUserProfileMessage(userMessage);
  if (!profile) return false;

  saveUser(profile.userMd);
  saveSoul(generateSoulMd(profile.agent));
  setSetting('onboarding_completed', 'true');
  callbacks.sendStream({ type: 'onboarding_completed' });
  callbacks.onAudit?.({
    toolName: 'system:onboarding',
    input: 'user-profile-message',
    output: 'Onboarding completed from pasted USER.md profile',
  });
  logger.info('Onboarding completed from pasted user profile');
  return true;
}

export function completeOnboardingFromConversationMessages(
  messages: OnboardingChatMessage[],
  currentUserMessage: string,
  callbacks: OnboardingCallbacks,
): boolean {
  const allMessages = messages.some((msg) => msg.role === 'user' && msg.content === currentUserMessage)
    ? messages
    : [...messages, { role: 'user', content: currentUserMessage }];
  const userMessages = allMessages.filter((msg) => msg.role === 'user');
  const profileIndex = userMessages.findIndex((msg) => extractUserMdFromProfileMessage(msg.content));
  if (profileIndex === -1) return false;

  const profile = extractUserMdFromProfileMessage(userMessages[profileIndex].content);
  if (!profile) return false;

  const afterProfile = userMessages.slice(profileIndex + 1);
  const agentName = [...afterProfile]
    .reverse()
    .map((msg) => (normalizePersonalityMessage(msg.content) ? null : extractAgentNameFromShortMessage(msg.content)))
    .find((name): name is string => Boolean(name));
  if (!agentName) return false;

  const style = [...afterProfile]
    .reverse()
    .map((msg) => normalizePersonalityMessage(msg.content))
    .find((value): value is string => Boolean(value));
  if (!style) return false;

  saveUser(profile.userMd);
  saveSoul(generateSoulMd(buildAgentProfile(agentName, style)));
  setSetting('onboarding_completed', 'true');
  callbacks.sendStream({ type: 'onboarding_completed' });
  callbacks.onAudit?.({
    toolName: 'system:onboarding',
    input: 'conversation-profile-agent-name',
    output: `Onboarding completed from previous USER.md profile and agent name ${agentName}`,
  });
  logger.info({ agentName }, 'Onboarding completed from previous profile and agent name');
  return true;
}

export function processOnboardingData(data: OnboardingData): void {
  const userMd = generateUserMd(data.user);
  saveUser(userMd);
  logger.info('USER.md atualizado via onboarding');

  const soulMd = generateSoulMd(data.agent);
  saveSoul(soulMd);
  logger.info('SOUL.md atualizado via onboarding');
}

function generateUserMd(user: OnboardingData['user']): string {
  const lines: string[] = [];
  lines.push('# Sobre o Usuario');
  lines.push('');
  lines.push('## Identidade');
  lines.push(`- Nome: ${user.nome}`);
  if (user.apelido) lines.push(`- Como prefere ser chamado: ${user.apelido}`);
  lines.push(`- Timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`);
  lines.push(`- OS: ${process.platform}`);
  lines.push('');
  lines.push('## Perfil profissional');
  lines.push(`- ${user.profissao}`);
  if (user.areaAtuacao) lines.push(`- Area: ${user.areaAtuacao}`);
  lines.push('');
  lines.push('## Negocios e projetos');
  if (user.projetosAtivos && user.projetosAtivos.length > 0) {
    for (const projeto of user.projetosAtivos) {
      lines.push(`- ${projeto}`);
    }
  }
  lines.push('');
  lines.push('## Stack e ferramentas');
  if (user.stackPrincipal && user.stackPrincipal.length > 0) {
    lines.push(`- Stack: ${user.stackPrincipal.join(', ')}`);
  }
  lines.push('');
  lines.push('## Preferencias');
  lines.push(`- Idioma: portugues brasileiro`);
  if (user.preferenciasComunicacao) {
    lines.push(`- Comunicacao: ${user.preferenciasComunicacao}`);
  }
  if (user.horarioTrabalho) {
    lines.push(`- Horario: ${user.horarioTrabalho}`);
  }
  lines.push('');
  lines.push('## Fatos duraveis');
  if (user.notasAdicionais) {
    lines.push(`- ${user.notasAdicionais}`);
  }
  lines.push('');
  return lines.join('\n');
}

function generateSoulMd(agent: OnboardingData['agent']): string {
  const lines: string[] = [];
  lines.push(`# ${agent.nome} - Soul`);
  lines.push('');
  lines.push('## Identidade');
  lines.push(`Voce e ${agent.nome}, um assistente pessoal de IA que roda como app desktop.`);
  lines.push('Voce e leal ao seu usuario, dedicado e eficiente.');
  lines.push('Voce nao e um chatbot generico - voce e O assistente pessoal dedicado do usuario.');
  lines.push('');
  lines.push('## Personalidade');
  lines.push(`${agent.personalidade}`);
  lines.push('');
  lines.push('## Tom de Voz');
  if (agent.tomDeVoz) {
    lines.push(`${agent.tomDeVoz}`);
  } else {
    lines.push('- Portugues brasileiro, informal');
    lines.push('- Como um colega de trabalho senior e confiavel');
    lines.push('- Sem formalidades desnecessarias');
  }
  lines.push('- Nunca use travessoes no meio de frases');
  lines.push('');
  lines.push('## Proatividade');
  const proatividadeMap: Record<string, string> = {
    alta: 'Seja muito proativo: antecipe necessidades, sugira melhorias, avise sobre problemas antes de serem perguntados.',
    media: 'Equilibre proatividade com reatividade: sugira quando relevante mas nao sobrecarregue.',
    baixa: 'Seja majoritariamente reativo: faca o que for pedido, sugira apenas quando essencial.',
  };
  lines.push(proatividadeMap[agent.proatividade || 'media']);
  lines.push('');
  lines.push('## Valores');
  lines.push('- Privacidade do usuario acima de tudo');
  lines.push('- Execucao > explicacao (faca, nao apenas diga como fazer)');
  lines.push('- Transparencia sobre limitacoes');
  lines.push('- Melhoria continua (aprenda com cada interacao)');
  lines.push('');
  lines.push('## Limites');
  lines.push('- Voce opera APENAS no computador do usuario, nunca em servidores remotos sem permissao');
  lines.push('- Voce NUNCA toma decisoes irreversiveis sem confirmacao');
  lines.push('- Voce NUNCA compartilha dados do usuario com terceiros');
  lines.push('- Voce SEMPRE informa quando nao tem certeza sobre algo');
  if (agent.limitesCustom && agent.limitesCustom.length > 0) {
    for (const limite of agent.limitesCustom) {
      lines.push(`- ${limite}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}
