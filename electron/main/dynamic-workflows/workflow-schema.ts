export type SchemaStrategy = 'forced-tool' | 'parse-repair';

export type SchemaRuntime =
  'cloud' | 'local' | 'external' | 'codex' | 'kimi' | 'grok' | 'zai' | 'minimax-tp' | 'cursor';

export function schemaStrategyForRuntime(runtime: SchemaRuntime): SchemaStrategy {
  switch (runtime) {
    case 'cloud':
    case 'zai':
    case 'minimax-tp':
      return 'forced-tool';
    case 'codex':
    case 'kimi':
    case 'grok':
    case 'cursor':
    case 'local':
    case 'external':
      return 'parse-repair';
  }
}

export interface SchemaValidationResult {
  ok: boolean;
  errors: string[];
}

export type SchemaValidator = (value: unknown, schema: WorkflowOutputSchema) => SchemaValidationResult;

export interface WorkflowOutputSchema {
  name?: string;
  type?: 'object';
  required?: string[];
}

export function jsonSchemaToOutputSchema(raw: unknown, refName?: string): WorkflowOutputSchema | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const required = Array.isArray(obj.required) ? obj.required.filter((k): k is string => typeof k === 'string') : [];
  const name = typeof obj.title === 'string' ? obj.title : typeof obj.$id === 'string' ? obj.$id : refName;
  return {
    ...(name !== undefined ? { name } : {}),
    type: 'object',
    required,
  };
}

export interface SchemaAttemptOutput {
  text: string;
  structured?: unknown;
}

export type SchemaAttemptFn = (params: { attemptIndex: number; feedback: string[] }) => Promise<SchemaAttemptOutput>;

export interface ResolveSchemaOptions {
  runtime: SchemaRuntime;
  schema: WorkflowOutputSchema;
  attempt: SchemaAttemptFn;
  maxAttempts?: number;
  validator?: SchemaValidator;
}

export interface SchemaSuccess {
  ok: true;
  value: unknown;
  attempts: number;
  strategy: SchemaStrategy;
}

export interface SchemaFailure {
  ok: false;
  failureClass: 'schema';
  message: string;
  errors: string[];
  attempts: number;
  strategy: SchemaStrategy;
}

export type SchemaResolution = SchemaSuccess | SchemaFailure;

const DEFAULT_MAX_ATTEMPTS = 3;

export function extractFirstJsonObject(text: string): unknown {
  if (!text) return undefined;

  const trimmed = text.trim();
  const directCandidate = trimmed.startsWith('{') || trimmed.startsWith('[') ? trimmed : null;
  if (directCandidate) {
    try {
      return JSON.parse(directCandidate);
    } catch {}
  }

  for (let start = 0; start < text.length; start++) {
    if (text[start] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }
      if (ch === '"') {
        inString = true;
      } else if (ch === '{') {
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0) {
          const candidate = text.slice(start, i + 1);
          try {
            return JSON.parse(candidate);
          } catch {
            break;
          }
        }
      }
    }
  }
  return undefined;
}

export function minimalShapeValidator(value: unknown, schema: WorkflowOutputSchema): SchemaValidationResult {
  const errors: string[] = [];
  const wantsObject = schema.type === undefined || schema.type === 'object';

  if (wantsObject) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      errors.push('output esperado: objeto JSON no topo');
      return { ok: false, errors };
    }
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in obj)) {
        errors.push(`chave obrigatoria ausente: "${key}"`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

export async function resolveStructuredOutput(options: ResolveSchemaOptions): Promise<SchemaResolution> {
  const strategy = schemaStrategyForRuntime(options.runtime);
  const validate = options.validator ?? minimalShapeValidator;
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);

  let lastErrors: string[] = [];

  for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex++) {
    const out = await options.attempt({ attemptIndex, feedback: lastErrors });

    let candidate: unknown;
    if (strategy === 'forced-tool' && out.structured !== undefined) {
      candidate = out.structured;
    } else {
      candidate = extractFirstJsonObject(out.text);
      if (candidate === undefined) {
        lastErrors = [`nenhum objeto JSON valido no output (schema "${options.schema.name ?? 'sem-nome'}")`];
        continue;
      }
    }

    const result = validate(candidate, options.schema);
    if (result.ok) {
      return {
        ok: true,
        value: candidate,
        attempts: attemptIndex + 1,
        strategy,
      };
    }
    lastErrors = result.errors;
  }

  return {
    ok: false,
    failureClass: 'schema',
    message: `output fora do schema apos ${maxAttempts} tentativa(s)`,
    errors: lastErrors,
    attempts: maxAttempts,
    strategy,
  };
}
