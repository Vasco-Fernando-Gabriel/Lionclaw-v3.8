import { findLionToolSchema, type LionToolSchema } from './tool-registry';

export interface LionToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
  isError?: boolean;
  errorMessage?: string;
}

export interface ParsedToolCallBatch {
  calls: LionToolUse[];
  remainingText: string;
}

export interface AnthropicContentBlock {
  type: string;
  id?: string;
  name?: string;
  input?: unknown;
  text?: string;
}

export interface NativeToolCall {
  index?: number;
  id?: string;
  type?: 'function' | string;
  function?: {
    name?: string;
    arguments?: string | Record<string, unknown>;
  };
  providerMetadata?: {
    googleGenAi?: {
      thoughtSignature?: string;
    };
  };
}

const FENCED_RE = /```lion_tool_use\s*\n([\s\S]*?)```/gi;

let _autoId = 0;
function nextSyntheticId(): string {
  _autoId = (_autoId + 1) % 1_000_000;
  return `lion_call_${Date.now().toString(36)}_${_autoId.toString(36)}`;
}

export function parseContentBlocks(blocks: AnthropicContentBlock[]): ParsedToolCallBatch {
  const calls: LionToolUse[] = [];
  const textParts: string[] = [];
  for (const b of blocks) {
    if (!b || typeof b.type !== 'string') continue;
    if (b.type === 'tool_use') {
      calls.push(
        normalizeCall({
          id: b.id,
          name: b.name,
          input: b.input,
        }),
      );
    } else if (b.type === 'text' && typeof b.text === 'string') {
      textParts.push(b.text);
    }
  }
  const joined = textParts.join('');
  const fromFenced = parseFencedBlocks(joined);
  return {
    calls: [...calls, ...fromFenced.calls],
    remainingText: fromFenced.remainingText,
  };
}

export function parseNativeToolCalls(toolCalls: NativeToolCall[]): LionToolUse[] {
  const out: LionToolUse[] = [];
  for (const t of toolCalls) {
    if (!t || !t.function) continue;
    let input: unknown = {};
    const raw = t.function.arguments;
    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (trimmed.length === 0) {
        input = {};
      } else {
        try {
          input = JSON.parse(trimmed);
        } catch (e) {
          out.push({
            id: t.id ?? nextSyntheticId(),
            name: t.function.name ?? '',
            input: {},
            isError: true,
            errorMessage: `Argumentos invalidos (JSON parse falhou): ${(e as Error).message}`,
          });
          continue;
        }
      }
    } else if (raw && typeof raw === 'object') {
      input = raw;
    }
    out.push(
      normalizeCall({
        id: t.id,
        name: t.function.name,
        input,
      }),
    );
  }
  return out;
}

export function parseFencedBlocks(text: string): ParsedToolCallBatch {
  if (!text || text.length === 0) return { calls: [], remainingText: text };

  const calls: LionToolUse[] = [];
  let lastIndex = 0;
  const cleanedParts: string[] = [];
  FENCED_RE.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = FENCED_RE.exec(text)) !== null) {
    cleanedParts.push(text.slice(lastIndex, match.index));
    lastIndex = match.index + match[0].length;
    const body = (match[1] ?? '').trim();
    if (body.length === 0) continue;
    let parsed: { calls?: Array<{ id?: string; name?: string; input?: unknown }> };
    try {
      parsed = JSON.parse(body) as { calls?: Array<{ id?: string; name?: string; input?: unknown }> };
    } catch (e) {
      calls.push({
        id: nextSyntheticId(),
        name: '',
        input: {},
        isError: true,
        errorMessage: `Bloco lion_tool_use malformado (JSON invalido): ${(e as Error).message}`,
      });
      continue;
    }
    if (!parsed || !Array.isArray(parsed.calls)) {
      calls.push({
        id: nextSyntheticId(),
        name: '',
        input: {},
        isError: true,
        errorMessage: 'Bloco lion_tool_use sem campo "calls".',
      });
      continue;
    }
    for (const c of parsed.calls) {
      calls.push(normalizeCall(c));
    }
  }
  cleanedParts.push(text.slice(lastIndex));

  return {
    calls,
    remainingText: cleanedParts.join('').trim(),
  };
}

export interface CombinedParseInput {
  contentBlocks?: AnthropicContentBlock[];
  nativeToolCalls?: NativeToolCall[];
  text?: string;
}

export function parseToolCallBatch(input: CombinedParseInput): ParsedToolCallBatch {
  const allCalls: LionToolUse[] = [];
  let remainingText = '';

  if (input.contentBlocks && input.contentBlocks.length > 0) {
    const r = parseContentBlocks(input.contentBlocks);
    allCalls.push(...r.calls);
    remainingText = r.remainingText;
  }

  if (input.nativeToolCalls && input.nativeToolCalls.length > 0) {
    allCalls.push(...parseNativeToolCalls(input.nativeToolCalls));
  }

  if (input.text && input.text.length > 0) {
    const r = parseFencedBlocks(input.text);
    allCalls.push(...r.calls);
    remainingText = remainingText.length > 0 ? `${remainingText}\n${r.remainingText}` : r.remainingText;
  }

  return { calls: allCalls, remainingText };
}

function normalizeCall(raw: { id?: string; name?: string; input?: unknown }): LionToolUse {
  const id = typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : nextSyntheticId();
  const name = typeof raw.name === 'string' ? raw.name : '';
  if (!name) {
    return {
      id,
      name: '',
      input: {},
      isError: true,
      errorMessage: 'Tool call sem nome.',
    };
  }
  const schema = findLionToolSchema(name);
  if (!schema) {
    return {
      id,
      name,
      input: typeof raw.input === 'object' && raw.input ? (raw.input as Record<string, unknown>) : {},
      isError: true,
      errorMessage: `Unknown tool: ${name}`,
    };
  }
  const input = typeof raw.input === 'object' && raw.input !== null ? (raw.input as Record<string, unknown>) : {};
  const validation = validateInputAgainstSchema(input, schema);
  if (!validation.ok) {
    return {
      id,
      name: schema.name, // resolve aliases (e.g. Task -> Agent)
      input,
      isError: true,
      errorMessage: validation.message,
    };
  }
  return {
    id,
    name: schema.name, // resolve aliases
    input,
  };
}

function validateInputAgainstSchema(
  input: Record<string, unknown>,
  schema: LionToolSchema,
): { ok: true } | { ok: false; message: string } {
  const required = schema.input_schema.required ?? [];
  const missing = required.filter((k) => !(k in input));
  if (missing.length > 0) {
    return { ok: false, message: `Faltam campos obrigatorios em ${schema.name}: ${missing.join(', ')}` };
  }
  return { ok: true };
}
