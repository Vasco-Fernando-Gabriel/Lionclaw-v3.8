import fs from 'fs';
import path from 'path';
import { jsonrepair } from 'jsonrepair';
import { createLogger } from './logger';
import { extractBalancedJsonObjectCandidates } from './json-extractor';
import type { EvaluationResult, EvaluationCriterion } from '../../src/types';
import type { SprintJsonEntry } from './harness-planner';

const logger = createLogger('harness-evaluator');

export function buildEvaluatorPrompt(sprintJson: SprintJsonEntry, projectPath: string, specPath: string): string {
  const criteriaBlock = sprintJson.features
    .map((f) => {
      const criteria = f.acceptance_criteria.map((c, i) => `  - ${f.id}-c${i + 1}: "${c}"`).join('\n');
      return `### ${f.name} (${f.id})\n${f.description}\n\nCriterios:\n${criteria}`;
    })
    .join('\n\n');

  return `## Diretorio do Projeto
${projectPath}

## Caminho da SPEC (use este caminho exato — NAO procure por SPEC.md no root)
${specPath}

## Sprint: ${sprintJson.name}
${sprintJson.description}

## Features e Criterios de Aceite
${criteriaBlock}

## Formato OBRIGATORIO do output (JSON puro, sem markdown, sem code blocks)

{
  "sprint_id": "${sprintJson.id}",
  "verdict": "pass" | "fail",
  "criteria": [
    {
      "id": "feat-001-c1",
      "feature_id": "feat-001",
      "description": "descricao curta do criterio",
      "result": "pass" | "fail",
      "justification": "explicacao concreta (arquivo, linha, comportamento)"
    }
  ],
  "summary": "resumo da avaliacao"
}

REGRAS DO SCHEMA:
- Use EXATAMENTE "result" (nao "verdict") dentro de cada item de "criteria".
- "verdict" so aparece no nivel raiz do JSON.
- O "verdict" raiz so e "pass" se TODOS os itens de "criteria" tiverem "result": "pass".
- Inclua "feature_id" em cada criterio (ex: "feat-001-c1" pertence a "feat-001").`;
}

