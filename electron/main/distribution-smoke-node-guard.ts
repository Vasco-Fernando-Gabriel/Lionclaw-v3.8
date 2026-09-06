import fs from 'fs';
import { createRequire } from 'node:module';
import path from 'path';

type GuardEnvironment = Record<string, string | undefined>;

export function installDistributionSmokeNodeGuard(
  environment: GuardEnvironment = process.env,
  load?: (guardPath: string) => unknown,
): void {
  if (environment.LIONCLAW_EGRESS_GUARD_ACTIVE === '1') {
    throw new Error('guard de egress chegou pre-ativado antes do bootstrap autoritativo');
  }
  const harnessRoot = environment.LIONCLAW_SMOKE_HARNESS_ROOT;
  const guardPath = environment.LIONCLAW_EGRESS_GUARD_PATH;
  if (!harnessRoot || !path.isAbsolute(harnessRoot) || !guardPath || !path.isAbsolute(guardPath)) {
    throw new Error('guard de egress exige caminhos absolutos do harness');
  }
  const expectedGuard = path.join(path.resolve(harnessRoot), 'authoritative egress guard.cjs');
  const stat = fs.lstatSync(guardPath, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.isSymbolicLink() || fs.realpathSync(guardPath) !== fs.realpathSync(expectedGuard)) {
    throw new Error('guard de egress não corresponde ao arquivo regular autoritativo do harness');
  }
  const requireGuard = load ?? createRequire(path.join(path.resolve(harnessRoot), 'guard-loader.cjs'));
  requireGuard(guardPath);
  if (environment.LIONCLAW_EGRESS_GUARD_ACTIVE !== '1') {
    throw new Error('guard de egress foi carregado sem ativar o contrato');
  }
}
