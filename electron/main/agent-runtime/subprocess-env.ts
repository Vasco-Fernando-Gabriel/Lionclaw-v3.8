
export const SUBPROCESS_ENV_STRIPPED_KEYS: readonly string[] = [
  'NODE_ENV',
  'ELECTRON_RENDERER_URL',
  'ELECTRON_RUN_AS_NODE',
  'DEBUG',
];

export const SUBPROCESS_ENV_STRIPPED_PREFIXES: readonly string[] = ['VITE_'];

export function isStrippedSubprocessEnvKey(key: string): boolean {
  if (SUBPROCESS_ENV_STRIPPED_KEYS.includes(key)) return true;
  return SUBPROCESS_ENV_STRIPPED_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export function sanitizeSubprocessEnv(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (isStrippedSubprocessEnvKey(key)) continue;
    out[key] = value;
  }
  return out;
}
