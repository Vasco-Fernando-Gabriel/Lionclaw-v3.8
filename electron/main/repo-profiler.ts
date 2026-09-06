
import fs from 'fs';
import path from 'path';
import { createLogger } from './logger';
import { getSetting } from './db';
import { processAgentStream } from './stream-processor';
import { getClaudeSdkProcessOptions } from './pipeline-shared/sdk-bootstrap';
import { SDK_DISALLOWED_TOOLS, toSdkToolNames } from './agent-runtime/sdk-tool-names';

const logger = createLogger('repo-profiler');


export interface PhaseCallbacks {
  onText?: (chunk: string) => void;
  onToolUse?: (toolName: string) => void;
  onDone?: () => void;
}

export interface RepoManifest {
  projectPath: string;
  language: string;
  framework: string;
  scannedAt: string;
  totalFiles: number;
  classifiedFiles: number;
  ignoredDirs: string[];
  filesByRole: Record<string, string[]>;
  previousScan: string | null;
  skippedLargeFiles?: Array<{ path: string; sizeBytes: number }>;
}


const IGNORED_DIRS = new Set([
  'node_modules',
  'vendor',
  '.git',
  'dist',
  'build',
  '.next',
  '__pycache__',
  '.venv',
  'target',
  'coverage',
  '.lionclaw',
]);

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.tiff', '.webp',
  '.ico', '.svg', '.pdf', '.zip', '.tar', '.gz', '.bz2', '.xz',
  '.7z', '.rar', '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp4', '.mp3', '.wav', '.ogg', '.avi', '.mov', '.mkv',
  '.so', '.dll', '.exe', '.wasm', '.dylib', '.a', '.lib',
  '.class', '.jar', '.pyc', '.pyo',
]);

const DEFAULT_MAX_FILE_SIZE_BYTES = 5_242_880;

let MAX_FILE_SIZE_BYTES = DEFAULT_MAX_FILE_SIZE_BYTES;

export function setRepoProfilerMaxFileSize(bytes: number): void {
  MAX_FILE_SIZE_BYTES = bytes;
}

const MAX_FILES_SCANNED = 10_000;

const ALL_ROLES = [
  'auth', 'query', 'crypto', 'route', 'middleware',
  'template', 'async', 'error-handling', 'config', 'migration',
] as const;

export type Role = typeof ALL_ROLES[number];


const CONTENT_ROLE_PATTERNS: Record<Exclude<Role, 'config' | 'migration'>, string[]> = {
  auth: [
    'session', 'token', 'authenticate', 'passport',
    'jwt.verify', 'jwt.sign', 'login', 'bcrypt', 'argon2',
  ],
  query: [
    'SELECT ', 'INSERT ', 'UPDATE ', 'DELETE ',
    '.query(', '.execute(', 'prepare(', 'findOne', 'findMany', 'where(',
    'prisma.', 'knex', 'sequelize',
  ],
  crypto: [
    'crypto.', 'createHash', 'createCipher', 'encrypt', 'decrypt',
    'randomBytes', 'pbkdf2', 'scrypt', 'bcrypt', 'argon2', 'hashlib',
  ],
  route: [
    'router.', 'app.get(', 'app.post(', 'app.put(', 'app.delete(',
    '@Get(', '@Post(', '@Route', 'Route.', '@app.get', 'controller',
  ],
  middleware: [
    'middleware', 'next()', 'req,', 'req.headers', 'cors(', 'helmet(',
    'interceptor', 'guard', '@UseGuards',
  ],
  template: [
    '.erb', '.ejs', '.pug', '.hbs', '.mustache',
    'innerHTML', 'dangerouslySetInnerHTML', 'v-html', '{{{',
    '<%', '{{',
  ],
  async: [
    'setTimeout', 'setInterval', 'async ', 'await ', 'Promise.',
    '.then(', 'queueMicrotask',
  ],
  'error-handling': [
    'try {', 'catch (', 'throw new', 'Error(', '.catch(', 'onerror',
    'catch(',
  ],
};

export const ROLE_MIN_HITS: Record<Role, number> = {
  auth: 2,
  query: 1,
  crypto: 2,
  route: 2,
  middleware: 2,
  template: 1,
  async: 5,
  'error-handling': 3,
  config: 1,
  migration: 1,
};

