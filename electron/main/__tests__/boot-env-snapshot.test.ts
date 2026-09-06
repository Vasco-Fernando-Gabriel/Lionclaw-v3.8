import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const SENTINEL = 'LIONCLAW_TEST_BOOT_SNAPSHOT_SENTINEL';
const MUTATED = 'LIONCLAW_TEST_BOOT_SNAPSHOT_MUTATED';

describe('getBootEnvSnapshot', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env[SENTINEL] = 'presente-no-boot';
    delete process.env[MUTATED];
  });

  afterEach(() => {
    delete process.env[SENTINEL];
    delete process.env[MUTATED];
  });

  it('congela o env do momento do import; mutacoes posteriores nao aparecem', async () => {
    const { getBootEnvSnapshot } = await import('../boot-env-snapshot');
    process.env[MUTATED] = 'mutado-depois';
    process.env[SENTINEL] = 'sobrescrito-depois';

    const snapshot = getBootEnvSnapshot();
    expect(snapshot[SENTINEL]).toBe('presente-no-boot');
    expect(snapshot[MUTATED]).toBeUndefined();
  });

  it('devolve COPIA mutavel: alterar o retorno nao vaza para chamadas seguintes', async () => {
    const { getBootEnvSnapshot } = await import('../boot-env-snapshot');
    const first = getBootEnvSnapshot();
    first[SENTINEL] = 'alterado-na-copia';
    expect(getBootEnvSnapshot()[SENTINEL]).toBe('presente-no-boot');
  });
});
