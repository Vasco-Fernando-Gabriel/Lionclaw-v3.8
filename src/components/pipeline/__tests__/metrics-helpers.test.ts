
import { describe, it, expect } from 'vitest';
import {
  formatCostWithMeta,
  formatPipelineTotalCost,
  formatRuntimeCost,
  formatTokensWithMeta,
  resolveProviderForDisplay,
} from '../PipelineMetricsReport';


describe('formatCostWithMeta', () => {

  it('costStatus "known": exibe $0.00 para zero', () => {
    const result = formatCostWithMeta(0, { costStatus: 'known' });
    expect(result).toBe('$0.00');
  });

  it('costStatus "known": exibe valor com 3 casas decimais para custo >= 0.01', () => {
    const result = formatCostWithMeta(0.0123, { costStatus: 'known' });
    expect(result).toBe('$0.012');
  });

  it('costStatus "known": exibe valor com 3 casas decimais para custo > 1', () => {
    const result = formatCostWithMeta(1.2345, { costStatus: 'known' });
    expect(result).toBe('$1.234');
  });

  it('costStatus "known": $0.00 com custo zero e total cache hit', () => {
    const result = formatCostWithMeta(0, { costStatus: 'known' });
    expect(result).toBe('$0.00');
  });


  it('costStatus "unknown": exibe "Custo nao estimado" independente do valor', () => {
    const result = formatCostWithMeta(0.5, { costStatus: 'unknown' });
    expect(result).toBe('Custo nao estimado');
  });

  it('costStatus "unknown": exibe "Custo nao estimado" quando custo e zero', () => {
    const result = formatCostWithMeta(0, { costStatus: 'unknown' });
    expect(result).toBe('Custo nao estimado');
  });

  it('costStatus "unknown": exibe "Custo nao estimado" para custo grande', () => {
    const result = formatCostWithMeta(999.99, { costStatus: 'unknown' });
    expect(result).toBe('Custo nao estimado');
  });


  it('metadata undefined: trata como "known", exibe custo normalmente', () => {
    const result = formatCostWithMeta(0.05);
    expect(result).toBe('$0.050');
  });

  it('metadata vazio {}: trata como "known"', () => {
    const result = formatCostWithMeta(0.05, {});
    expect(result).toBe('$0.050');
  });

  it('metadata sem costStatus: trata como "known"', () => {
    const result = formatCostWithMeta(0.1, { provider: 'kimi', tokenStatus: 'reported' });
    expect(result).toBe('$0.100');
  });


  it('valor < 0.001: exibe "<$0.001"', () => {
    const result = formatCostWithMeta(0.0005, { costStatus: 'known' });
    expect(result).toBe('<$0.001');
  });

  it('valor entre 0.001 e 0.01: exibe 4 casas decimais', () => {
    const result = formatCostWithMeta(0.005, { costStatus: 'known' });
    expect(result).toBe('$0.0050');
  });
});

describe('formatPipelineTotalCost', () => {
  it('rotula total 100% assinatura com ~', () => {
    expect(formatPipelineTotalCost(0.25, 0.25, { costStatus: 'known' }))
      .toBe('~$0.250');
  });

  it('preserva total misto e destaca somente a parcela equivalente', () => {
    expect(formatPipelineTotalCost(0.6, 0.2, { costStatus: 'known' }))
      .toBe('$0.600 (incl. ~$0.200)');
  });

  it('preserva custo conhecido e sinaliza a parcela desconhecida', () => {
    expect(formatPipelineTotalCost(0.6, 0.2, { costStatus: 'unknown' }))
      .toBe('$0.600 (incl. ~$0.200) + nao estim.');
    expect(formatPipelineTotalCost(0, 0, { costStatus: 'unknown' }))
      .toBe('Custo nao estimado');
  });
});

describe('formatRuntimeCost', () => {
  it('nao converte Grok unknown sem custo conhecido em ~$0', () => {
    const value = formatRuntimeCost('grok', 0, 'unknown');
    expect(value).toBe('Custo nao estimado');
    expect(value).not.toContain('$0');
  });

  it('mantem Grok conhecido marcado como equivalente PAYG', () => {
    expect(formatRuntimeCost('grok', 0.25, 'known')).toBe('~$0.250');
  });

  it('preserva limite inferior conhecido e sinaliza restante desconhecido', () => {
    expect(formatRuntimeCost('grok', 0.25, 'unknown'))
      .toBe('~$0.250 + nao estim.');
    expect(formatRuntimeCost('cloud', 0.25, 'unknown'))
      .toBe('$0.250 + nao estim.');
  });
});