export const PATH_HINTS: Array<{ regex: RegExp; role: Role; boost: number }> = [
  { regex: /(\/|^)auth(\/|s\/)/i, role: 'auth', boost: 5 },
  { regex: /(\/|^)migrations?(\/)/i, role: 'migration', boost: 10 },
  { regex: /(\/|^)middlewares?(\/)/i, role: 'middleware', boost: 5 },
  { regex: /(\/|^)(routes?|controllers?|handlers?)(\/)/i, role: 'route', boost: 5 },
  { regex: /(\/|^)(crypto|security)(\/)/i, role: 'crypto', boost: 5 },
];

export function stripCommentsAndStrings(content: string): string {
  return content
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

export const ROLE_METADATA: Record<Role, {
  label: string;
  description: string;
  threshold: number;
  samplePatterns: string[];
}> = {
  auth: {
    label: 'Auth',
    description: 'Arquivos com logica de autenticacao',
    threshold: ROLE_MIN_HITS.auth,
    samplePatterns: ['session', 'token', 'jwt.verify', 'bcrypt'],
  },
  query: {
    label: 'Query',
    description: 'Arquivos com queries de banco',
    threshold: ROLE_MIN_HITS.query,
    samplePatterns: ['SELECT', '.query(', 'prisma.', 'findOne'],
  },
  crypto: {
    label: 'Crypto',
    description: 'Arquivos com operacoes criptograficas',
    threshold: ROLE_MIN_HITS.crypto,
    samplePatterns: ['crypto.', 'createHash', 'encrypt', 'pbkdf2'],
  },
  route: {
    label: 'Route',
    description: 'Arquivos de rotas/handlers HTTP',
    threshold: ROLE_MIN_HITS.route,
    samplePatterns: ['router.', 'app.get(', '@Get(', '@Post('],
  },
  middleware: {
    label: 'Middleware',
    description: 'Arquivos com middlewares ou interceptors',
    threshold: ROLE_MIN_HITS.middleware,
    samplePatterns: ['middleware', 'next()', 'cors(', 'helmet('],
  },
  template: {
    label: 'Template',
    description: 'Arquivos de template/render HTML',
    threshold: ROLE_MIN_HITS.template,
    samplePatterns: ['innerHTML', 'dangerouslySetInnerHTML', '<%', '{{'],
  },
  async: {
    label: 'Async',
    description: 'Arquivos com codigo assincrono pesado',
    threshold: ROLE_MIN_HITS.async,
    samplePatterns: ['async', 'await', 'Promise.', 'setTimeout'],
  },
  'error-handling': {
    label: 'Error Handling',
    description: 'Arquivos com try/catch ou throw. NAO significa arquivos com bugs.',
    threshold: ROLE_MIN_HITS['error-handling'],
    samplePatterns: ['try {', 'catch (', 'throw new', 'Error('],
  },
  config: {
    label: 'Config',
    description: 'Arquivos de configuracao (env, config, settings)',
    threshold: ROLE_MIN_HITS.config,
    samplePatterns: ['.env', 'config.json', 'settings.json'],
  },
  migration: {
    label: 'Migration',
    description: 'Arquivos de migration de banco',
    threshold: ROLE_MIN_HITS.migration,
    samplePatterns: ['migrations/', 'CREATE TABLE', 'ALTER TABLE'],
  },
};

export const EXCLUDED_FROM_AUDIT_PATTERNS: RegExp[] = [
  /^\.env($|\.)/i,
  /\.env\.(local|production|development|test|staging|example|sample)$/i,
];

const CONFIG_NAME_PATTERNS = [
  /^config\./i,
  /^settings\./i,
  /^credentials\./i,
  /^secrets\./i,
  /\.config\.(js|ts|mjs|cjs)$/i,
  /^(docker-compose|docker\.compose)\.(yml|yaml)$/i,
  /^(\.gitlab-ci|\.travis|circle\.ci)\.(yml|yaml)$/i,
];


interface LangFramework {
  language: string;
  framework: string;
}

function detectLanguageFramework(projectPath: string): LangFramework {
  const packageJsonPath = path.join(projectPath, 'package.json');
  if (fs.existsSync(packageJsonPath)) {
    let language = 'javascript';

    if (fs.existsSync(path.join(projectPath, 'tsconfig.json'))) {
      language = 'typescript';
    }

    try {
      const raw = fs.readFileSync(packageJsonPath, 'utf-8');
      const pkg = JSON.parse(raw) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };

      const allDeps = {
        ...((pkg.dependencies as Record<string, string>) ?? {}),
        ...((pkg.devDependencies as Record<string, string>) ?? {}),
      };
      const depNames = Object.keys(allDeps);

      let framework = 'node';

      if (depNames.includes('next')) {
        framework = 'next';
      } else if (depNames.includes('@nestjs/core')) {
        framework = 'nest';
      } else if (depNames.includes('express')) {
        framework = 'express';
      } else if (depNames.includes('fastify')) {
        framework = 'fastify';
      } else if (depNames.includes('react')) {
        framework = 'react';
      } else if (depNames.includes('vue')) {
        framework = 'vue';
      } else if (depNames.includes('svelte')) {
        framework = 'svelte';
      }

      return { language, framework };
    } catch (err) {
      logger.warn({ err, packageJsonPath }, 'Falha ao parsear package.json');
      return { language, framework: 'node' };
    }
  }

  const gemfilePath = path.join(projectPath, 'Gemfile');
  if (fs.existsSync(gemfilePath)) {
    try {
      const content = fs.readFileSync(gemfilePath, 'utf-8');
      const framework = content.toLowerCase().includes('rails') ? 'rails' : 'unknown';
      return { language: 'ruby', framework };
    } catch {
      return { language: 'ruby', framework: 'unknown' };
    }
  }

  const goModPath = path.join(projectPath, 'go.mod');
  if (fs.existsSync(goModPath)) {
    try {
      const content = fs.readFileSync(goModPath, 'utf-8').toLowerCase();
      let framework = 'unknown';
      if (content.includes('gin-gonic/gin') || content.includes('"gin"')) {
        framework = 'gin';
      } else if (content.includes('labstack/echo')) {
        framework = 'echo';
      } else if (content.includes('gofiber/fiber')) {
        framework = 'fiber';
      }
      return { language: 'go', framework };
    } catch {
      return { language: 'go', framework: 'unknown' };
    }
  }

  const requirementsTxtPath = path.join(projectPath, 'requirements.txt');
  const pyprojectPath = path.join(projectPath, 'pyproject.toml');
  if (fs.existsSync(requirementsTxtPath) || fs.existsSync(pyprojectPath)) {
    let content = '';
    try {
      if (fs.existsSync(requirementsTxtPath)) {
        content += fs.readFileSync(requirementsTxtPath, 'utf-8').toLowerCase();
      }
      if (fs.existsSync(pyprojectPath)) {
        content += fs.readFileSync(pyprojectPath, 'utf-8').toLowerCase();
      }
    } catch {
    }

    let framework = 'unknown';
    if (content.includes('django')) {
      framework = 'django';
    } else if (content.includes('fastapi')) {
      framework = 'fastapi';
    } else if (content.includes('flask')) {
      framework = 'flask';
    }
    return { language: 'python', framework };
  }

  const cargoPath = path.join(projectPath, 'Cargo.toml');
  if (fs.existsSync(cargoPath)) {
    try {
      const content = fs.readFileSync(cargoPath, 'utf-8').toLowerCase();
      let framework = 'unknown';
      if (content.includes('actix-web')) {
        framework = 'actix-web';
      } else if (content.includes('rocket')) {
        framework = 'rocket';
      } else if (content.includes('axum')) {
        framework = 'axum';
      }
      return { language: 'rust', framework };
    } catch {
      return { language: 'rust', framework: 'unknown' };
    }
  }

  const pomPath = path.join(projectPath, 'pom.xml');
  const gradlePath = path.join(projectPath, 'build.gradle');
  const gradleKtsPath = path.join(projectPath, 'build.gradle.kts');
  if (fs.existsSync(pomPath) || fs.existsSync(gradlePath) || fs.existsSync(gradleKtsPath)) {
    let content = '';
    try {
      if (fs.existsSync(pomPath)) content += fs.readFileSync(pomPath, 'utf-8').toLowerCase();
      if (fs.existsSync(gradlePath)) content += fs.readFileSync(gradlePath, 'utf-8').toLowerCase();
      if (fs.existsSync(gradleKtsPath)) content += fs.readFileSync(gradleKtsPath, 'utf-8').toLowerCase();
    } catch {
    }
    const framework = content.includes('spring-boot') || content.includes('spring.boot')
      ? 'spring-boot'
      : 'unknown';
    return { language: 'java', framework };
  }

  return { language: 'unknown', framework: 'unknown' };
}


