import path from 'path';

const SMOKE_ARGUMENT = '--distribution-smoke=';

export function distributionSmokeRoot(argv: readonly string[]): string | null {
  const values = argv.filter((value) => value.startsWith(SMOKE_ARGUMENT));
  if (values.length === 0) return null;
  if (values.length !== 1) throw new Error('distribution smoke recebeu argumentos duplicados');
  const root = values[0].slice(SMOKE_ARGUMENT.length);
  if (!root || !path.isAbsolute(root) || root.includes('\0')) {
    throw new Error('distribution smoke exige um caminho absoluto válido');
  }
  return path.resolve(root);
}
