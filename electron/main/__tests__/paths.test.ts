import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getLionClawHome } from '../paths';

const originalNodeEnv = process.env['NODE_ENV'];
const originalTestHome = process.env['LIONCLAW_TEST_HOME'];

describe.sequential('getLionClawHome', () => {
  afterEach(() => {
    restoreEnv('NODE_ENV', originalNodeEnv);
    restoreEnv('LIONCLAW_TEST_HOME', originalTestHome);
  });

  it('usa ~/.lionclaw por padrao', () => {
    delete process.env['LIONCLAW_TEST_HOME'];
    expect(getLionClawHome()).toBe(path.join(os.homedir(), '.lionclaw'));
  });

  it('aceita uma raiz isolada somente no ambiente de teste', () => {
    process.env['NODE_ENV'] = 'test';
    process.env['LIONCLAW_TEST_HOME'] = './tmp/lionclaw-e2e';
    expect(getLionClawHome()).toBe(path.resolve('./tmp/lionclaw-e2e'));
  });

  it('ignora a raiz de teste fora do ambiente de teste', () => {
    process.env['NODE_ENV'] = 'production';
    process.env['LIONCLAW_TEST_HOME'] = '/tmp/nao-deve-ser-usado';
    expect(getLionClawHome()).toBe(path.join(os.homedir(), '.lionclaw'));
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