function isConfigFile(basename: string): boolean {
  return CONFIG_NAME_PATTERNS.some((re) => re.test(basename));
}

function isMigrationFile(relativePath: string, content: string | null): boolean {
  const lowerPath = relativePath.toLowerCase();
  const inMigrationFolder =
    lowerPath.includes('/migration') || lowerPath.includes('/migrate');

  if (!inMigrationFolder) return false;
  if (content === null) return false;

  const upperContent = content.toUpperCase();
  return (
    upperContent.includes('CREATE TABLE') ||
    upperContent.includes('ALTER TABLE') ||
    upperContent.includes('DROP TABLE')
  );
}

export function classifyByContent(
  relativePath: string,
  basename: string,
  content: string | null,
): Role[] {
  const roles = new Set<Role>();

  if (isConfigFile(basename)) {
    roles.add('config');
  }

  if (content !== null && isMigrationFile(relativePath, content)) {
    roles.add('migration');
  }

  const stripped = content !== null ? stripCommentsAndStrings(content).toLowerCase() : '';

  const hits: Partial<Record<Role, number>> = {};
  for (const role of ALL_ROLES) {
    if (role === 'config' || role === 'migration') continue;

    const patterns = CONTENT_ROLE_PATTERNS[role as Exclude<Role, 'config' | 'migration'>];
    let count = 0;

    if (content !== null) {
      for (const p of patterns) {
        const lp = p.toLowerCase();
        count += stripped.split(lp).length - 1;
      }
    }

    for (const hint of PATH_HINTS) {
      if (hint.role === role && hint.regex.test(relativePath)) {
        count += hint.boost;
      }
    }

    hits[role] = count;
  }

  for (const role of ALL_ROLES) {
    if (role === 'config' || role === 'migration') continue;
    if ((hits[role] ?? 0) >= ROLE_MIN_HITS[role]) {
      roles.add(role);
    }
  }

  return Array.from(roles);
}


