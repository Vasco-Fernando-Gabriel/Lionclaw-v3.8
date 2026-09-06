
import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  settings: {} as Record<string, string | undefined>,
  logWarn: vi.fn(),
  logError: vi.fn(),
  logInfo: vi.fn(),
}));

vi.mock('../db', () => ({
  getSetting: (key: string) => h.settings[key],
}));

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: h.logInfo,
    warn: h.logWarn,
    error: h.logError,
    debug: vi.fn(),
    trace: vi.fn(),
  }),
}));

import {
  buildBudgetedMessageText,
  legacyCompactionAssembly,
  resolveCompactionInputBudget,
  summarizePlainBlock,
} from '../memory-pipeline/budgeted-input';
import type { PlainPromptInvoker } from '../memory-pipeline/budgeted-input';
import { estimateTokens, excerptStartEnd } from '../token-estimator';

function makeFakeInvoker(respond: (prompt: string, call: number) => string | Promise<string>) {
  const prompts: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const invoker: PlainPromptInvoker = async (prompt) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      const call = prompts.length;
      prompts.push(prompt);
      return await respond(prompt, call);
    } finally {
      inFlight -= 1;
    }
  };
  return { invoker, prompts, maxConcurrency: () => maxInFlight };
}

function msg(role: string, content: string) {
  return { role, content };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.settings = {};
});


describe('excerptStartEnd', () => {
  it('texto que cabe volta byte-identico', () => {
    expect(excerptStartEnd('curto', 2000)).toBe('curto');
  });

  it('texto longo: inicio + marcador + FIM, total exato no orcamento', () => {
    const text = 'A'.repeat(3000) + 'MEIO' + 'Z'.repeat(3000);
    const out = excerptStartEnd(text, 2000);
    expect(out.length).toBe(2000);
    expect(out.startsWith('AAA')).toBe(true);
    expect(out.endsWith('ZZZ')).toBe(true);
    expect(out).toContain('[trecho central omitido:');
    expect(out).not.toContain('MEIO');
  });

  it('idempotente: re-aplicar com o mesmo cap nao mexe', () => {
    const text = 'A'.repeat(5000) + 'Z'.repeat(5000);
    const once = excerptStartEnd(text, 2000);
    expect(excerptStartEnd(once, 2000)).toBe(once);
  });
});


describe('caminho tudo-cabe (AC-34)', () => {
  it('formato fixado por fixture: [role] content unido por \\n\\n, byte-identico, zero maps', async () => {
    const { invoker, prompts } = makeFakeInvoker(() => 'nunca-chamado');
    const messages = [
      msg('user', 'primeira mensagem'),
      msg('assistant', 'primeira resposta'),
      msg('user', 'segunda pergunta'),
    ];
    const r = await buildBudgetedMessageText(messages, 48000, {
      kind: 'claude',
      invoker,
      clampBudgetTokens: 48000,
    });
    expect(r.messageText).toBe(
      '[user] primeira mensagem\n\n[assistant] primeira resposta\n\n[user] segunda pergunta',
    );
    expect(prompts).toHaveLength(0);
    expect(r.stats.verbatimCount).toBe(3);
    expect(r.stats.presummarizedCount).toBe(0);
    expect(r.stats.mapCalls).toBe(0);
    expect(r.stats.usedLegacyAssembly).toBe(false);
  });

  it('mensagem <= T_msg entra byte-identica mesmo sendo grande', async () => {
    const { invoker, prompts } = makeFakeInvoker(() => 'nunca');
    const big = 'x'.repeat(20000); // 5000 tok <= T_msg (6000) com budget 48k
    const r = await buildBudgetedMessageText([msg('user', big)], 48000, {
      kind: 'claude',
      invoker,
      clampBudgetTokens: 48000,
    });
    expect(r.messageText).toBe(`[user] ${big}`);
    expect(prompts).toHaveLength(0);
  });
});