describe('formatTokensWithMeta', () => {

  it('tokenStatus "reported": exibe tokens formatados', () => {
    const result = formatTokensWithMeta(500, 300, { tokenStatus: 'reported' });
    expect(result).toBe('800');
  });

  it('tokenStatus "reported": soma input + output', () => {
    const result = formatTokensWithMeta(1000, 2000, { tokenStatus: 'reported' });
    expect(result).toBe('3.0K');
  });

  it('tokenStatus "reported": exibe em M para valores grandes', () => {
    const result = formatTokensWithMeta(500_000, 600_000, { tokenStatus: 'reported' });
    expect(result).toBe('1.10M');
  });

  it('tokenStatus "reported": exibe em K para milhares', () => {
    const result = formatTokensWithMeta(10_000, 5_000, { tokenStatus: 'reported' });
    expect(result).toBe('15.0K');
  });


  it('tokenStatus "not_reported": exibe "tokens nao reportados"', () => {
    const result = formatTokensWithMeta(0, 0, { tokenStatus: 'not_reported' });
    expect(result).toBe('tokens nao reportados');
  });

  it('tokenStatus "not_reported": ignora tokens passados, exibe mensagem', () => {
    const result = formatTokensWithMeta(1000, 2000, { tokenStatus: 'not_reported' });
    expect(result).toBe('tokens nao reportados');
  });


  it('metadata undefined: trata como "reported"', () => {
    const result = formatTokensWithMeta(100, 200);
    expect(result).toBe('300');
  });

  it('metadata vazio: trata como "reported"', () => {
    const result = formatTokensWithMeta(100, 200, {});
    expect(result).toBe('300');
  });

  it('metadata sem tokenStatus: trata como "reported"', () => {
    const result = formatTokensWithMeta(100, 200, { costStatus: 'known' });
    expect(result).toBe('300');
  });


  it('zero tokens com "reported": exibe "0"', () => {
    const result = formatTokensWithMeta(0, 0, { tokenStatus: 'reported' });
    expect(result).toBe('0');
  });
});


describe('resolveProviderForDisplay', () => {

  it('retorna metadata.provider quando disponivel', () => {
    const result = resolveProviderForDisplay({ provider: 'kimi' }, 'external');
    expect(result).toBe('kimi');
  });

  it('retorna metadata.provider "deepseek" corretamente', () => {
    const result = resolveProviderForDisplay({ provider: 'deepseek', costStatus: 'known' }, 'external');
    expect(result).toBe('deepseek');
  });

  it('retorna metadata.provider "gemini-agent-platform" corretamente', () => {
    const result = resolveProviderForDisplay(
      { provider: 'gemini-agent-platform', tokenStatus: 'reported' },
      'external',
    );
    expect(result).toBe('gemini-agent-platform');
  });

  it('metadata.provider tem precedencia sobre runtime', () => {
    const result = resolveProviderForDisplay({ provider: 'openrouter' }, 'cloud');
    expect(result).toBe('openrouter');
  });


  it('fallback para runtime quando metadata e undefined', () => {
    const result = resolveProviderForDisplay(undefined, 'cloud');
    expect(result).toBe('cloud');
  });

  it('fallback para runtime quando metadata nao tem provider', () => {
    const result = resolveProviderForDisplay({ costStatus: 'known' }, 'external');
    expect(result).toBe('external');
  });

  it('fallback para runtime "local"', () => {
    const result = resolveProviderForDisplay(undefined, 'local');
    expect(result).toBe('local');
  });

  it('fallback para runtime "codex"', () => {
    const result = resolveProviderForDisplay({}, 'codex');
    expect(result).toBe('codex');
  });


  it('retorna "unknown" quando metadata e undefined E runtime e null', () => {
    const result = resolveProviderForDisplay(undefined, null);
    expect(result).toBe('unknown');
  });

  it('retorna "unknown" quando metadata nao tem provider E runtime e null', () => {
    const result = resolveProviderForDisplay({ tokenStatus: 'reported' }, null);
    expect(result).toBe('unknown');
  });


  it('fase legada sem metadata: usa runtime como provider display', () => {
    const result = resolveProviderForDisplay(undefined, 'cloud');
    expect(result).toBe('cloud');
  });

  it('fase nova com provider: usa provider mesmo se runtime e "external"', () => {
    const result = resolveProviderForDisplay({ provider: 'qwen' }, 'external');
    expect(result).toBe('qwen');
  });


  it('sempre retorna uma string', () => {
    expect(typeof resolveProviderForDisplay(undefined, null)).toBe('string');
    expect(typeof resolveProviderForDisplay({ provider: 'kimi' }, 'external')).toBe('string');
    expect(typeof resolveProviderForDisplay({}, 'cloud')).toBe('string');
  });
});


describe('Integracao: formatCostWithMeta + formatTokensWithMeta', () => {
  it('fase com costStatus unknown e tokenStatus not_reported: ambos mostram mensagens de fallback', () => {
    const meta = { costStatus: 'unknown', tokenStatus: 'not_reported', provider: 'kimi' };
    expect(formatCostWithMeta(0.5, meta)).toBe('Custo nao estimado');
    expect(formatTokensWithMeta(100, 200, meta)).toBe('tokens nao reportados');
  });

  it('fase normal com ambos "known" e "reported": exibe valores reais', () => {
    const meta = { costStatus: 'known', tokenStatus: 'reported', provider: 'deepseek' };
    expect(formatCostWithMeta(0.0123, meta)).toBe('$0.012');
    expect(formatTokensWithMeta(5000, 3000, meta)).toBe('8.0K');
  });

  it('fase cache hit total: custo zero com known exibe $0.00, tokens normais', () => {
    const meta = { costStatus: 'known', tokenStatus: 'reported' };
    expect(formatCostWithMeta(0, meta)).toBe('$0.00');
    expect(formatTokensWithMeta(0, 0, meta)).toBe('0');
  });
});