interface ScanResult {
  totalFiles: number;
  classifiedFiles: number;
  ignoredDirsFound: string[];
  filesByRole: Record<Role, string[]>;
  skippedLargeFiles: Array<{ path: string; sizeBytes: number }>;
}

function scanDirectory(
  projectPath: string,
  callbacks: PhaseCallbacks,
): ScanResult {
  const filesByRole: Record<Role, string[]> = {
    auth: [],
    query: [],
    crypto: [],
    route: [],
    middleware: [],
    template: [],
    async: [],
    'error-handling': [],
    config: [],
    migration: [],
  };

  const skippedLargeFiles: Array<{ path: string; sizeBytes: number }> = [];

  const ignoredDirsFound = new Set<string>();
  let totalFiles = 0;
  let classifiedFiles = 0;
  let hitLimit = false;

  function walk(dirPath: string): void {
    if (hitLimit) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch (err) {
      logger.warn({ err, dirPath }, 'Nao foi possivel ler diretorio, ignorando');
      return;
    }

    for (const entry of entries) {
      if (hitLimit) break;

      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) {
          ignoredDirsFound.add(entry.name);
          continue;
        }
        walk(path.join(dirPath, entry.name));
        continue;
      }

      if (!entry.isFile()) continue;

      if (totalFiles >= MAX_FILES_SCANNED) {
        if (!hitLimit) {
          hitLimit = true;
          logger.warn({ limit: MAX_FILES_SCANNED }, 'Limite de arquivos atingido, varredura truncada');
          callbacks.onText?.(`Aviso: limite de ${MAX_FILES_SCANNED} arquivos atingido, varredura truncada`);
        }
        break;
      }

      totalFiles++;

      const filePath = path.join(dirPath, entry.name);
      const relativePath = path.relative(projectPath, filePath);
      const ext = path.extname(entry.name).toLowerCase();
      const basename = entry.name;

      if (EXCLUDED_FROM_AUDIT_PATTERNS.some((re) => re.test(basename))) {
        continue;
      }

      if (BINARY_EXTENSIONS.has(ext)) {
        continue;
      }

      let content: string | null = null;
      let fileStat: fs.Stats | null = null;
      try {
        fileStat = fs.statSync(filePath);
      } catch (err) {
        logger.warn({ err, filePath }, 'Nao foi possivel ler stat do arquivo');
      }

      if (fileStat && fileStat.size <= MAX_FILE_SIZE_BYTES) {
        try {
          content = fs.readFileSync(filePath, 'utf-8');
        } catch {
          content = null;
        }
      } else if (fileStat && fileStat.size > MAX_FILE_SIZE_BYTES) {
        logger.debug({ filePath, size: fileStat.size }, 'Arquivo maior que limite, skip de conteudo');
        skippedLargeFiles.push({ path: relativePath, sizeBytes: fileStat.size });
      }

      const roles = classifyByContent(relativePath, basename, content);

      if (roles.length > 0) {
        classifiedFiles++;
        for (const role of roles) {
          filesByRole[role].push(relativePath);
        }
      }
    }
  }

  walk(projectPath);

  return {
    totalFiles,
    classifiedFiles,
    ignoredDirsFound: Array.from(ignoredDirsFound),
    filesByRole,
    skippedLargeFiles,
  };
}