describe('map de mensagem gigante (AC-35)', () => {
  it('mensagem de 120k chars vira UM bloco com marcador, <= T_msg, via map+reduce', async () => {
    const { invoker, prompts } = makeFakeInvoker((p) =>
      p.includes('RESUMOS PARCIAIS') ? 'REDUCE-FINAL' : 'RESUMO-JANELA',
    );
    const giant = 'g'.repeat(120000); // 30k tok > T_msg=6000; W=24000 tok=96k chars -> 2 janelas
    const r = await buildBudgetedMessageText(
      [msg('user', giant), msg('assistant', 'resposta curta')],
      48000,
      { kind: 'claude', invoker, clampBudgetTokens: 48000 },
    );
    expect(prompts).toHaveLength(3);
    expect(r.stats.mapCalls).toBe(3);
    const blocks = r.messageText.split('\n\n');
    const giantBlock = blocks.find((b) => b.includes('[resumo automatico de mensagem longa'));
    expect(giantBlock).toBeDefined();
    expect(giantBlock).toContain('120000 chars originais');
    expect(giantBlock).toContain('REDUCE-FINAL');
    expect(estimateTokens(giantBlock!)).toBeLessThanOrEqual(6000);
    expect(r.messageText).toContain('[assistant] resposta curta');
    expect(r.stats.presummarizedCount).toBe(1);
    expect(r.stats.verbatimCount).toBe(1);
  });

  it('W por kind (AC-37): lion-sdk (budget 12k) fatia janelas de 6k tokens — nenhum map acima do orcamento do ciclo', async () => {
    const { invoker, prompts } = makeFakeInvoker(() => 'R');
    const giant = 'y'.repeat(60000); // 15k tok; W lion = min(24000, 6000) = 6000 tok = 24k chars -> 3 janelas
    await buildBudgetedMessageText([msg('user', giant)], 12000, {
      kind: 'lion-sdk',
      invoker,
      clampBudgetTokens: 12000,
    });
    const mapPrompts = prompts.filter((p) => !p.includes('RESUMOS PARCIAIS'));
    expect(mapPrompts.length).toBe(3);
    for (const p of mapPrompts) {
      expect(estimateTokens(p)).toBeLessThanOrEqual(12000);
    }
  });

  it('warn de modelo local (11.6): input acima do limite configuravel loga warn', async () => {
    const { invoker } = makeFakeInvoker(() => 'R');
    const giant = 'y'.repeat(60000);
    await buildBudgetedMessageText([msg('user', giant)], 12000, {
      kind: 'lion-sdk',
      invoker,
      clampBudgetTokens: 12000,
      localInputWarnTokens: 100,
    });
    expect(
      h.logWarn.mock.calls.some((c) => String(c[1]).includes('compaction_local_input_warn_tokens')),
    ).toBe(true);
  });
});


