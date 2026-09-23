import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

const orchestratorPath = path.resolve(__dirname, '../orchestrator.ts');
const source = readFileSync(orchestratorPath, 'utf-8');

describe('I7/W3 — orquestrador nao envia thinking (envia effort)', () => {
  it('orchestrator.ts envia effort nas options do query() (orchestratorEffort)', () => {
    expect(source).toMatch(/effort:\s*orchestratorEffort/);
  });

  it('orchestrator.ts NAO contem nenhuma propriedade `thinking:` (protecao Fable 5)', () => {
    expect(source).not.toMatch(/['"]?\bthinking\b['"]?\s*:/);
  });

  it('orchestrator.ts nao monta thinking indireto via budgetTokens/thinkingBudget', () => {
    expect(source).not.toMatch(/budgetTokens/);
    expect(source).not.toMatch(/thinkingBudget/);
  });
});