function findPreviousScan(projectPath: string): string | null {
  const securityDir = path.join(projectPath, '.lionclaw', 'Security');

  if (!fs.existsSync(securityDir)) {
    return null;
  }

  let entries: string[];
  try {
    entries = fs.readdirSync(securityDir);
  } catch (err) {
    logger.warn({ err, securityDir }, 'Nao foi possivel ler pasta Security');
    return null;
  }

  const scanFiles = entries
    .filter((name) => /^SecurityScan-.+\.json$/i.test(name))
    .sort(); // ordem lexicografica funciona pois nomes sao YYYYMMDD-HHmm

  if (scanFiles.length === 0) return null;

  const latest = scanFiles[scanFiles.length - 1];
  return path.join(securityDir, latest);
}


const STACK_DETECTION_SYSTEM_PROMPT = `Voce e um detector de stack tecnico para auditoria de seguranca.

Objetivo: dado o caminho de um projeto, identificar a LINGUAGEM principal e o FRAMEWORK em uso usando Glob, Grep e Read.

Regras:
- Use Glob pra ver a distribuicao de extensoes e identificar manifests (package.json, Cargo.toml, go.mod, requirements.txt, Gemfile, composer.json, pom.xml, build.gradle, mix.exs, pyproject.toml).
- Se o manifesto existe, prefira a informacao dele (imports/deps).
- Se nao existe manifesto, use a extensao dominante e palavras-chave em imports (ex: "from django" => django; "FastAPI(" => fastapi).
- Reporte framework em uso REAL (imports, deps ativas), nao o que poderia estar.
- Responda APENAS com um bloco JSON no ultimo turno, sem texto antes ou depois:

\`\`\`json
{"language": "python", "framework": "fastapi"}
\`\`\`

Valores validos para language: typescript, javascript, python, ruby, go, rust, java, kotlin, php, csharp, swift, elixir, scala, unknown.
Valores validos para framework: string curta lowercase (fastapi, django, flask, nextjs, express, rails, spring-boot, gin, axum, ...) ou "unknown".`;

