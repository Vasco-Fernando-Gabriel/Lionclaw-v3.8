
import { describe, it, expect } from 'vitest';
import { Type } from '@google/genai';
import {
  buildGoogleToolConfig,
  convertJsonSchemaToGoogleSchema,
  convertLionToolToGoogleFunctionDeclaration,
  toGoogleSafeName,
} from '../google-genai-schema';
import { LION_TOOL_SCHEMAS } from '../../tool-registry';

describe('google-genai-schema', () => {
  describe('convertLionToolToGoogleFunctionDeclaration', () => {
    it('converts every LION_TOOL_SCHEMA entry without throwing', () => {
      for (const tool of LION_TOOL_SCHEMAS) {
        const decl = convertLionToolToGoogleFunctionDeclaration(tool);
        expect(decl.name).toBe(tool.name);
        expect(decl.parameters).toBeDefined();
        expect(decl.parameters?.type).toBe(Type.OBJECT);
      }
    });

    it('preserves description when present', () => {
      const tool = LION_TOOL_SCHEMAS.find((t) => t.name === 'Read');
      expect(tool).toBeDefined();
      const decl = convertLionToolToGoogleFunctionDeclaration(tool!);
      expect(decl.description).toBe(tool!.description);
    });
  });

  describe('convertJsonSchemaToGoogleSchema (recursion)', () => {
    it('TodoWrite preserves nested array -> object -> properties', () => {
      const todoWrite = LION_TOOL_SCHEMAS.find((t) => t.name === 'TodoWrite');
      expect(todoWrite).toBeDefined();
      const converted = convertJsonSchemaToGoogleSchema(todoWrite!.input_schema);
      expect(converted.type).toBe(Type.OBJECT);
      const todosProp = converted.properties?.todos;
      expect(todosProp).toBeDefined();
      expect(todosProp?.type).toBe(Type.ARRAY);
      expect(todosProp?.items?.type).toBe(Type.OBJECT);
      const idProp = todosProp?.items?.properties?.id;
      expect(idProp?.type).toBe(Type.STRING);
      const statusProp = todosProp?.items?.properties?.status;
      expect(statusProp?.type).toBe(Type.STRING);
      expect(statusProp?.enum).toEqual(['pending', 'in_progress', 'completed']);
    });

    it('AskUserQuestion preserves array -> object -> array -> object', () => {
      const ask = LION_TOOL_SCHEMAS.find((t) => t.name === 'AskUserQuestion');
      expect(ask).toBeDefined();
      const converted = convertJsonSchemaToGoogleSchema(ask!.input_schema);
      expect(converted.type).toBe(Type.OBJECT);
      const questions = converted.properties?.questions;
      expect(questions?.type).toBe(Type.ARRAY);
      const questionItem = questions?.items;
      expect(questionItem?.type).toBe(Type.OBJECT);
      const options = questionItem?.properties?.options;
      expect(options?.type).toBe(Type.ARRAY);
      const optionItem = options?.items;
      expect(optionItem?.type).toBe(Type.OBJECT);
      expect(optionItem?.properties?.label?.type).toBe(Type.STRING);
    });

    it('strips unsupported JSON Schema fields', () => {
      const input = {
        type: 'object',
        description: 'kept',
        properties: { x: { type: 'string' } },
        required: ['x'],
        $id: 'should-be-stripped',
        $ref: '#/definitions/foo',
        format: 'date-time',
        minimum: 0,
        maximum: 100,
        oneOf: [{ type: 'string' }],
        additionalProperties: false,
      };
      const converted = convertJsonSchemaToGoogleSchema(input);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const out = converted as any;
      expect(out.$id).toBeUndefined();
      expect(out.$ref).toBeUndefined();
      expect(out.format).toBeUndefined();
      expect(out.minimum).toBeUndefined();
      expect(out.maximum).toBeUndefined();
      expect(out.oneOf).toBeUndefined();
      expect(out.additionalProperties).toBeUndefined();
      expect(converted.description).toBe('kept');
    });

    it('handles each primitive JSON Schema type', () => {
      const cases: Array<[string, Type]> = [
        ['string', Type.STRING],
        ['number', Type.NUMBER],
        ['integer', Type.INTEGER],
        ['boolean', Type.BOOLEAN],
        ['array', Type.ARRAY],
        ['object', Type.OBJECT],
      ];
      for (const [jsonType, googleType] of cases) {
        const converted = convertJsonSchemaToGoogleSchema({ type: jsonType });
        expect(converted.type).toBe(googleType);
      }
    });

    it('treats non-object schema as empty', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(convertJsonSchemaToGoogleSchema(null as any)).toEqual({});
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(convertJsonSchemaToGoogleSchema(true as any)).toEqual({});
    });
  });

  describe('buildGoogleToolConfig', () => {
    it('returns undefined for undefined tools', () => {
      expect(buildGoogleToolConfig(undefined)).toBeUndefined();
    });

    it('returns undefined for empty array (must NOT return [])', () => {
      expect(buildGoogleToolConfig([])).toBeUndefined();
    });

    it('returns single tool with functionDeclarations when tools present', () => {
      const result = buildGoogleToolConfig(LION_TOOL_SCHEMAS);
      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
      expect(result?.length).toBe(1);
      const firstTool = result![0];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const decls = (firstTool as any).functionDeclarations;
      expect(Array.isArray(decls)).toBe(true);
      expect(decls.length).toBe(LION_TOOL_SCHEMAS.length);
    });
  });

  describe('toGoogleSafeName', () => {
    it('returns the input name unchanged (passthrough today)', () => {
      expect(toGoogleSafeName('Read')).toBe('Read');
      expect(toGoogleSafeName('TodoWrite')).toBe('TodoWrite');
      expect(toGoogleSafeName('AskUserQuestion')).toBe('AskUserQuestion');
      expect(toGoogleSafeName('memory_search')).toBe('memory_search');
      expect(toGoogleSafeName('mcp_call')).toBe('mcp_call');
    });
  });
});
