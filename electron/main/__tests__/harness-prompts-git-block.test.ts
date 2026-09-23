import { describe, it, expect } from 'vitest';
import { appendGitRestrictionsToPrompt, GIT_RESTRICTIONS_BLOCK } from '../harness-prompts';

describe('appendGitRestrictionsToPrompt', () => {
  it('appends the git block when not present', () => {
    const base = 'Voce e um desenvolvedor implementando a sprint "Sprint 1" de um projeto.';
    const result = appendGitRestrictionsToPrompt(base);
    expect(result).toContain('Restricoes git (CRITICO)');
    expect(result).toContain('git commit (em qualquer forma)');
    expect(result).toContain('git push (em qualquer forma)');
    expect(result).toContain('git status, git diff, git log');
  });

  it('is idempotent: applying twice does not duplicate the block', () => {
    const base = 'Voce e um desenvolvedor.';
    const once = appendGitRestrictionsToPrompt(base);
    const twice = appendGitRestrictionsToPrompt(once);
    expect(twice).toBe(once);

    const occurrences = (twice.match(/Restricoes git \(CRITICO\)/g) ?? []).length;
    expect(occurrences).toBe(1);
  });

  it('does not alter a prompt that already contains the block', () => {
    const withBlock = 'Intro.\n\n' + GIT_RESTRICTIONS_BLOCK.trim() + '\n';
    const result = appendGitRestrictionsToPrompt(withBlock);
    expect(result).toBe(withBlock);
  });

  it('preserves the original prompt content before the block', () => {
    const base = 'Linha 1.\nLinha 2.';
    const result = appendGitRestrictionsToPrompt(base);
    expect(result.startsWith('Linha 1.\nLinha 2.')).toBe(true);
  });

  it('GIT_RESTRICTIONS_BLOCK export contains all forbidden commands', () => {
    expect(GIT_RESTRICTIONS_BLOCK).toContain('git commit');
    expect(GIT_RESTRICTIONS_BLOCK).toContain('git push');
    expect(GIT_RESTRICTIONS_BLOCK).toContain('git reset');
    expect(GIT_RESTRICTIONS_BLOCK).toContain('git rebase');
    expect(GIT_RESTRICTIONS_BLOCK).toContain('git merge');
    expect(GIT_RESTRICTIONS_BLOCK).toContain('git rm');
    expect(GIT_RESTRICTIONS_BLOCK).toContain('git stash drop');
    expect(GIT_RESTRICTIONS_BLOCK).toContain('git tag');
    expect(GIT_RESTRICTIONS_BLOCK).toContain('git remote add/set-url');
    expect(GIT_RESTRICTIONS_BLOCK).toContain('--force');
  });
});

describe('harness systemPromptTransform integration', () => {
  it('custom coder systemPrompt without block receives git restrictions via transform', () => {
    const customCoderSystemPrompt = 'Voce e um desenvolvedor senior especializado em React e TypeScript.';

    const finalSystemPrompt = appendGitRestrictionsToPrompt(customCoderSystemPrompt);

    expect(finalSystemPrompt).toContain('Restricoes git (CRITICO)');
    expect(finalSystemPrompt).toContain('git commit');
    expect(finalSystemPrompt).toContain('git push');
    expect(finalSystemPrompt).toContain('Voce e um desenvolvedor senior especializado em React e TypeScript.');
  });

  it('custom coder systemPrompt with RULES.md prefix receives git restrictions', () => {
    const rulesContent = '# Regras do Agente\n- Sempre escreva em portugues.\n';
    const agentSystemPrompt = 'Voce e um coder de backend.';
    const resolvedSystemPrompt = rulesContent + '\n\n' + agentSystemPrompt;

    const finalSystemPrompt = appendGitRestrictionsToPrompt(resolvedSystemPrompt);

    expect(finalSystemPrompt).toContain('Restricoes git (CRITICO)');
    expect(finalSystemPrompt).toContain('Regras do Agente');
    expect(finalSystemPrompt).toContain('coder de backend');
  });

  it('seed coder systemPrompt that already contains the block is not duplicated', () => {
    const seedCoderPrompt = appendGitRestrictionsToPrompt('Voce e o coder seed original.');

    const finalSystemPrompt = appendGitRestrictionsToPrompt(seedCoderPrompt);

    const occurrences = (finalSystemPrompt.match(/Restricoes git \(CRITICO\)/g) ?? []).length;
    expect(occurrences).toBe(1);
  });
});
