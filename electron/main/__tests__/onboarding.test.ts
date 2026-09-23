import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamChunk } from '../../../src/types';

const mocks = vi.hoisted(() => ({
  saveUser: vi.fn(),
  saveSoul: vi.fn(),
  getSetting: vi.fn(),
  setSetting: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../prompt-builder', () => ({
  saveUser: mocks.saveUser,
  saveSoul: mocks.saveSoul,
}));

vi.mock('../db', () => ({
  getSetting: mocks.getSetting,
  setSetting: mocks.setSetting,
}));

vi.mock('../logger', () => ({
  createLogger: () => ({
    debug: mocks.debug,
    info: mocks.info,
    error: mocks.error,
  }),
}));

import {
  completeOnboardingFromConversationMessages,
  completeOnboardingFromUserProfileMessage,
  extractAndProcessOnboardingData,
} from '../onboarding';

const payload = JSON.stringify({
  user: {
    nome: 'Alex',
    profissao: 'Developer',
  },
  agent: {
    nome: 'LionClaw',
    personalidade: 'Direto e pragmatico',
  },
});

describe('extractAndProcessOnboardingData', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('processa o marcador HTML usado pelo Claude SDK', () => {
    const chunks: StreamChunk[] = [];
    const cleaned = extractAndProcessOnboardingData(
      `Pronto.\n\n<!-- ONBOARDING_DATA\n${payload}\nONBOARDING_DATA -->`,
      { sendStream: (chunk) => chunks.push(chunk) },
    );

    expect(cleaned).toBe('Pronto.');
    expect(mocks.setSetting).toHaveBeenCalledWith('onboarding_completed', 'true');
    expect(chunks.map((chunk) => chunk.type)).toEqual(['replace_content', 'onboarding_completed']);
  });

  it('processa JSON finalizado com marcador de fechamento sem abertura HTML', () => {
    const chunks: StreamChunk[] = [];
    const cleaned = extractAndProcessOnboardingData(`Pronto.\n\n${payload}\nONBOARDING_DATA -->`, {
      sendStream: (chunk) => chunks.push(chunk),
    });

    expect(cleaned).toBe('Pronto.');
    expect(mocks.setSetting).toHaveBeenCalledWith('onboarding_completed', 'true');
    expect(chunks).toContainEqual({ type: 'replace_content', content: 'Pronto.' });
    expect(chunks).toContainEqual({ type: 'onboarding_completed' });
  });

  it('conclui quando o usuario cola um USER.md completo e define identidade do agente', () => {
    const chunks: StreamChunk[] = [];
    const userMessage = `# Sobre o Usuario

## Dados basicos
- Nome: Alex
- Como prefere ser chamado: Lex

## Perfil profissional
- Empreendedor tech focado em produtos digitais, IA e e-commerce.

## Projetos ativos
- Agent Smith V6
- LionClaw
- LionLabs Comunidade

## Preferencias
- Idioma: portugues brasileiro
- Comunicacao: Direto, entregaveis prontos pra usar, sem rodeio.

## Stack tecnologico
- Supabase, Stripe, Shopify, Ollama local, ClickHouse e MCPs via stdio.

## Ferramentas
- n8n, Google Sheets, GitHub, Obsidian e Excalidraw.

seu nome Aria

seu estilo proativo`;

    const completed = completeOnboardingFromUserProfileMessage(userMessage, {
      sendStream: (chunk) => chunks.push(chunk),
    });

    expect(completed).toBe(true);
    expect(mocks.saveUser).toHaveBeenCalledWith(expect.stringContaining('# Sobre o Usuario'));
    expect(mocks.saveSoul).toHaveBeenCalledWith(expect.stringContaining('Aria'));
    expect(mocks.setSetting).toHaveBeenCalledWith('onboarding_completed', 'true');
    expect(chunks).toContainEqual({ type: 'onboarding_completed' });
  });

  it('nao conclui perfil completo sem nome customizado do agente', () => {
    const chunks: StreamChunk[] = [];
    const userMessage = `# Sobre o Usuario

## Dados basicos
- Nome: Alex
- Como prefere ser chamado: Lex
- Timezone: America/Sao_Paulo

## Perfil profissional
- Empreendedor tech focado em produtos digitais, IA, e-commerce e conteudo.

## Projetos ativos
- Agent Smith V6
- LionClaw
- LionLabs Comunidade

## Preferencias
- Idioma: portugues brasileiro
- Comunicacao: Direto, entregaveis prontos pra usar, sem rodeio.

## Stack tecnologico
- Supabase, Stripe, Shopify, Ollama local, ClickHouse e MCPs via stdio.

## Ferramentas
- n8n, Google Sheets, GitHub, Obsidian, Excalidraw e Google Workspace.`;

    const completed = completeOnboardingFromUserProfileMessage(userMessage, {
      sendStream: (chunk) => chunks.push(chunk),
    });

    expect(completed).toBe(false);
    expect(mocks.saveUser).not.toHaveBeenCalled();
    expect(mocks.saveSoul).not.toHaveBeenCalled();
    expect(mocks.setSetting).not.toHaveBeenCalled();
    expect(chunks).toEqual([]);
  });

  it('conclui quando o usuario informa nome e personalidade depois de colar o perfil completo', () => {
    const chunks: StreamChunk[] = [];
    const previousProfile = `# Sobre o Usuario

## Dados basicos
- Nome: Alex
- Como prefere ser chamado: Lex
- Timezone: America/Sao_Paulo

## Perfil profissional
- Empreendedor tech focado em produtos digitais, IA, e-commerce e conteudo.

## Projetos ativos
- Agent Smith V6
- LionClaw
- LionLabs Comunidade

## Preferencias
- Idioma: portugues brasileiro
- Comunicacao: Direto, entregaveis prontos pra usar, sem rodeio.

## Stack tecnologico
- Supabase, Stripe, Shopify, Ollama local, ClickHouse e MCPs via stdio.

## Ferramentas
- n8n, Google Sheets, GitHub, Obsidian, Excalidraw e Google Workspace.`;

    const completed = completeOnboardingFromConversationMessages(
      [
        { role: 'user', content: previousProfile },
        { role: 'assistant', content: 'Agora preciso saber quem EU vou ser.' },
        { role: 'user', content: 'Aria' },
        { role: 'assistant', content: 'Agora me fala sobre personalidade.' },
        { role: 'user', content: 'Tecnico e amigavel' },
      ],
      'Tecnico e amigavel',
      { sendStream: (chunk) => chunks.push(chunk) },
    );

    expect(completed).toBe(true);
    expect(mocks.saveUser).toHaveBeenCalledWith(expect.stringContaining('# Sobre o Usuario'));
    expect(mocks.saveSoul).toHaveBeenCalledWith(expect.stringContaining('Aria'));
    expect(mocks.saveSoul).toHaveBeenCalledWith(expect.stringContaining('Tecnico e amigavel'));
    expect(mocks.setSetting).toHaveBeenCalledWith('onboarding_completed', 'true');
    expect(chunks).toContainEqual({ type: 'onboarding_completed' });
  });

  it('nao conclui conversa so com nome do agente sem personalidade', () => {
    const chunks: StreamChunk[] = [];
    const previousProfile = `# Sobre o Usuario

## Dados basicos
- Nome: Alex
- Como prefere ser chamado: Lex
- Timezone: America/Sao_Paulo

## Perfil profissional
- Empreendedor tech focado em produtos digitais, IA, e-commerce e conteudo.

## Projetos ativos
- Agent Smith V6
- LionClaw
- LionLabs Comunidade

## Preferencias
- Idioma: portugues brasileiro
- Comunicacao: Direto, entregaveis prontos pra usar, sem rodeio.

## Stack tecnologico
- Supabase, Stripe, Shopify, Ollama local, ClickHouse e MCPs via stdio.

## Ferramentas
- n8n, Google Sheets, GitHub, Obsidian, Excalidraw e Google Workspace.`;

    const completed = completeOnboardingFromConversationMessages(
      [
        { role: 'user', content: previousProfile },
        { role: 'assistant', content: 'Agora preciso saber quem EU vou ser.' },
        { role: 'user', content: 'Aria' },
      ],
      'Aria',
      { sendStream: (chunk) => chunks.push(chunk) },
    );

    expect(completed).toBe(false);
    expect(mocks.setSetting).not.toHaveBeenCalled();
    expect(chunks).toEqual([]);
  });

  it('nao conclui fallback com mensagem curta de onboarding', () => {
    const chunks: StreamChunk[] = [];
    const completed = completeOnboardingFromUserProfileMessage('Oi, meu nome e Alex e seu nome Aria', {
      sendStream: (chunk) => chunks.push(chunk),
    });

    expect(completed).toBe(false);
    expect(mocks.setSetting).not.toHaveBeenCalled();
    expect(chunks).toEqual([]);
  });
});

