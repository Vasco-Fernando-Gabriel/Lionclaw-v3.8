
import { describe, it, expect } from 'vitest';
import {
  CURSOR_MODELS,
  clampCursorEffort,
  clampCursorEffortForModel,
  cursorEffortTiersForModel,
} from '../../../src/constants/cursor-models';

describe('mapa de effort por modelo do catalogo Cursor', () => {
  it('nenhum modelo do snapshot 1.0.30 anuncia tiers (effort explicito = fatal no adapter)', () => {
    for (const model of CURSOR_MODELS) {
      expect(cursorEffortTiersForModel(model.slug)).toEqual([]);
      expect(clampCursorEffortForModel('high', model.slug)).toBeNull();
    }
  });

  it('modelo fora do snapshot (id do catalogo vivo) tambem nao anuncia tiers (fail-closed)', () => {
    expect(cursorEffortTiersForModel('novo-modelo-live')).toEqual([]);
    expect(clampCursorEffortForModel('medium', 'novo-modelo-live')).toBeNull();
  });
});

describe('clampCursorEffort (nucleo puro, pronto para tiers futuros)', () => {
  it('sem tiers -> null (nunca clamp/descarte silencioso)', () => {
    expect(clampCursorEffort('high', [])).toBeNull();
  });

  it('tier pedido suportado passa identico', () => {
    expect(clampCursorEffort('medium', ['low', 'medium', 'high'])).toBe('medium');
  });

  it('pedido acima do teto clampa ao maior suportado <= pedido', () => {
    expect(clampCursorEffort('xhigh', ['low', 'medium', 'high'])).toBe('high');
    expect(clampCursorEffort('high', ['low', 'medium'])).toBe('medium');
  });

  it('aliases largos max/ultra equivalem a xhigh', () => {
    expect(clampCursorEffort('max', ['low', 'high'])).toBe('high');
    expect(clampCursorEffort('ultra', ['low', 'medium'])).toBe('medium');
  });

  it('pedido abaixo do piso sobe ao menor tier suportado', () => {
    expect(clampCursorEffort('low', ['medium', 'high'])).toBe('medium');
  });

  it('ordem de declaracao dos tiers nao muda o veredito', () => {
    expect(clampCursorEffort('high', ['xhigh', 'low', 'medium'])).toBe('medium');
  });
});
