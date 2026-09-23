import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const orchestratorSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'orchestrator.ts'), 'utf-8');

describe('AC-B4b [INV] — turno vazio do orquestrador (path D6)', () => {
  it('AC-B4b: caminho de sucesso preserva limpeza, persistencia e conclusao do turno', () => {
    const branchStart = orchestratorSrc.indexOf('    if (assistantContent) {');
    const emptyBranchStart = orchestratorSrc.indexOf('    } else if (', branchStart);
    expect(branchStart).toBeGreaterThan(-1);
    expect(emptyBranchStart).toBeGreaterThan(branchStart);
    const happyPath = orchestratorSrc.slice(branchStart, emptyBranchStart);
    expect(happyPath).toContain('extractAndProcessOnboardingData(assistantContent');
    expect(happyPath).toContain('toolCalls: persistedTimelineToolCalls');
    expect(happyPath).toContain(
      "insertMessage(sessionId, 'assistant', assistantContent, options.agentId, messageMetadata);",
    );
    expect(happyPath).toContain('recordCompletedMainChatTurn(sessionId, getWindow);');
    expect(happyPath.indexOf('insertMessage(')).toBeLessThan(happyPath.indexOf('recordCompletedMainChatTurn('));
  });

  it('AC-B4b: o else usa isEmptyFailedTurn (assistantContent + outputTokens + artifacts) e emite LLM-EMPTY', () => {
    expect(orchestratorSrc).toContain('isEmptyFailedTurn({');
    expect(orchestratorSrc).toContain('outputTokens: totalOutputTokens,');
    expect(orchestratorSrc).toContain('artifactCount: collectedArtifacts.length,');
    expect(orchestratorSrc).toContain(
      "sendSessionStream({ type: 'error', code: emptyTurnError.code, error: emptyTurnError.userMessage });",
    );
    expect(orchestratorSrc).toContain("buildExecutionError('LLM-EMPTY'");
  });

  it('AC-B4b: o branch NAO aborta o ciclo do turno (sem return/throw dentro do else)', () => {
    const start = orchestratorSrc.indexOf('isEmptyFailedTurn({');
    expect(start).toBeGreaterThan(-1);
    const branch = orchestratorSrc.slice(
      start,
      orchestratorSrc.indexOf(
        '}',
        orchestratorSrc.indexOf("sendSessionStream({ type: 'error', code: emptyTurnError.code", start),
      ),
    );
    expect(branch).not.toContain('return');
    expect(branch).not.toContain('throw');
  });

  it('AC-B4b: reusa o canal existente — nenhum campo `empty` novo em StreamChunk', () => {
    const typesSrc = fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', 'src', 'types', 'index.ts'), 'utf-8');
    const streamChunkBlock = typesSrc.slice(
      typesSrc.indexOf('export interface StreamChunk {'),
      typesSrc.indexOf('export interface ArtifactData {'),
    );
    expect(streamChunkBlock).toContain('code?: string;');
    expect(streamChunkBlock).not.toMatch(/\bempty\??:/);
  });
});