describe('FOLD recency-preserving (AC-36)', () => {
  it('cauda recente verbatim, cabeca antiga resumida em ordem cronologica, maps sequenciais', async () => {
    const fake = makeFakeInvoker(async (p, call) => {
      await new Promise((r) => setTimeout(r, 5)); // janela p/ detectar paralelismo
      return p.includes('RESUMOS PARCIAIS') ? 'REDUCE-CABECA' : `RESUMO-SEG-${call}`;
    });
    const messages = Array.from({ length: 30 }, (_, i) =>
      msg(i % 2 === 0 ? 'user' : 'assistant', `MSG${String(i).padStart(2, '0')} ${'m'.repeat(1990)}`),
    );
    const r = await buildBudgetedMessageText(messages, 8000, {
      kind: 'claude',
      invoker: fake.invoker,
      clampBudgetTokens: 8000,
    });
    expect(r.messageText).toContain('MSG29');
    expect(r.messageText.endsWith(messages[29].content)).toBe(true);
    expect(r.messageText).not.toContain(`MSG00 ${'m'.repeat(1990)}`);
    const idxResumo = r.messageText.indexOf('resumo automatico');
    const idxTail = r.messageText.indexOf('MSG29');
    expect(idxResumo).toBeGreaterThanOrEqual(0);
    expect(idxResumo).toBeLessThan(idxTail);
    expect(estimateTokens(r.messageText)).toBeLessThanOrEqual(Math.floor(8000 * 1.05));
    expect(fake.maxConcurrency()).toBe(1);
    expect(r.stats.mapCalls).toBeLessThanOrEqual(12);
    expect(r.stats.verbatimCount).toBeGreaterThan(0);
    expect(r.stats.presummarizedCount).toBeGreaterThan(0);
  });

  it('delta pior-caso (~600k chars) conclui <= budget*1.05 com cauda verbatim', async () => {
    const fake = makeFakeInvoker((p) =>
      p.includes('RESUMOS PARCIAIS') ? 'REDUCE-X' : 'RES-SEG',
    );
    const messages = Array.from({ length: 60 }, (_, i) =>
      msg('user', `DOC${i} ${'d'.repeat(9990)}`),
    ); // ~600k chars
    const r = await buildBudgetedMessageText(messages, 40000, {
      kind: 'subscription',
      invoker: fake.invoker,
      clampBudgetTokens: 48000,
    });
    expect(estimateTokens(r.messageText)).toBeLessThanOrEqual(Math.floor(48000 * 1.05));
    expect(r.messageText).toContain('DOC59'); // recente preservado
    expect(r.stats.mapCalls).toBeLessThanOrEqual(12);
    expect(r.stats.usedLegacyAssembly).toBe(false);
  });
});


describe('caps e timeout (fallback nivel 2)', () => {
  it('cap de chamadas: segmentos restantes viram excerpt deterministico + logger.error', async () => {
    const { invoker, prompts } = makeFakeInvoker(() => 'RESUMO-OK');
    const g1 = 'a'.repeat(30000); // gigante 1 (7500 tok > T_msg 6000... com budget 48k)
    const g2 = 'b'.repeat(30000) + 'FIM-G2'; // gigante 2
    const r = await buildBudgetedMessageText(
      [msg('user', g1), msg('user', g2), msg('assistant', 'ok')],
      48000,
      { kind: 'claude', invoker, clampBudgetTokens: 48000, mapCallLimit: 1 },
    );
    expect(prompts).toHaveLength(1); // so o primeiro map rodou
    expect(r.stats.mapCalls).toBe(1);
    expect(r.messageText).toContain('RESUMO-OK');
    expect(r.messageText).toContain('[trecho central omitido:'); // g2 degradado
    expect(r.messageText).toContain('FIM-G2'); // excerpt preserva o FIM
    expect(r.stats.deterministicFallbacks).toBeGreaterThanOrEqual(1);
    expect(
      h.logError.mock.calls.some((c) => String(c[1]).includes('caps de map estourados')),
    ).toBe(true);
  });

  it('cap de tempo do ciclo: nenhuma chamada roda com time budget zerado', async () => {
    const { invoker, prompts } = makeFakeInvoker(() => 'X');
    const giant = 'c'.repeat(30000);
    const r = await buildBudgetedMessageText([msg('user', giant)], 48000, {
      kind: 'claude',
      invoker,
      clampBudgetTokens: 48000,
      mapTimeBudgetMs: 0,
    });
    expect(prompts).toHaveLength(0);
    expect(r.stats.mapCalls).toBe(0);
    expect(r.messageText).toContain('[trecho central omitido:');
  });

  it('timeout por chamada (Promise.race): bloco degrada, ciclo conclui', async () => {
    const { invoker } = makeFakeInvoker(
      () => new Promise<string>((resolve) => setTimeout(() => resolve('tarde-demais'), 200)),
    );
    const giant = 'd'.repeat(30000) + 'CAUDA-D';
    const r = await buildBudgetedMessageText(
      [msg('user', giant), msg('assistant', 'seguimos')],
      48000,
      { kind: 'claude', invoker, clampBudgetTokens: 48000, mapTimeoutMs: 10 },
    );
    expect(r.messageText).toContain('[trecho central omitido:');
    expect(r.messageText).toContain('CAUDA-D');
    expect(r.messageText).toContain('[assistant] seguimos');
    expect(r.stats.deterministicFallbacks).toBeGreaterThanOrEqual(1);
    expect(
      h.logWarn.mock.calls.some((c) => String(c[1]).includes('fallback nivel 1')),
    ).toBe(true);
  });
});