describe('generateUserMd canonico (SPEC telegram-cron-compaction 12.5 / AC-56)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('onboarding fresh gera o skeleton canonico de 6 secoes na ordem', () => {
    const fullPayload = JSON.stringify({
      user: {
        nome: 'Alex',
        apelido: 'Le',
        profissao: 'Developer',
        areaAtuacao: 'Backend',
        stackPrincipal: ['TypeScript', 'Node'],
        projetosAtivos: ['LionClaw'],
        preferenciasComunicacao: 'direto',
        horarioTrabalho: '9-18',
        notasAdicionais: 'Gosta de xadrez',
      },
      agent: { nome: 'Aria', personalidade: 'Direta' },
    });

    const chunks: StreamChunk[] = [];
    extractAndProcessOnboardingData(`Pronto.\n\n<!-- ONBOARDING_DATA\n${fullPayload}\nONBOARDING_DATA -->`, {
      sendStream: (chunk) => chunks.push(chunk),
    });

    expect(mocks.saveUser).toHaveBeenCalledTimes(1);
    const userMd = mocks.saveUser.mock.calls[0][0] as string;

    const headers = [
      '## Identidade',
      '## Perfil profissional',
      '## Negocios e projetos',
      '## Stack e ferramentas',
      '## Preferencias',
      '## Fatos duraveis',
    ];
    let last = -1;
    for (const h of headers) {
      const idx = userMd.indexOf(h);
      expect(idx).toBeGreaterThan(last);
      last = idx;
    }
    expect(userMd).not.toContain('## Dados basicos');
    expect(userMd).not.toContain('## Notas pessoais');
    expect(userMd).not.toContain('## Projetos ativos');
    expect(userMd).not.toContain('## Preferencias de trabalho');

    const section = (name: string, next: string | null) =>
      userMd.slice(userMd.indexOf(name), next ? userMd.indexOf(next) : undefined);
    expect(section('## Identidade', '## Perfil profissional')).toContain('- Nome: Alex');
    expect(section('## Negocios e projetos', '## Stack e ferramentas')).toContain('- LionClaw');
    expect(section('## Stack e ferramentas', '## Preferencias')).toContain('- Stack: TypeScript, Node');
    expect(section('## Fatos duraveis', null)).toContain('- Gosta de xadrez');
  });

  it('campos opcionais ausentes: os 6 headers continuam presentes (secoes vazias)', () => {
    const chunks: StreamChunk[] = [];
    extractAndProcessOnboardingData(`Pronto.\n\n<!-- ONBOARDING_DATA\n${payload}\nONBOARDING_DATA -->`, {
      sendStream: (chunk) => chunks.push(chunk),
    });

    const userMd = mocks.saveUser.mock.calls[0][0] as string;
    for (const h of [
      '## Identidade',
      '## Perfil profissional',
      '## Negocios e projetos',
      '## Stack e ferramentas',
      '## Preferencias',
      '## Fatos duraveis',
    ]) {
      expect(userMd).toContain(h);
    }
  });
});
