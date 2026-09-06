
import {
  Type,
  type FunctionDeclaration,
  type GenerateContentConfig,
  type Schema,
} from '@google/genai';

import type { LionToolSchema } from '../tool-registry';


function mapJsonTypeToGoogleType(jsonType: unknown): Type | undefined {
  if (typeof jsonType !== 'string') return undefined;
  switch (jsonType.toLowerCase()) {
    case 'string':
      return Type.STRING;
    case 'number':
      return Type.NUMBER;
    case 'integer':
      return Type.INTEGER;
    case 'boolean':
      return Type.BOOLEAN;
    case 'array':
      return Type.ARRAY;
    case 'object':
      return Type.OBJECT;
    default:
      return undefined;
  }
}

function normalizeEnumValues(values: unknown): string[] | undefined {
  if (!Array.isArray(values) || values.length === 0) return undefined;
  const out: string[] = [];
  for (const v of values) {
    if (v === null || v === undefined) continue;
    out.push(String(v));
  }
  return out.length > 0 ? out : undefined;
}

export function convertJsonSchemaToGoogleSchema(node: unknown): Schema {
  if (node === null || typeof node !== 'object') {
    return {};
  }
  const src = node as Record<string, unknown>;
  const out: Schema = {};

  const googleType = mapJsonTypeToGoogleType(src.type);
  if (googleType !== undefined) {
    out.type = googleType;
  }

  if (typeof src.description === 'string' && src.description.length > 0) {
    out.description = src.description;
  }

  const normalizedEnum = normalizeEnumValues(src.enum);
  if (normalizedEnum) {
    out.enum = normalizedEnum;
  }

  if (Array.isArray(src.required)) {
    const requiredStrings = src.required.filter((r): r is string => typeof r === 'string');
    if (requiredStrings.length > 0) {
      out.required = requiredStrings;
    }
  }

  if (
    src.properties !== null &&
    typeof src.properties === 'object' &&
    !Array.isArray(src.properties)
  ) {
    const propsIn = src.properties as Record<string, unknown>;
    const propsOut: Record<string, Schema> = {};
    for (const [key, value] of Object.entries(propsIn)) {
      propsOut[key] = convertJsonSchemaToGoogleSchema(value);
    }
    out.properties = propsOut;
  }

  if (src.items !== undefined && src.items !== null) {
    out.items = convertJsonSchemaToGoogleSchema(src.items);
  }

  return out;
}


export function toGoogleSafeName(name: string): string {
  return name;
}

export function convertLionToolToGoogleFunctionDeclaration(
  tool: LionToolSchema,
): FunctionDeclaration {
  const parameters = convertJsonSchemaToGoogleSchema(tool.input_schema);
  const decl: FunctionDeclaration = {
    name: toGoogleSafeName(tool.name),
    parameters,
  };
  if (typeof tool.description === 'string' && tool.description.length > 0) {
    decl.description = tool.description;
  }
  return decl;
}

export function buildGoogleToolConfig(
  tools: LionToolSchema[] | undefined,
): GenerateContentConfig['tools'] | undefined {
  if (!tools || tools.length === 0) return undefined;
  const functionDeclarations = tools.map(convertLionToolToGoogleFunctionDeclaration);
  return [{ functionDeclarations }];
}