describe('escada de fallback (AC-38/AC-39)', () => {
  it('nivel 1: falha de UM map degrada so aquele bloco; os demais seguem', async () => {
    let first = true;
    const { invoker } = makeFakeInvoker(() => {
      if (first) {
        first = false;
        throw new Error('backend caiu');
      }
      return 'RESUMO-B';
    });
    const gA = 'a'.repeat(30000) + 'FIM-A';
    const gB = 'b'.repeat(30000);
    const r = await buildBudgetedMessageText(
      [msg('user', gA), msg('user', gB)],
      48000,
      { kind: 'claude', invoker, clampBudgetTokens: 48000 },
    );
    expect(r.messageText).toContain('[trecho central omitido:'); // A degradado
    expect(r.messageText).toContain('FIM-A');
    expect(r.messageText).toContain('RESUMO-B'); // B mapeado normal
    expect(r.stats.deterministicFallbacks).toBe(1);
  });

  it('nivel 1: resposta VAZIA de um map degrada o bloco (comportamento por sitio, 5.6)', async () => {
    const { invoker } = makeFakeInvoker(() => '   ');
    const giant = 'e'.repeat(30000);
    const r = await buildBudgetedMessageText([msg('user', giant)], 48000, {
      kind: 'claude',
      invoker,
      clampBudgetTokens: 48000,
    });
    expect(r.messageText).toContain('[trecho central omitido:');
    expect(r.stats.deterministicFallbacks).toBeGreaterThanOrEqual(1);
  });

  it('nivel 3: throw inesperado do builder cai no assembly legado (2000/50000) + logger.error', async () => {
    const { invoker } = makeFakeInvoker(() => 'x');
    const r = await buildBudgetedMessageText(
      [msg('user', null as unknown as string), msg('assistant', 'sobrevive')],
      48000,
      { kind: 'claude', invoker, clampBudgetTokens: 48000 },
    );
    expect(r.stats.usedLegacyAssembly).toBe(true);
    expect(r.messageText).toContain('[assistant] sobrevive');
    expect(r.messageText.length).toBeLessThanOrEqual(50000);
    expect(
      h.logError.mock.calls.some((c) => String(c[1]).includes('assembly legado')),
    ).toBe(true);
  });

  it('assembly legado: 2000 chars/mensagem + teto 50000 (rota de panico nomeada)', () => {
    const messages = Array.from({ length: 40 }, (_, i) => msg('user', `M${i} ` + 'z'.repeat(5000)));
    const out = legacyCompactionAssembly(messages);
    expect(out.length).toBeLessThanOrEqual(50000);
    const firstBlock = out.split('\n\n')[0];
    expect(firstBlock.length).toBeLessThanOrEqual('[user] '.length + 2000);
  });
});