export function parseEvaluationOutput(
  rawOutput: string,
  roundNumber: number,
  outMeta?: { repaired?: boolean },
): EvaluationResult {
  let jsonStr = rawOutput.trim();

  if (!jsonStr) {
    throw new Error(
      'Evaluator returned empty output. The agent may have only used tools without producing a final JSON response.',
    );
  }

  const jsonBlockMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (jsonBlockMatch) {
    jsonStr = jsonBlockMatch[1].trim();
  }

  const candidates = extractBalancedJsonObjectCandidates(jsonStr);
  if (candidates.length === 0) {
    throw new Error(
      `Evaluator output contains no JSON object. Raw output (first 500 chars): ${rawOutput.slice(0, 500)}`,
    );
  }

  let parsed: Record<string, unknown> | null = null;
  let parseError: Error | null = null;

  for (let ci = candidates.length - 1; ci >= 0; ci--) {
    const candidate = candidates[ci];
    let attemptParsed: Record<string, unknown> | null = null;

    try {
      attemptParsed = JSON.parse(candidate) as Record<string, unknown>;
    } catch {
      try {
        const sanitized = candidate.replace(/\\(?!["\\/bfnrtu])/g, '\\\\');
        attemptParsed = JSON.parse(sanitized) as Record<string, unknown>;
      } catch {
        try {
          const repaired = jsonrepair(candidate);
          attemptParsed = JSON.parse(repaired) as Record<string, unknown>;
          if (outMeta) outMeta.repaired = true;
          logger.warn({ round: roundNumber }, 'JSON parsed via jsonrepair (3rd-layer fallback)');
        } catch (e3) {
          parseError = e3 as Error;
          continue;
        }
      }
    }

    if (
      attemptParsed &&
      attemptParsed['sprint_id'] &&
      attemptParsed['verdict'] &&
      Array.isArray(attemptParsed['criteria'])
    ) {
      parsed = attemptParsed;
      break;
    }

    parseError = new Error(`Candidate at index ${ci} parsed but missing sprint_id/verdict/criteria`);
  }

  if (!parsed) {
    throw new Error(
      `Evaluator output contains no valid JSON with sprint_id, verdict, and criteria. ` +
        `Last error: ${parseError?.message ?? 'unknown'}. ` +
        `Raw output (first 500 chars): ${rawOutput.slice(0, 500)}`,
    );
  }

  const deriveFeatureId = (id: string): string => {
    const match = id.match(/^(.+)-c\d+$/);
    return match ? match[1] : '';
  };

  let sawCriterionVerdictFallback = false;
  const criteria: EvaluationCriterion[] = (parsed['criteria'] as Array<Record<string, unknown>>).map((c) => {
    const id = (c['id'] as string) || '';
    const rawOutcome = (c['result'] ?? c['verdict']) as 'pass' | 'fail' | undefined;
    if (c['result'] === undefined && c['verdict'] !== undefined) {
      sawCriterionVerdictFallback = true;
    }
    return {
      id,
      featureId: (c['feature_id'] as string) || deriveFeatureId(id),
      description: (c['description'] as string) || '',
      result: rawOutcome === 'pass' || rawOutcome === 'fail' ? rawOutcome : 'fail',
      justification: (c['justification'] as string) || '',
    };
  });

  if (sawCriterionVerdictFallback) {
    logger.warn(
      { sprintId: parsed['sprint_id'], round: roundNumber },
      'Evaluator used "verdict" instead of "result" at criterion level - parser accepted both, but prompt/schema may be drifting.',
    );
  }

  const allPass = criteria.every((c) => c.result === 'pass');
  const verdict: 'pass' | 'fail' = allPass ? 'pass' : 'fail';

  return {
    sprintId: parsed['sprint_id'] as string,
    round: roundNumber,
    verdict,
    criteria,
    summary: (parsed['summary'] as string) || '',
    timestamp: new Date().toISOString(),
  };
}

export function validateCriteria(evaluation: EvaluationResult, sprintJson: SprintJsonEntry): EvaluationResult {
  const validIds = new Set<string>();
  for (const feature of sprintJson.features) {
    feature.acceptance_criteria.forEach((_, i) => {
      validIds.add(`${feature.id}-c${i + 1}`);
    });
  }

  const validCriteria: EvaluationCriterion[] = [];
  for (const criterion of evaluation.criteria) {
    if (validIds.has(criterion.id)) {
      validCriteria.push(criterion);
    } else {
      logger.warn(
        { criterionId: criterion.id, sprintId: evaluation.sprintId },
        'Evaluator invented criterion - ignoring',
      );
    }
  }

  const allPass = validCriteria.length > 0 && validCriteria.every((c) => c.result === 'pass');

  return {
    ...evaluation,
    criteria: validCriteria,
    verdict: allPass ? 'pass' : 'fail',
  };
}

export function updateSpecProgress(
  projectPath: string,
  projectName: string,
  sprintJson: SprintJsonEntry,
  totalSprints: number,
  completedCount: number,
): void {
  const specProgressPath = path.join(projectPath, 'SPEC_PROGRESS.md');

  let content: string;
  if (fs.existsSync(specProgressPath)) {
    content = fs.readFileSync(specProgressPath, 'utf-8');
  } else {
    content = `# SPEC_PROGRESS - ${projectName}\n\n## Status: 0/${totalSprints} sprints concluidas\nUltima atualizacao: ${new Date().toISOString()}\n\n---\n`;
  }

  content = content.replace(
    /## Status: \d+\/\d+ sprints concluidas/,
    `## Status: ${completedCount}/${totalSprints} sprints concluidas`,
  );
  content = content.replace(/Ultima atualizacao: .*/, `Ultima atualizacao: ${new Date().toISOString()}`);

  const features = sprintJson.features.map((f) => `- ${f.name}: ${f.description}`).join('\n');
  const sprintEntry = `\n## Sprint ${String(sprintJson.index + 1).padStart(3, '0')} - ${sprintJson.name} [CONCLUIDA]\n${features}\n`;

  content += sprintEntry;

  fs.writeFileSync(specProgressPath, content, 'utf-8');
  logger.info({ projectPath, sprint: sprintJson.name }, 'SPEC_PROGRESS.md updated');
}

export function buildFeedbackFromEvaluation(evaluation: EvaluationResult): string {
  const failedCriteria = evaluation.criteria.filter((c) => c.result === 'fail');
  if (failedCriteria.length === 0) return '';

  const lines = failedCriteria.map((c) => `- [FAIL] ${c.description}: ${c.justification}`).join('\n');

  return `${evaluation.summary}\n\nCriterios que falharam:\n${lines}`;
}
