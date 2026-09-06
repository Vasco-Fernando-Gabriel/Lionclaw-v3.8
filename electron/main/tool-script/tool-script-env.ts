
const PRESERVE_EXACT: ReadonlySet<string> = new Set([
  'HOME',
  'PATH',
  'LANG',
  'LANGUAGE',
  'TMPDIR',
  'TMP',
  'TEMP',
  'TERM',
  'USER',
  'SHELL',
  'LOGNAME',
  'PWD',
  'TZ',
  'SSH_AUTH_SOCK',
  'EDITOR',
  'PAGER',
  'COLORTERM',
  'DISPLAY',
]);

const PRESERVE_PREFIXES: readonly string[] = ['LC_', 'XDG_'];

const DENY_SUBSTRINGS: readonly string[] = [
  'API_KEY',
  'APIKEY',
  'TOKEN',
  'SECRET',
  'PASSWORD',
  'PASSWD',
  'CREDENTIAL',
  'PRIVATE_KEY',
  'ACCESS_KEY',
  'SESSION_KEY',
  'KEYTAR',
  'KEYCHAIN',
  'VAULT',
  'BEARER',
  'OAUTH',
  '_DSN',
];

const DENY_PREFIXES: readonly string[] = [
  'ANTHROPIC_',
  'OPENAI_',
  'LIONCLAW_',
  'CLAUDE_',
  'AWS_',
  'GH_',
  'GITHUB_',
  'GITLAB_',
  'GEMINI_',
  'TELEGRAM_',
  'ELEVENLABS_',
  'MINIMAX_',
  'MOONSHOT_',
  'KIMI_',
  'ZHIPU_',
  'ZAI_',
  'COHERE_',
  'SHOPIFY_',
  'STRIPE_',
  'SENTRY_',
  'SUPABASE_',
  'VERCEL_',
];

const DENY_SUFFIXES: readonly string[] = ['_KEY', '_PAT', '_AUTH'];

const DENY_EXACT: ReadonlySet<string> = new Set([
  'DATABASE_URL',
  'REDIS_URL',
  'MONGODB_URI',
  'MONGO_URL',
  'POSTGRES_URL',
  'POSTGRESQL_URL',
  'MYSQL_URL',
  'PGPASSFILE',
]);

export function isDeniedEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  if (PRESERVE_EXACT.has(upper)) return false;
  if (PRESERVE_PREFIXES.some((prefix) => upper.startsWith(prefix))) return false;
  if (DENY_EXACT.has(upper)) return true;
  if (DENY_PREFIXES.some((prefix) => upper.startsWith(prefix))) return true;
  if (DENY_SUFFIXES.some((suffix) => upper.endsWith(suffix))) return true;
  return DENY_SUBSTRINGS.some((needle) => upper.includes(needle));
}

export function buildToolScriptEnv(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (isDeniedEnvKey(key)) continue;
    env[key] = value;
  }
  return env;
}
