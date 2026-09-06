
import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';

vi.mock('../paths', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  const fs = await import('node:fs');
  const dir = path.join(os.tmpdir(), 'lionclaw-sb1-logger-serializers-test');
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  return { getLionClawHome: () => dir };
});

import { errorSerializers, rootLogger, createLogger } from '../logger';

interface LogLine {
  msg?: string;
  err?: unknown;
  error?: unknown;
  reason?: unknown;
  [key: string]: unknown;
}

function makeMemoryLogger(): { logger: pino.Logger; lines: () => LogLine[] } {
  const raw: string[] = [];
  const stream: pino.DestinationStream = {
    write(msg: string) {
      raw.push(msg);
    },
  };
  const logger = pino({ level: 'debug', serializers: errorSerializers }, stream);
  return {
    logger,
    lines: () => raw.map((l) => JSON.parse(l) as LogLine),
  };
}

function asSerializedError(value: unknown): { message: string; stack: string; type: string } {
  expect(value).toBeTypeOf('object');
  const obj = value as { message?: unknown; stack?: unknown; type?: unknown };
  expect(typeof obj.message).toBe('string');
  expect(typeof obj.stack).toBe('string');
  return obj as { message: string; stack: string; type: string };
}

describe('SB-1 — serializer do pino (logger.ts)', () => {
  it('AC-B1: logger.error({ error: new Error("x") }) loga message + stack (nao {})', () => {
    const { logger, lines } = makeMemoryLogger();
    logger.error({ error: new Error('x') }, 'boom');

    const [line] = lines();
    const err = asSerializedError(line.error);
    expect(err.message).toBe('x');
    expect(err.stack).toContain('Error: x');
    expect(line.error).not.toEqual({});
  });

  it('AC-B1: idem para a chave err', () => {
    const { logger, lines } = makeMemoryLogger();
    logger.error({ err: new Error('falha err') });

    const [line] = lines();
    const err = asSerializedError(line.err);
    expect(err.message).toBe('falha err');
    expect(err.stack).toContain('Error: falha err');
  });

  it('AC-B1: idem para a chave reason', () => {
    const { logger, lines } = makeMemoryLogger();
    logger.error({ reason: new Error('falha reason') });

    const [line] = lines();
    const err = asSerializedError(line.reason);
    expect(err.message).toBe('falha reason');
    expect(err.stack).toContain('Error: falha reason');
  });

  it('AC-B1: subclasse de Error (cause preservada no message/stack encadeado)', () => {
    class CustomError extends Error {
      constructor(msg: string, opts?: { cause?: unknown }) {
        super(msg, opts);
        this.name = 'CustomError';
      }
    }
    const { logger, lines } = makeMemoryLogger();
    logger.error({ error: new CustomError('outer', { cause: new Error('inner') }) });

    const [line] = lines();
    const err = asSerializedError(line.error);
    expect(err.message).toContain('outer');
    expect(err.message).toContain('inner');
    expect(err.type).toBe('CustomError');
  });

  it('AC-B2: string pre-stringificada sob error permanece intacta (padrao memory-pipeline)', () => {
    const { logger, lines } = makeMemoryLogger();
    logger.error({ error: 'quota exceeded (pre-stringificada)' }, 'compaction failed');

    const [line] = lines();
    expect(line.error).toBe('quota exceeded (pre-stringificada)');
  });

  it('AC-B2: string sob err e sob reason permanecem intactas', () => {
    const { logger, lines } = makeMemoryLogger();
    logger.error({ err: 'so uma string' });
    logger.error({ reason: 'motivo string' });

    const [first, second] = lines();
    expect(first.err).toBe('so uma string');
    expect(second.reason).toBe('motivo string');
  });

  it('AC-B2: objetos nao error-like sob error passam intactos (zero regressao)', () => {
    const { logger, lines } = makeMemoryLogger();
    logger.error({ error: { code: 42, detail: 'plain object' } });

    const [line] = lines();
    expect(line.error).toEqual({ code: 42, detail: 'plain object' });
  });

  it('AC-B3: shape do handler de uncaughtException (index.ts) loga stack', () => {
    const { logger, lines } = makeMemoryLogger();
    const err = new Error('crash sem catch');
    logger.error({ err }, 'Uncaught exception in main process');

    const [line] = lines();
    const serialized = asSerializedError(line.err);
    expect(serialized.stack).toContain('Error: crash sem catch');
    expect(line.msg).toBe('Uncaught exception in main process');
  });

  it('AC-B3: shape do handler de unhandledRejection (index.ts, {reason}) loga stack', () => {
    const { logger, lines } = makeMemoryLogger();
    const reason = new Error('rejeicao sem handler');
    logger.error({ reason }, 'Unhandled promise rejection in main process');

    const [line] = lines();
    const serialized = asSerializedError(line.reason);
    expect(serialized.stack).toContain('Error: rejeicao sem handler');
  });

  it('AC-B3: rejeicao com reason NAO-Error (string) continua logada sem transformacao', () => {
    const { logger, lines } = makeMemoryLogger();
    logger.error({ reason: 'rejected with a string' }, 'Unhandled promise rejection in main process');

    const [line] = lines();
    expect(line.reason).toBe('rejected with a string');
  });

  it('AC-B1/B3: rootLogger real registra os serializers err/error/reason (herdados pelos child loggers de index.ts)', () => {
    const serializersSym = (pino as unknown as { symbols: { serializersSym: symbol } }).symbols
      .serializersSym;
    const registered = (rootLogger as unknown as Record<symbol, Record<string, unknown>>)[
      serializersSym
    ];
    expect(registered.err).toBe(pino.stdSerializers.err);
    expect(registered.error).toBe(pino.stdSerializers.err);
    expect(registered.reason).toBe(pino.stdSerializers.err);

    const child = createLogger('main');
    const childRegistered = (child as unknown as Record<symbol, Record<string, unknown>>)[
      serializersSym
    ];
    expect(childRegistered.err).toBe(pino.stdSerializers.err);
    expect(childRegistered.error).toBe(pino.stdSerializers.err);
    expect(childRegistered.reason).toBe(pino.stdSerializers.err);
  });
});
