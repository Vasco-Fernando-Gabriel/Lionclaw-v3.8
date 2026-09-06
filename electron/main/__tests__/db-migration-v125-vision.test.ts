
import { describe, it, expect, vi } from 'vitest';
import { applyMigrationV125, __V125_INTERNAL } from '../db-migrations/v125-vision-settings';
import { VISION_DEFAULT } from '../../../src/constants/vision-models';

describe('applyMigrationV125 - estrutural', () => {
  it('exporta applyMigrationV125 como funcao', () => {
    expect(typeof applyMigrationV125).toBe('function');
  });

  it('os defaults saem do catalogo (VISION_DEFAULT), sem literal proprio', () => {
    expect(__V125_INTERNAL.VISION_DEFAULTS).toContainEqual(['vision_provider', VISION_DEFAULT.provider]);
    expect(__V125_INTERNAL.VISION_DEFAULTS).toContainEqual(['vision_model', VISION_DEFAULT.id]);
  });
});

describe('applyMigrationV125 - mock DB', () => {
  it('usa INSERT OR IGNORE (customizacao do usuario sobrevive)', () => {
    const run = vi.fn();
    const prepare = vi.fn(() => ({ run }));
    const transaction = vi.fn((fn: (rows: ReadonlyArray<readonly [string, string]>) => void) => fn);
    const mockDb = { prepare, transaction } as unknown as import('better-sqlite3').Database;

    applyMigrationV125(mockDb);

    expect(prepare).toHaveBeenCalledWith(expect.stringMatching(/INSERT\s+OR\s+IGNORE/i));
    expect(run).toHaveBeenCalledWith('vision_provider', VISION_DEFAULT.provider);
    expect(run).toHaveBeenCalledWith('vision_model', VISION_DEFAULT.id);
  });

  it('idempotente: chamar duas vezes so re-emite os mesmos INSERT OR IGNORE', () => {
    const run = vi.fn();
    const prepare = vi.fn(() => ({ run }));
    const transaction = vi.fn((fn: (rows: ReadonlyArray<readonly [string, string]>) => void) => fn);
    const mockDb = { prepare, transaction } as unknown as import('better-sqlite3').Database;

    applyMigrationV125(mockDb);
    applyMigrationV125(mockDb);

    expect(run).toHaveBeenCalledTimes(4);
  });
});
