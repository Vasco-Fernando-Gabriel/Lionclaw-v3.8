
export interface WorkflowCompileSuccess {
  ok: true;
  meta: WorkflowMeta;
  transformedSource: string;
}

export interface WorkflowCompileFailure {
  ok: false;
  errors: WorkflowCompileError[];
}

export type WorkflowCompileResult = WorkflowCompileSuccess | WorkflowCompileFailure;

export interface WorkflowCompileError {
  code: WorkflowCompileErrorCode;
  message: string;
}

export type WorkflowCompileErrorCode =
  | 'forbidden-api'
  | 'missing-meta'
  | 'invalid-meta'
  | 'forbidden-import'
  | 'forbidden-export'
  | 'nondeterministic'
  | 'empty-source';

export interface WorkflowMeta {
  name: string;
  phases: string[];
  description?: string;
  [key: string]: unknown;
}


const FORBIDDEN_IDENTIFIERS = [
  'require',
  'process',
  'global',
  'globalThis',
  'Buffer',
  'module',
  'exports',
  '__dirname',
  '__filename',
  'eval',
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'import', // import() dinamico
] as const;

interface ForbiddenPattern {
  code: WorkflowCompileErrorCode;
  re: RegExp;
  label: string;
}

const FORBIDDEN_PATTERNS: ForbiddenPattern[] = [
  { code: 'nondeterministic', re: /\bDate\s*\.\s*now\b/, label: 'Date.now()' },
  { code: 'nondeterministic', re: /\bMath\s*\.\s*random\b/, label: 'Math.random()' },
  { code: 'forbidden-api', re: /\bnew\s+Function\b/, label: 'new Function(...)' },
];

const NODE_MODULE_HINTS = ['fs', 'child_process', 'net', 'http', 'https', 'os', 'path', 'vm', 'worker_threads', 'dns', 'tls', 'cluster'];


export function stripStringsAndComments(source: string): string {
  const out: string[] = [];
  let i = 0;
  const n = source.length;
  type Mode = 'code' | 'line-comment' | 'block-comment' | 'single' | 'double' | 'template';
  let mode: Mode = 'code';
  while (i < n) {
    const c = source[i];
    const c2 = i + 1 < n ? source[i + 1] : '';
    if (mode === 'code') {
      if (c === '/' && c2 === '/') {
        mode = 'line-comment';
        out.push('  ');
        i += 2;
        continue;
      }
      if (c === '/' && c2 === '*') {
        mode = 'block-comment';
        out.push('  ');
        i += 2;
        continue;
      }
      if (c === "'") {
        mode = 'single';
        out.push(' ');
        i += 1;
        continue;
      }
      if (c === '"') {
        mode = 'double';
        out.push(' ');
        i += 1;
        continue;
      }
      if (c === '`') {
        mode = 'template';
        out.push(' ');
        i += 1;
        continue;
      }
      out.push(c);
      i += 1;
      continue;
    }
    if (mode === 'line-comment') {
      if (c === '\n') {
        mode = 'code';
        out.push('\n');
      } else {
        out.push(' ');
      }
      i += 1;
      continue;
    }
    if (mode === 'block-comment') {
      if (c === '*' && c2 === '/') {
        mode = 'code';
        out.push('  ');
        i += 2;
      } else {
        out.push(c === '\n' ? '\n' : ' ');
        i += 1;
      }
      continue;
    }
    if (c === '\\') {
      out.push(' ');
      out.push(c2 === '\n' ? '\n' : ' ');
      i += 2;
      continue;
    }
    if (mode === 'single' && c === "'") {
      mode = 'code';
      out.push(' ');
      i += 1;
      continue;
    }
    if (mode === 'double' && c === '"') {
      mode = 'code';
      out.push(' ');
      i += 1;
      continue;
    }
    if (mode === 'template' && c === '`') {
      mode = 'code';
      out.push(' ');
      i += 1;
      continue;
    }
    out.push(c === '\n' ? '\n' : ' ');
    i += 1;
  }
  return out.join('');
}