describe('enforcement pos-hoc do output (kind subscription)', () => {
  it('output acima de 2x o alvo e reduzido ao excerpt do proprio output + warn', async () => {
    const bloated = 'INICIO-OUT ' + 'o'.repeat(30000) + ' FIM-OUT';
    const { invoker } = makeFakeInvoker(() => bloated);
    const giant = 'f'.repeat(30000);
    const r = await buildBudgetedMessageText([msg('user', giant)], 48000, {
      kind: 'subscription',
      invoker,
      clampBudgetTokens: 48000,
    });
    const giantBlock = r.messageText
      .split('\n\n')
      .find((b) => b.includes('[resumo automatico de mensagem longa'));
    expect(giantBlock).toBeDefined();
    expect(giantBlock).toContain('INICIO-OUT');
    expect(giantBlock).toContain('FIM-OUT');
    expect(giantBlock).toContain('[trecho central omitido:');
    expect(
      h.logWarn.mock.calls.some((c) => String(c[1]).includes('enforcement pos-hoc')),
    ).toBe(true);
  });

  it('kind claude NAO aplica enforcement pos-hoc (maxTokens ja e honrado pelo invoker)', async () => {
    const bloated = 'X'.repeat(30000);
    const { invoker } = makeFakeInvoker(() => bloated);
    const giant = 'f'.repeat(30000);
    const r = await buildBudgetedMessageText([msg('user', giant)], 48000, {
      kind: 'claude',
      invoker,
      clampBudgetTokens: 48000,
    });
    expect(r.messageText).toContain(bloated);
  });
});


describe('clamp final de seguranca', () => {
  it('messageText acima de budget*1.05 poda os blocos mais ANTIGOS com marcador + logger.error', async () => {
    const { invoker } = makeFakeInvoker(() => 'R'.repeat(24000)); // 6000 tok por resposta
    const messages = Array.from({ length: 12 }, (_, i) => msg('user', `T${i} ` + 't'.repeat(890)));
    const r = await buildBudgetedMessageText(messages, 2000, {
      kind: 'claude',
      invoker,
      clampBudgetTokens: 2000,
    });
    expect(estimateTokens(r.messageText)).toBeLessThanOrEqual(Math.floor(2000 * 1.05));
    expect(r.messageText).toContain('removidos pelo clamp de orcamento');
    expect(
      h.logError.mock.calls.some((c) => String(c[1]).includes('clamp final disparou')),
    ).toBe(true);
    expect(r.messageText).toContain('T11');
  });
});


describe('resolveCompactionInputBudget (11.2)', () => {
  it('defaults por kind: 48k subscription/claude, 12k lion-sdk', () => {
    expect(resolveCompactionInputBudget('subscription')).toBe(48000);
    expect(resolveCompactionInputBudget('claude')).toBe(48000);
    expect(resolveCompactionInputBudget('lion-sdk')).toBe(12000);
  });

  it('setting valido vence o default; invalido cai no default', () => {
    h.settings['compaction_input_budget_tokens'] = '32000';
    expect(resolveCompactionInputBudget('claude')).toBe(32000);
    h.settings['compaction_input_budget_tokens'] = 'abc';
    expect(resolveCompactionInputBudget('claude')).toBe(48000);
    h.settings['compaction_input_budget_tokens'] = '-5';
    expect(resolveCompactionInputBudget('lion-sdk')).toBe(12000);
  });
});


describe('summarizePlainBlock', () => {
  it('prompt e EXTRATIVO (preserva fatos/paths/comandos; proibido opinar) e PT-BR', async () => {
    const { invoker, prompts } = makeFakeInvoker(() => 'RES');
    const out = await summarizePlainBlock({
      invoker,
      kind: 'claude',
      text: 'conteudo original',
      targetTokens: 1500,
    });
    expect(out).toBe('RES');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('EXTRATIVO');
    expect(prompts[0]).toContain('PROIBIDO opinar');
    expect(prompts[0]).toContain('PT-BR');
    expect(prompts[0]).toContain('conteudo original');
  });

  it('resposta vazia lanca (o fallback e decisao do caller)', async () => {
    const { invoker } = makeFakeInvoker(() => '');
    await expect(
      summarizePlainBlock({ invoker, kind: 'claude', text: 'abc', targetTokens: 100 }),
    ).rejects.toThrow('resposta vazia');
  });
});