async function detectStackWithAgent(
  projectPath: string,
  current: LangFramework,
): Promise<LangFramework> {
  try {
    const runtime = (getSetting('orchestrator_runtime') || '').trim();
    if (runtime !== 'claude-sdk') {
      const { recordSystemActivity } = await import('./activity-log');
      logger.info(
        { projectPath, runtime, current },
        'Stack detection agent pulado: orquestrador nao e claude-sdk (heuristica preservada)',
      );
      recordSystemActivity({
        id: `repo-profiler-skip-${Date.now()}`,
        label: 'repo-profiler: refino por LLM pulado',
        description: `orquestrador nao e claude-sdk (${runtime || 'nao configurado'}); heuristica de stack preservada`,
      });
      return current;
    }

    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    const processOptions = getClaudeSdkProcessOptions();

    const prompt = `Analise o projeto em ${projectPath} e identifique language + framework.`;

    const orchestratorModel = (getSetting('orchestrator_model') || '').trim();
    const q = query({
      prompt,
      options: {
        ...processOptions,
        cwd: projectPath,
        ...(orchestratorModel ? { model: orchestratorModel } : {}),
        systemPrompt: STACK_DETECTION_SYSTEM_PROMPT,
        allowedTools: toSdkToolNames(['Read', 'Glob', 'Grep']),
        disallowedTools: [...SDK_DISALLOWED_TOOLS],
        mcpServers: {},
        strictMcpConfig: true,
        permissionMode: 'bypassPermissions' as const,
        allowDangerouslySkipPermissions: true,
        includePartialMessages: false,
        maxTurns: 8,
        thinking: { type: 'disabled' as const },
      },
    }) as unknown as AsyncIterable<Record<string, unknown>>;

    const { output } = await processAgentStream(q, {
      shouldAbort: () => false,
    });

    const fenced = output.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
    const rawJson = fenced?.[1] ?? output.match(/\{[^{}]*"language"[^{}]*\}/)?.[0];
    if (!rawJson) {
      logger.warn({ projectPath, outputPreview: output.slice(0, 200) }, 'Stack detection agent: no JSON in output');
      return current;
    }

    const parsed = JSON.parse(rawJson) as { language?: unknown; framework?: unknown };
    const lang = typeof parsed.language === 'string' && parsed.language.trim() ? parsed.language.trim() : current.language;
    const fw = typeof parsed.framework === 'string' && parsed.framework.trim() ? parsed.framework.trim() : current.framework;

    logger.info({ projectPath, detected: { language: lang, framework: fw } }, 'Stack detection agent: success');
    return { language: lang, framework: fw };
  } catch (err) {
    logger.warn({ err, projectPath }, 'Stack detection agent: failed; keeping deterministic result');
    return current;
  }
}


export async function runRepoProfiler(
  projectPath: string,
  callbacks: PhaseCallbacks,
): Promise<RepoManifest> {
  logger.info({ projectPath }, 'Iniciando Repo Profiler');

  callbacks.onText?.('Detectando linguagem e framework...');

  let { language, framework } = detectLanguageFramework(projectPath);

  if (language === 'unknown' || framework === 'unknown') {
    callbacks.onText?.('Manifesto nao identificado; consultando agente de deteccao...');
    logger.info({ projectPath, pre: { language, framework } }, 'Invoking LLM fallback for stack detection');
    const detected = await detectStackWithAgent(projectPath, { language, framework });
    language = detected.language;
    framework = detected.framework;
  }

  const langLabel = language.charAt(0).toUpperCase() + language.slice(1);
  const fwLabel = framework !== 'unknown' ? ` + ${framework.charAt(0).toUpperCase() + framework.slice(1)}` : '';
  callbacks.onText?.(`Detectado: ${langLabel}${fwLabel}`);
  logger.info({ language, framework }, 'Linguagem/framework detectados');

  const lionclawDir = path.join(projectPath, '.lionclaw');
  const securityDir = path.join(lionclawDir, 'Security');
  try {
    fs.mkdirSync(securityDir, { recursive: true });
  } catch (err) {
    logger.warn({ err, securityDir }, 'Nao foi possivel criar pasta Security');
  }

  const previousScan = findPreviousScan(projectPath);
  if (previousScan) {
    logger.info({ previousScan }, 'Scan anterior encontrado');
    callbacks.onText?.(`Scan anterior encontrado: ${path.basename(previousScan)}`);
  }

  callbacks.onText?.('Classificando arquivos...');

  const scanResult = scanDirectory(projectPath, callbacks);

  const {
    totalFiles,
    classifiedFiles,
    ignoredDirsFound,
    filesByRole,
    skippedLargeFiles,
  } = scanResult;

  logger.info(
    { totalFiles, classifiedFiles, ignoredDirs: ignoredDirsFound },
    'Varredura concluida',
  );

  const manifest: RepoManifest = {
    projectPath,
    language,
    framework,
    scannedAt: new Date().toISOString(),
    totalFiles,
    classifiedFiles,
    ignoredDirs: ignoredDirsFound,
    filesByRole: filesByRole as Record<string, string[]>,
    previousScan,
    skippedLargeFiles,
  };

  const manifestPath = path.join(lionclawDir, 'manifest.json');
  try {
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
    logger.info({ manifestPath }, 'manifest.json salvo');
  } catch (err) {
    logger.error({ err, manifestPath }, 'Falha ao salvar manifest.json');
    throw err;
  }

  callbacks.onText?.(`${totalFiles} arquivos, ${classifiedFiles} classificados`);

  callbacks.onDone?.();

  logger.info({ projectPath, totalFiles, classifiedFiles }, 'Repo Profiler concluido');

  return manifest;
}