function hasBareNewDate(code: string): boolean {
  const re = /\bnew\s+Date\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    let j = m.index + m[0].length;
    while (j < code.length && /\s/.test(code[j])) j += 1;
    if (code[j] === ')') return true; // new Date() puro = nao deterministico
  }
  return false;
}


function extractBalanced(source: string, openIndex: number, open: string, close: string): { text: string; end: number } | null {
  if (source[openIndex] !== open) return null;
  let depth = 0;
  for (let i = openIndex; i < source.length; i++) {
    const c = source[i];
    if (c === open) depth += 1;
    else if (c === close) {
      depth -= 1;
      if (depth === 0) return { text: source.slice(openIndex, i + 1), end: i };
    }
  }
  return null;
}


function metaLiteralToJson(literal: string): string {
  let s = literal.trim();
  s = s.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_match, inner: string) => {
    const escaped = inner.replace(/"/g, '\\"');
    return '"' + escaped + '"';
  });
  s = s.replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":');
  s = s.replace(/,\s*([}\]])/g, '$1');
  return s;
}

function isPureLiteral(literal: string): boolean {
  const stripped = stripStringsAndComments(literal);
  if (/[()`]/.test(stripped)) return false;
  if (/\+|\?|=>|\bfunction\b|\bnew\b/.test(stripped)) return false;
  const wordRe = /[A-Za-z_$][\w$]*/g;
  let m: RegExpExecArray | null;
  while ((m = wordRe.exec(stripped)) !== null) {
    const w = m[0];
    if (w === 'true' || w === 'false' || w === 'null') continue;
    let k = m.index + w.length;
    while (k < stripped.length && /\s/.test(stripped[k])) k += 1;
    if (stripped[k] === ':') continue;
    return false; // identificador/variavel solto no literal
  }
  return true;
}


export function extractWorkflowMeta(
  source: string,
): { ok: true; meta: WorkflowMeta } | { ok: false; error: WorkflowCompileError } {
  const code = stripStringsAndComments(source);
  const metaDecl = /export\s+const\s+meta\s*=\s*\{/.exec(code);
  if (!metaDecl) {
    return { ok: false, error: { code: 'missing-meta', message: 'export const meta literal ausente' } };
  }
  const braceIndex = metaDecl.index + metaDecl[0].length - 1; // posicao do '{'
  const block = extractBalanced(source, braceIndex, '{', '}');
  if (!block) {
    return { ok: false, error: { code: 'invalid-meta', message: 'literal de meta nao balanceado' } };
  }
  if (!isPureLiteral(block.text)) {
    return { ok: false, error: { code: 'invalid-meta', message: 'meta deve ser literal puro (sem variaveis, calls ou interpolacao)' } };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(metaLiteralToJson(block.text));
  } catch {
    return { ok: false, error: { code: 'invalid-meta', message: 'meta nao pode ser convertido para literal JSON' } };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, error: { code: 'invalid-meta', message: 'meta nao e objeto' } };
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.name !== 'string' || obj.name.length === 0) {
    return { ok: false, error: { code: 'invalid-meta', message: 'meta.name ausente ou vazio' } };
  }

  if (typeof obj.description !== 'string' || obj.description.length === 0) {
    return { ok: false, error: { code: 'invalid-meta', message: 'meta.description ausente ou vazio (modo claude-code)' } };
  }
  if (obj.phases !== undefined) {
    if (!Array.isArray(obj.phases) || !obj.phases.every((p) => typeof p === 'string')) {
      return { ok: false, error: { code: 'invalid-meta', message: 'meta.phases (se presente) deve ser array de strings' } };
    }
  } else {
    obj.phases = [];
  }
  return { ok: true, meta: obj as WorkflowMeta };
}

export function normalizeLineEndings(source: string): string {
  return source.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function compileWorkflowJs(rawSource: string): WorkflowCompileResult {
  const errors: WorkflowCompileError[] = [];
  if (typeof rawSource !== 'string' || rawSource.trim().length === 0) {
    return { ok: false, errors: [{ code: 'empty-source', message: 'workflow.js vazio' }] };
  }

  const source = normalizeLineEndings(rawSource);

  const code = stripStringsAndComments(source);

  if (/\bimport\s+[\w{*'"]/.test(code) || /\bimport\s*\(/.test(code)) {
    errors.push({ code: 'forbidden-import', message: 'import nao permitido no subset ESM (SPEC 7.2)' });
  }
  if (/\brequire\s*\(/.test(code)) {
    errors.push({ code: 'forbidden-import', message: 'require(...) nao permitido (SPEC 7.2)' });
  }

  const exportRe = /\bexport\b\s+([A-Za-z]+)/g;
  let em: RegExpExecArray | null;
  while ((em = exportRe.exec(code)) !== null) {
    const kw = em[1];
    if (kw === 'default') continue;
    if (kw === 'const') {
      const after = code.slice(em.index, em.index + 40);
      if (!/export\s+const\s+meta\b/.test(after)) {
        errors.push({ code: 'forbidden-export', message: 'unico export const permitido e meta (SPEC 7.2)' });
      }
      continue;
    }
    errors.push({ code: 'forbidden-export', message: `export ${kw} fora do subset (so meta + default)` });
  }

  for (const id of FORBIDDEN_IDENTIFIERS) {
    const re = new RegExp(`\\b${id}\\b`);
    if (re.test(code)) {
      if (id === 'import') continue;
      errors.push({ code: 'forbidden-api', message: `identificador proibido: ${id} (SPEC 7.2)` });
    }
  }

  for (const p of FORBIDDEN_PATTERNS) {
    if (p.re.test(code)) {
      errors.push({ code: p.code, message: `uso proibido: ${p.label} (SPEC 7.2/15)` });
    }
  }

  if (hasBareNewDate(code)) {
    errors.push({ code: 'nondeterministic', message: 'new Date() sem argumento quebra resume (SPEC 15)' });
  }

  for (const mod of NODE_MODULE_HINTS) {
    const re = new RegExp(`from\\s+['"\`]${mod}['"\`]`);
    if (re.test(source)) {
      errors.push({ code: 'forbidden-import', message: `modulo Node nao importavel: ${mod} (SPEC 7.2)` });
    }
  }

  const metaResult = extractWorkflowMeta(source);
  if (!metaResult.ok) {
    errors.push(metaResult.error);
  }

  if (errors.length > 0 || !metaResult.ok) {
    const seen = new Set<string>();
    const deduped = errors.filter((e) => {
      const key = `${e.code}:${e.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return { ok: false, errors: deduped };
  }

  return {
    ok: true,
    meta: metaResult.meta,
    transformedSource: transformToVmSource(source),
  };
}

export function transformToVmSource(source: string): string {
  return transformClaudeCodeToVmSource(source);
}

function transformClaudeCodeToVmSource(source: string): string {
  let body = source;

  const code = stripStringsAndComments(source);
  const metaDecl = /export\s+const\s+meta\s*=\s*\{/.exec(code);
  if (metaDecl) {
    const braceIndex = metaDecl.index + metaDecl[0].length - 1; // posicao do '{'
    const block = extractBalanced(source, braceIndex, '{', '}');
    if (block) {
      let end = block.end + 1;
      while (end < source.length && /\s/.test(source[end])) end += 1;
      if (source[end] === ';') end += 1;
      const start = metaDecl.index;
      const removed = source.slice(start, end);
      const blanked = removed.replace(/[^\n]/g, ' ');
      body = source.slice(0, start) + blanked + source.slice(end);
    }
  }

  return `globalThis.__run = async (ctx) => {\n${body}\n};\n`;
}
