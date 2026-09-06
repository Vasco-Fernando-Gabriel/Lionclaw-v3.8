import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { jsonrepair } from 'jsonrepair';
import { createLogger } from './logger';
import { extractBalancedJsonObjectCandidates, unwrapKnownJsonWrappers } from './json-extractor';
import {
  replaceHarnessSprintsForProject,
  updateHarnessPendingSprintsFromReseed,
  mergeHarnessProjectSprintJsonHashes,
  countHarnessRoundsForProject,
  getHarnessSprints,
  getHarnessProject,
  getAllAgents,
} from './db';
import { canonicalJsonStringify } from './canonical-json';
import type { AgentConfig, HarnessProject, HarnessSprint } from '../../src/types';
import {
  findHarnessSprintsReadPath,
  findLegacyHarnessSprintsPath,
  resolveHarnessSprintsPath,
  resolveHarnessSprintsReadPath,
} from './pipeline-paths';

const logger = createLogger('harness-planner');

export interface SprintsJson {
  project: {
    id: string;
    name: string;
    description: string;
    path: string;
    stack: string[];
    config: {
      max_rounds_per_sprint: number;
      use_playwright: boolean;
      evaluator_agent_id: string;
      planner_agent_id: string;
    };
  };
  sprints: SprintJsonEntry[];
  metadata: {
    version: number;
    created_at: string;
    total_sprints: number;
    total_features: number;
  };
}

export interface SprintJsonEntry {
  id: string;
  index: number;
  name: string;
  description: string;
  coder_agent_id: string;
  stack: string[];
  features: SprintFeature[];
  hints: {
    existing_files: string[];
    key_interfaces: string[];
    architecture_notes: string;
  };
  dependencies: string[];
  complexity: 'low' | 'medium' | 'high';
  estimated_rounds: number;
  metadata?: {
    touchesUI: boolean;
    affectedScreenIds: string[];
    affectedComponentIds: string[];
    designArtifactPath?: string;
  };
}

export interface SprintFeature {
  id: string;
  name: string;
  description: string;
  acceptance_criteria: string[];
}

export function buildPlannerPrompt(
  specContent: string,
  project: HarnessProject,
  agents: AgentConfig[],
): string {
  const agentList = agents
    .filter(a => a.isActive && !['harness-coder', 'harness-evaluator', 'harness-planner'].includes(a.id))
    .map(a => `- ${a.name} (ID: ${a.id}): ${a.description}`)
    .join('\n');

  return `## Spec do Projeto
${specContent}

## Agentes Disponiveis (Coders)
${agentList}

## Regras de Selecao de Agente

1. O campo coder_agent_id DEVE conter o ID exato de um dos agentes listados acima
2. React / Next.js / Frontend / UI -> nextjs-developer ou frontend-developer
3. Node.js / API / Backend / Express / Fastify -> backend-developer
4. Electron / Desktop -> electron-pro
5. JavaScript generico / utilitarios -> javascript-pro
6. Quando em duvida, escolha o especialista mais proximo da stack da sprint. NUNCA use harness-coder

## Dados do Projeto
- ID: ${project.id}
- Nome: ${project.name}
- Descricao: ${project.description ?? ''}
- Path: ${project.projectPath}
- Stack: ${JSON.stringify(project.config.stack)}
- Max rounds por sprint: ${project.config.maxRoundsPerSprint}
- Playwright: ${project.config.usePlaywright}
- evaluator_agent_id: "${project.config.evaluatorAgentId}"
- planner_agent_id: "${project.config.plannerAgentId}"
- created_at: "${new Date().toISOString()}"

## Formato de Output
Responda com JSON puro no seguinte schema (preencha com os dados reais das sprints):

{
  "project": {
    "id": "${project.id}",
    "name": "${project.name}",
    "description": "${project.description ?? ''}",
    "path": "${project.projectPath}",
    "stack": ${JSON.stringify(project.config.stack)},
    "config": {
      "max_rounds_per_sprint": ${project.config.maxRoundsPerSprint},
      "use_playwright": ${project.config.usePlaywright},
      "evaluator_agent_id": "${project.config.evaluatorAgentId}",
      "planner_agent_id": "${project.config.plannerAgentId}"
    }
  },
  "sprints": [
    {
      "id": "sprint-001",
      "index": 0,
      "name": "Nome da Sprint",
      "description": "Descricao do que sera implementado",
      "coder_agent_id": "id-do-agente",
      "stack": ["tech1", "tech2"],
      "features": [
        {
          "id": "feat-001",
          "name": "Nome da Feature",
          "description": "O que sera implementado",
          "acceptance_criteria": [
            "Criterio verificavel 1",
            "Criterio verificavel 2"
          ]
        }
      ],
      "hints": {
        "existing_files": [],
        "key_interfaces": [],
        "architecture_notes": ""
      },
      "dependencies": [],
      "complexity": "low",
      "estimated_rounds": 1
    }
  ],
  "metadata": {
    "version": 1,
    "created_at": "${new Date().toISOString()}",
    "total_sprints": 0,
    "total_features": 0
  }
}`;
}

export function parsePlannerOutput(
  rawOutput: string,
  outMeta?: { repaired?: boolean },
  validAgentIds?: { coderIds: Set<string>; evaluatorIds: Set<string> },
): SprintsJson {
  const candidates = extractBalancedJsonObjectCandidates(rawOutput);
  if (candidates.length === 0) {
    const preview = rawOutput.slice(0, 200).replace(/\n/g, ' ');
    throw new Error(
      `Planner nao retornou JSON valido. Inicio da resposta: "${preview}..."`,
    );
  }

  let parsed: SprintsJson | null = null;
  let lastCandidateError: Error | null = null;

  for (let ci = candidates.length - 1; ci >= 0; ci--) {
    const candidate = candidates[ci]!;
    let parsedRaw: unknown;
    try {
      parsedRaw = JSON.parse(candidate);
    } catch (e1) {
      try {
        const repaired = jsonrepair(candidate);
        parsedRaw = JSON.parse(repaired);
        if (outMeta) outMeta.repaired = true;
        logger.warn(
          { originalError: (e1 as Error).message, candidateIndex: ci },
          'Planner JSON parsed via jsonrepair (fallback)',
        );
      } catch (repairErr) {
        lastCandidateError = new Error(
          `Planner output is not valid JSON. ` +
          `Original error: ${(e1 as Error).message}. ` +
          `Repair error: ${(repairErr as Error).message}. ` +
          `Candidate (first 200 chars): ${candidate.slice(0, 200)}`,
        );
        continue;
      }
    }

    const unwrapped = unwrapKnownJsonWrappers(parsedRaw);
    const candidate_parsed = unwrapped as SprintsJson;

    if (!candidate_parsed?.project) {
      lastCandidateError = new Error(
        `Missing "project" in planner output (candidate index ${ci}).`,
      );
      continue;
    }
    if (!Array.isArray(candidate_parsed.sprints)) {
      lastCandidateError = new Error(
        `Missing "sprints" array in planner output (candidate index ${ci}).`,
      );
      continue;
    }
    if (candidate_parsed.sprints.length === 0) {
      lastCandidateError = new Error(
        `Planner generated 0 sprints (candidate index ${ci}).`,
      );
      continue;
    }
    parsed = candidate_parsed;
    break;
  }

  if (!parsed) {
    const preview = rawOutput.slice(0, 200).replace(/\n/g, ' ');
    throw lastCandidateError ?? new Error(
      `Planner nao retornou JSON valido com project + sprints. Inicio: "${preview}..."`,
    );
  }

  for (const sprint of parsed.sprints) {
    if (!sprint.id) throw new Error(`Sprint missing "id"`);
    if (!sprint.name) throw new Error(`Sprint "${sprint.id}" missing "name"`);
    if (!Array.isArray(sprint.features)) throw new Error(`Sprint "${sprint.id}" missing "features"`);

    for (const feature of sprint.features) {
      if (!feature.id) throw new Error(`Feature missing "id" in sprint "${sprint.id}"`);
      if (!Array.isArray(feature.acceptance_criteria)) {
        throw new Error(`Feature "${feature.id}" missing "acceptance_criteria"`);
      }
    }

    if (validAgentIds) {
      if (sprint.coder_agent_id && !validAgentIds.coderIds.has(sprint.coder_agent_id)) {
        const validList = Array.from(validAgentIds.coderIds).join(', ');
        throw new Error(
          `Sprint "${sprint.id}" has invalid coder_agent_id "${sprint.coder_agent_id}". ` +
          `Valid IDs: ${validList}`,
        );
      }
      if (
        'evaluator_agent_id' in sprint &&
        (sprint as Record<string, unknown>)['evaluator_agent_id'] &&
        !validAgentIds.evaluatorIds.has((sprint as Record<string, unknown>)['evaluator_agent_id'] as string)
      ) {
        const validList = Array.from(validAgentIds.evaluatorIds).join(', ');
        throw new Error(
          `Sprint "${sprint.id}" has invalid evaluator_agent_id "${(sprint as Record<string, unknown>)['evaluator_agent_id'] as string}". ` +
          `Valid IDs: ${validList}`,
        );
      }
    }
  }

  if (validAgentIds && parsed.project?.config?.evaluator_agent_id) {
    if (!validAgentIds.evaluatorIds.has(parsed.project.config.evaluator_agent_id)) {
      const validList = Array.from(validAgentIds.evaluatorIds).join(', ');
      throw new Error(
        `project.config.evaluator_agent_id "${parsed.project.config.evaluator_agent_id}" is not a valid evaluator. ` +
        `Valid IDs: ${validList}`,
      );
    }
  }

  parsed.metadata = parsed.metadata ?? { version: 1, created_at: new Date().toISOString(), total_sprints: 0, total_features: 0 };
  parsed.metadata.total_sprints = parsed.sprints.length;
  parsed.metadata.total_features = parsed.sprints.reduce((sum, s) => sum + s.features.length, 0);

  return parsed;
}

export function buildPlannerMarkdownPrompt(
  specContent: string,
  project: HarnessProject,
  agents: AgentConfig[],
): string {
  const agentList = agents
    .filter(a => a.isActive && !['harness-coder', 'harness-evaluator', 'harness-planner'].includes(a.id))
    .map(a => `- ${a.name} (ID: ${a.id}): ${a.description}`)
    .join('\n');

  return `## Spec do Projeto
${specContent}

## Agentes Disponiveis (Coders)
${agentList}

## Regras de Selecao de Agente

1. O campo coder_agent_id DEVE conter o ID exato de um dos agentes listados acima
2. React / Next.js / Frontend / UI -> nextjs-developer ou frontend-developer
3. Node.js / API / Backend / Express / Fastify -> backend-developer
4. Electron / Desktop -> electron-pro
5. JavaScript generico / utilitarios -> javascript-pro
6. Quando em duvida, escolha o especialista mais proximo da stack da sprint. NUNCA use harness-coder

## Dados do Projeto
- ID: ${project.id}
- Nome: ${project.name}
- Descricao: ${project.description ?? ''}
- Path: ${project.projectPath}
- Stack: ${project.config.stack.join(', ')}
- Max rounds por sprint: ${project.config.maxRoundsPerSprint}
- Playwright: ${project.config.usePlaywright}

## Formato de Output
Responda com Markdown seguindo exatamente esta estrutura (cada sprint separada por "---"):

# Sprint 1: Nome da Sprint
- **Coder:** id-do-agente
- **Complexidade:** low | medium | high
- **Stack:** tech1, tech2
- **Depende de:** nenhuma
- **Rounds estimados:** 1

Descricao do que sera implementado nesta sprint.

## Feature: Nome da Feature
Descricao da feature.

### Criterios de aceite
- Criterio verificavel 1
- Criterio verificavel 2

## Hints
- **Arquivos existentes:** path/to/file1.ts, path/to/file2.ts
- **Interfaces chave:** User, Product
- **Arquitetura:** Notas sobre decisoes de design

---

# Sprint 2: Nome da Sprint
...`;
}

export function parsePlannerMarkdown(rawOutput: string, project: HarnessProject): SprintsJson {
  const text = rawOutput.trim();

  const sprintBlocks = text.split(/(?=^# Sprint \d+[:\s-])/m).filter(b => b.trim());

  if (sprintBlocks.length === 0) {
    throw new Error('Planner nao retornou nenhuma sprint em Markdown. Esperado "# Sprint 1: ..."');
  }

  const sprints: SprintJsonEntry[] = [];

  for (let i = 0; i < sprintBlocks.length; i++) {
    const block = sprintBlocks[i].trim();

    const headerMatch = block.match(/^# Sprint \d+[:\s-]\s*(.+)/m);
    if (!headerMatch) continue;

    const sprintName = headerMatch[1].trim();
    const sprintId = `sprint-${String(i + 1).padStart(3, '0')}`;

    const coderMatch = block.match(/\*\*Coder:\*\*\s*(.+)/i);
    const complexityMatch = block.match(/\*\*Complexidade:\*\*\s*(low|medium|high)/i);
    const stackMatch = block.match(/\*\*Stack:\*\*\s*(.+)/i);
    const dependsMatch = block.match(/\*\*Depende de:\*\*\s*(.+)/i);
    const roundsMatch = block.match(/\*\*Rounds estimados:\*\*\s*(\d+)/i);

    const firstFeatureIdx = block.search(/^##\s+Feature[:\s]/m);
    let description = '';
    if (firstFeatureIdx !== -1) {
      const afterMeta = block.slice(0, firstFeatureIdx);
      const lines = afterMeta.split('\n');
      const descLines: string[] = [];
      let pastMeta = false;
      for (const line of lines) {
        if (line.startsWith('# ')) continue;
        if (line.match(/^\s*-\s*\*\*/)) { pastMeta = true; continue; }
        if (pastMeta && line.trim()) {
          descLines.push(line.trim());
        }
      }
      description = descLines.join(' ').trim();
    }

    const featureBlocks = block.split(/(?=^##\s+Feature[:\s])/m).filter(b => b.match(/^##\s+Feature[:\s]/m));
    const features: SprintFeature[] = [];

    for (let j = 0; j < featureBlocks.length; j++) {
      const fb = featureBlocks[j].trim();

      const featNameMatch = fb.match(/^##\s+Feature[:\s-]\s*(.+)/m);
      if (!featNameMatch) continue;

      const featName = featNameMatch[1].trim();
      const featId = `feat-${String(i + 1).padStart(3, '0')}-${String(j + 1).padStart(3, '0')}`;

      const criteriaHeaderIdx = fb.search(/^###?\s+Crit[eé]rios/mi);
      let featDescription = '';
      if (criteriaHeaderIdx !== -1) {
        const descPart = fb.slice(featNameMatch[0].length, criteriaHeaderIdx).trim();
        featDescription = descPart.replace(/\n+/g, ' ').trim();
      }

      const criteria: string[] = [];
      if (criteriaHeaderIdx !== -1) {
        const criteriaSection = fb.slice(criteriaHeaderIdx);
        const criteriaLines = criteriaSection.split('\n');
        for (const line of criteriaLines) {
          const critMatch = line.match(/^\s*-\s+\[?\s*]?\s*(.+)/);
          if (critMatch && !critMatch[1].startsWith('**')) {
            criteria.push(critMatch[1].trim());
          }
        }
      }

      features.push({
        id: featId,
        name: featName,
        description: featDescription,
        acceptance_criteria: criteria,
      });
    }

    const hintsMatch = block.match(/^##\s+Hints?\s*\n([\s\S]*?)(?=\n---|\n# Sprint|$)/mi);
    const hints = {
      existing_files: [] as string[],
      key_interfaces: [] as string[],
      architecture_notes: '',
    };

    if (hintsMatch) {
      const hintsBlock = hintsMatch[1];
      const filesMatch = hintsBlock.match(/\*\*Arquivos?\s*existentes?:\*\*\s*(.+)/i);
      const interfacesMatch = hintsBlock.match(/\*\*Interfaces?\s*chave:\*\*\s*(.+)/i);
      const archMatch = hintsBlock.match(/\*\*Arquitetura:\*\*\s*(.+)/i);

      if (filesMatch) {
        hints.existing_files = filesMatch[1].split(',').map(s => s.trim()).filter(Boolean);
      }
      if (interfacesMatch) {
        hints.key_interfaces = interfacesMatch[1].split(',').map(s => s.trim()).filter(Boolean);
      }
      if (archMatch) {
        hints.architecture_notes = archMatch[1].trim();
      }
    }

    const dependencies: string[] = [];
    if (dependsMatch) {
      const depText = dependsMatch[1].trim().toLowerCase();
      if (depText !== 'nenhuma' && depText !== 'nenhum' && depText !== 'none' && depText !== '-') {
        const depNumbers = depText.match(/\d+/g);
        if (depNumbers) {
          for (const num of depNumbers) {
            dependencies.push(`sprint-${num.padStart(3, '0')}`);
          }
        }
      }
    }

    const stack: string[] = stackMatch
      ? stackMatch[1].split(',').map(s => s.trim()).filter(Boolean)
      : [];

    sprints.push({
      id: sprintId,
      index: i,
      name: sprintName,
      description,
      coder_agent_id: coderMatch ? coderMatch[1].trim() : '',
      stack,
      features,
      hints,
      dependencies,
      complexity: (complexityMatch?.[1]?.toLowerCase() as 'low' | 'medium' | 'high') ?? 'medium',
      estimated_rounds: roundsMatch ? parseInt(roundsMatch[1], 10) : 2,
    });
  }

  if (sprints.length === 0) {
    throw new Error('Planner Markdown nao continha sprints parseavaveis');
  }

  for (const sprint of sprints) {
    if (sprint.features.length === 0) {
      logger.warn({ sprintId: sprint.id, sprintName: sprint.name }, 'Sprint sem features detectada');
    }
    for (const feature of sprint.features) {
      if (feature.acceptance_criteria.length === 0) {
        logger.warn({ featId: feature.id, featName: feature.name }, 'Feature sem criterios de aceite');
      }
    }
  }

  const totalFeatures = sprints.reduce((sum, s) => sum + s.features.length, 0);

  return {
    project: {
      id: project.id,
      name: project.name,
      description: project.description ?? '',
      path: project.projectPath,
      stack: project.config.stack,
      config: {
        max_rounds_per_sprint: project.config.maxRoundsPerSprint,
        use_playwright: project.config.usePlaywright,
        evaluator_agent_id: project.config.evaluatorAgentId,
        planner_agent_id: project.config.plannerAgentId,
      },
    },
    sprints,
    metadata: {
      version: 1,
      created_at: new Date().toISOString(),
      total_sprints: sprints.length,
      total_features: totalFeatures,
    },
  };
}

export function sprintsJsonToMarkdown(sprintsJson: SprintsJson): string {
  return sprintsJson.sprints.map((sprint, i) => {
    const deps = sprint.dependencies.length > 0
      ? sprint.dependencies.map(d => {
          const num = d.match(/\d+/);
          return num ? `sprint ${parseInt(num[0], 10)}` : d;
        }).join(', ')
      : 'nenhuma';

    const featuresBlock = sprint.features.map(f => {
      const criteria = f.acceptance_criteria.map(c => `- ${c}`).join('\n');
      return `## Feature: ${f.name}\n${f.description}\n\n### Criterios de aceite\n${criteria}`;
    }).join('\n\n');

    const hintsLines: string[] = [];
    if (sprint.hints.existing_files.length > 0) {
      hintsLines.push(`- **Arquivos existentes:** ${sprint.hints.existing_files.join(', ')}`);
    }
    if (sprint.hints.key_interfaces.length > 0) {
      hintsLines.push(`- **Interfaces chave:** ${sprint.hints.key_interfaces.join(', ')}`);
    }
    if (sprint.hints.architecture_notes) {
      hintsLines.push(`- **Arquitetura:** ${sprint.hints.architecture_notes}`);
    }
    const hintsBlock = hintsLines.length > 0 ? `\n## Hints\n${hintsLines.join('\n')}` : '';

    return `# Sprint ${i + 1}: ${sprint.name}
- **Coder:** ${sprint.coder_agent_id}
- **Complexidade:** ${sprint.complexity}
- **Stack:** ${sprint.stack.join(', ')}
- **Depende de:** ${deps}
- **Rounds estimados:** ${sprint.estimated_rounds}

${sprint.description}

${featuresBlock}${hintsBlock}`;
  }).join('\n\n---\n\n');
}

export function getNextSprintsVersion(projectDir: string): number {
  const files = fs.existsSync(projectDir)
    ? fs.readdirSync(projectDir).filter(f => f.match(/^sprints\.v\d+\.(json|md)$/))
    : [];

  if (files.length === 0) return 1;

  const versions = files.map(f => {
    const match = f.match(/^sprints\.v(\d+)\.(json|md)$/);
    return match ? parseInt(match[1], 10) : 0;
  });

  return Math.max(...versions) + 1;
}

export function saveSprintsJson(
  projectId: string,
  sprintsJsonPath: string,
  sprintsJson: SprintsJson,
  evaluatorAgentId: string,
  format: 'json' | 'markdown' = 'json',
): { path: string; version: number } {
  const canonicalJsonPath = path.resolve(sprintsJsonPath);
  const projectDir = path.dirname(canonicalJsonPath);
  const version = getNextSprintsVersion(projectDir);
  sprintsJson.metadata.version = version;

  fs.mkdirSync(projectDir, { recursive: true });

  fs.writeFileSync(canonicalJsonPath, JSON.stringify(sprintsJson, null, 2), 'utf-8');

  const jsonFilename = `sprints.v${version}.json`;
  const jsonPath = path.join(projectDir, jsonFilename);
  fs.writeFileSync(jsonPath, JSON.stringify(sprintsJson, null, 2), 'utf-8');

  if (format === 'markdown') {
    const mdFilename = `sprints.v${version}.md`;
    const mdPath = path.join(projectDir, mdFilename);
    fs.writeFileSync(mdPath, sprintsJsonToMarkdown(sprintsJson), 'utf-8');
  }

  replaceHarnessSprintsForProject(
    projectId,
    sprintsJson.sprints.map(sprint => ({
      sprintIndex: sprint.index,
      sprintJsonId: sprint.id,
      name: sprint.name,
      coderAgentId: sprint.coder_agent_id,
      evaluatorAgentId,
      maxRounds: sprintsJson.project.config.max_rounds_per_sprint,
    })),
    { sprintJsonHashes: computeSprintJsonHashes(sprintsJson) },
  );

  logger.info({ projectId, version, format, sprintCount: sprintsJson.sprints.length }, 'Saved sprints');

  return { path: canonicalJsonPath, version };
}

export function buildRegenerationPrompt(
  previousJson: SprintsJson,
  feedback: string,
  specContent: string,
  agents: AgentConfig[],
  format: 'json' | 'markdown' = 'json',
): string {
  const fakeProject: HarnessProject = {
    id: previousJson.project.id,
    name: previousJson.project.name,
    description: previousJson.project.description,
    projectPath: previousJson.project.path,
    specPath: '',
    config: {
      maxRoundsPerSprint: previousJson.project.config.max_rounds_per_sprint,
      usePlaywright: previousJson.project.config.use_playwright,
      evaluatorAgentId: previousJson.project.config.evaluator_agent_id,
      plannerAgentId: previousJson.project.config.planner_agent_id,
      stack: previousJson.project.stack,
      plannerOutputFormat: format,
    },
    sprintsJsonPath: undefined,
    status: 'planning' as const,
    currentSprintIndex: 0,
    totalSprints: previousJson.metadata.total_sprints,
    totalFeatures: previousJson.metadata.total_features,
    plannerInputTokens: 0,
    plannerOutputTokens: 0,
    plannerCacheTokens: 0,
    plannerCostUsd: 0,
    plannerDurationMs: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const basePrompt = format === 'markdown'
    ? buildPlannerMarkdownPrompt(specContent, fakeProject, agents)
    : buildPlannerPrompt(specContent, fakeProject, agents);

  const previousContent = format === 'markdown'
    ? sprintsJsonToMarkdown(previousJson)
    : JSON.stringify(previousJson, null, 2);

  return `${basePrompt}

## Versao Anterior (v${previousJson.metadata.version})
${previousContent}

## Feedback do Usuario
${feedback}`;
}

export function readSprintsJsonFile(filePath: string): SprintsJson | null {
  if (!fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(content) as SprintsJson;
}

export function readLatestSprintsJson(projectDir: string, canonicalPath?: string | null): SprintsJson | null {
  if (canonicalPath) {
    const canonicalJson = readSprintsJsonFile(canonicalPath);
    if (canonicalJson) return canonicalJson;
  }

  const unversionedPath = path.join(projectDir, 'sprints.json');
  const unversionedJson = readSprintsJsonFile(unversionedPath);
  if (unversionedJson) return unversionedJson;

  if (!fs.existsSync(projectDir)) return null;

  const files = fs.readdirSync(projectDir).filter(f => f.match(/^sprints\.v\d+\.json$/));
  if (files.length === 0) return null;

  const versions = files.map(f => {
    const match = f.match(/^sprints\.v(\d+)\.json$/);
    return { file: f, version: match ? parseInt(match[1], 10) : 0 };
  });

  versions.sort((a, b) => b.version - a.version);
  const latest = versions[0];

  const content = fs.readFileSync(path.join(projectDir, latest.file), 'utf-8');
  return JSON.parse(content) as SprintsJson;
}

export function readHarnessSprintsJson(project: HarnessProject): SprintsJson | null {
  const readPath = resolveHarnessSprintsReadPath(project);
  const canonicalJson = readSprintsJsonFile(readPath);
  if (canonicalJson) return canonicalJson;

  const canonicalPath = resolveHarnessSprintsPath(project);
  if (canonicalPath !== readPath) {
    const fallbackCanonicalJson = readSprintsJsonFile(canonicalPath);
    if (fallbackCanonicalJson) return fallbackCanonicalJson;
  }

  const legacyPath = findLegacyHarnessSprintsPath(project);
  if (legacyPath) {
    return readLatestSprintsJson(path.dirname(legacyPath), legacyPath);
  }

  return readLatestSprintsJson(path.dirname(canonicalPath), canonicalPath);
}


const SPRINT_QUEUE_PLAYBOOK =
  'Playbook de recuperacao: (i) reverta o sprints.json para casar com a fila de execucao; ' +
  '(ii) resete a fase do Sprint Validator e re-aprove o inicio do desenvolvimento (o confirm re-semeia a fila); ' +
  '(iii) resete a fase do Planner para regenerar o plano. ' +
  'Sprints ja executados afetados pela edicao precisam ser recolocados em pending via reset do sprint (acao humana, nunca automatica).';

export function computeSprintEntryHash(entry: SprintJsonEntry): string {
  return createHash('sha256').update(canonicalJsonStringify(entry)).digest('hex');
}

export function computeSprintJsonHashes(sprintsJson: SprintsJson): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const entry of sprintsJson.sprints) {
    hashes[entry.id] = computeSprintEntryHash(entry);
  }
  return hashes;
}

export function validateSprintsJsonStructure(
  sprintsJson: SprintsJson,
  agents: Array<Pick<AgentConfig, 'id'>>,
): void {
  const fail = (msg: string): never => {
    throw new Error(`sprints.json invalido (editado pelo Sprint Validator): ${msg}. Corrija o arquivo ou resete a fase do Planner.`);
  };

  if (!Array.isArray(sprintsJson.sprints) || sprintsJson.sprints.length === 0) {
    fail('campo "sprints" ausente, nao-array ou vazio');
  }

  const agentIds = new Set(agents.map(a => a.id));
  const sprintIds = new Set<string>();
  for (let i = 0; i < sprintsJson.sprints.length; i++) {
    const s = sprintsJson.sprints[i] as Partial<SprintJsonEntry> | null;
    const at = `sprint na posicao ${i}`;
    if (!s || typeof s !== 'object') fail(`${at} nao e um objeto`);
    const sprint = s as Partial<SprintJsonEntry>;
    if (typeof sprint.id !== 'string' || sprint.id.trim() === '') fail(`${at} sem "id" valido`);
    const id = sprint.id as string;
    if (sprintIds.has(id)) fail(`id de sprint duplicado: "${id}"`);
    sprintIds.add(id);
    if (typeof sprint.name !== 'string' || sprint.name.trim() === '') fail(`sprint "${id}" sem "name" valido`);
    if (!Array.isArray(sprint.features) || sprint.features.length === 0) {
      fail(`sprint "${id}" sem "features" (array nao-vazio obrigatorio)`);
    }
    const featureIds = new Set<string>();
    for (const feature of sprint.features as Array<Partial<SprintFeature>>) {
      if (!feature || typeof feature !== 'object') fail(`sprint "${id}" tem feature que nao e objeto`);
      if (typeof feature.id !== 'string' || feature.id.trim() === '') fail(`sprint "${id}" tem feature sem "id" valido`);
      if (featureIds.has(feature.id as string)) fail(`sprint "${id}" tem id de feature duplicado: "${feature.id}"`);
      featureIds.add(feature.id as string);
      if (typeof feature.name !== 'string' || feature.name.trim() === '') {
        fail(`sprint "${id}" feature "${feature.id}" sem "name" valido`);
      }
      if (feature.acceptance_criteria !== undefined
        && (!Array.isArray(feature.acceptance_criteria) || feature.acceptance_criteria.some(c => typeof c !== 'string'))) {
        fail(`sprint "${id}" feature "${feature.id}" com "acceptance_criteria" invalido (esperado array de strings)`);
      }
    }
    if (sprint.coder_agent_id !== undefined && sprint.coder_agent_id !== null) {
      if (typeof sprint.coder_agent_id !== 'string' || !agentIds.has(sprint.coder_agent_id)) {
        fail(`sprint "${id}" referencia coder_agent_id inexistente: "${String(sprint.coder_agent_id)}"`);
      }
    }
    if (sprint.dependencies !== undefined) {
      if (!Array.isArray(sprint.dependencies) || sprint.dependencies.some(d => typeof d !== 'string')) {
        fail(`sprint "${id}" com "dependencies" invalido (esperado array de strings)`);
      }
    }
  }

  for (const sprint of sprintsJson.sprints) {
    for (const dep of sprint.dependencies ?? []) {
      if (!sprintIds.has(dep)) {
        fail(`sprint "${sprint.id}" depende de sprint inexistente: "${dep}"`);
      }
    }
  }
}

export interface SprintReseedOutcome {
  action: 'noop' | 'replaced' | 'updated-pending';
  totalSprints: number;
  totalFeatures: number;
}

function resolveFileMaxRounds(sprintsJson: SprintsJson, project: HarnessProject): number {
  return sprintsJson.project?.config?.max_rounds_per_sprint ?? project.config.maxRoundsPerSprint;
}

function readCanonicalSprintsFileOrThrow(project: HarnessProject): { sprintsJson: SprintsJson; readPath: string } {
  const readPath = findHarnessSprintsReadPath(project);
  if (!readPath) {
    throw new Error(
      `sprints.json canonico nao encontrado para o projeto ${project.id} (${project.projectPath}). ` +
      'Resete a fase do Planner para regenerar o plano antes de iniciar o desenvolvimento.',
    );
  }
  let sprintsJson: SprintsJson;
  try {
    sprintsJson = JSON.parse(fs.readFileSync(readPath, 'utf-8')) as SprintsJson;
  } catch (err) {
    throw new Error(
      `sprints.json ilegivel/invalido em ${readPath}: ${(err as Error).message}. ` +
      'Corrija o JSON editado pelo Sprint Validator ou resete a fase do Planner.',
    );
  }
  return { sprintsJson, readPath };
}

function queueRowFieldsDiverge(row: HarnessSprint, entry: SprintJsonEntry, fileMaxRounds: number): boolean {
  return row.name !== entry.name
    || (row.coderAgentId ?? null) !== (entry.coder_agent_id ?? null)
    || row.maxRounds !== fileMaxRounds;
}

export function reseedHarnessSprintsFromFile(project: HarnessProject): SprintReseedOutcome {
  const { sprintsJson, readPath } = readCanonicalSprintsFileOrThrow(project);
  if (!Array.isArray(sprintsJson.sprints) || sprintsJson.sprints.length === 0) {
    throw new Error(`sprints.json em ${readPath} sem sprints. Resete a fase do Planner.`);
  }

  const dbSprints = getHarnessSprints(project.id);
  const fileIds = sprintsJson.sprints.map(s => s.id);
  const dbIds = dbSprints.map(s => s.sprintJsonId);
  const fileHashes = computeSprintJsonHashes(sprintsJson);
  const fileMaxRounds = resolveFileMaxRounds(sprintsJson, project);

  const freshProject = getHarnessProject(project.id) ?? project;
  const hashMap = freshProject.config.sprintJsonHashes;

  const idsEqual = fileIds.length === dbIds.length && fileIds.every((id, i) => id === dbIds[i]);

  const divergentIds: string[] = [];
  if (idsEqual) {
    for (let i = 0; i < sprintsJson.sprints.length; i++) {
      const entry = sprintsJson.sprints[i];
      const row = dbSprints[i];
      const known = hashMap?.[entry.id];
      const diverged = known !== undefined
        ? fileHashes[entry.id] !== known
        : queueRowFieldsDiverge(row, entry, fileMaxRounds);
      if (diverged) divergentIds.push(entry.id);
    }
  }

  const totals = {
    totalSprints: sprintsJson.sprints.length,
    totalFeatures: sprintsJson.sprints.reduce((sum, s) => sum + (s.features?.length ?? 0), 0),
  };

  if (idsEqual && divergentIds.length === 0) {
    const missing: Record<string, string> = {};
    for (const id of fileIds) {
      if (hashMap?.[id] === undefined) missing[id] = fileHashes[id];
    }
    if (Object.keys(missing).length > 0) {
      mergeHarnessProjectSprintJsonHashes(project.id, missing);
      logger.info({ projectId: project.id, seeded: Object.keys(missing).length }, 'Reseed no-op: mapa de hashes semeado (projeto legado)');
    }
    return { action: 'noop', ...totals };
  }

  validateSprintsJsonStructure(sprintsJson, getAllAgents());

  const allPending = dbSprints.every(s => s.status === 'pending');
  const roundsCount = countHarnessRoundsForProject(project.id);

  if (allPending && roundsCount === 0) {
    replaceHarnessSprintsForProject(
      project.id,
      sprintsJson.sprints.map((sprint, i) => ({
        sprintIndex: i,
        sprintJsonId: sprint.id,
        name: sprint.name,
        coderAgentId: sprint.coder_agent_id,
        evaluatorAgentId: project.config.evaluatorAgentId,
        maxRounds: fileMaxRounds,
      })),
      { totals, sprintJsonHashes: fileHashes },
    );
    logger.info(
      { projectId: project.id, readPath, totalSprints: totals.totalSprints, totalFeatures: totals.totalFeatures },
      'Reseed: fila de sprints re-semeada do sprints.json editado pelo Sprint Validator',
    );
    return { action: 'replaced', ...totals };
  }

  if (idsEqual) {
    const nonPendingDivergent = divergentIds.filter(id => {
      const row = dbSprints[fileIds.indexOf(id)];
      return row.status !== 'pending';
    });
    if (nonPendingDivergent.length === 0) {
      const updates = divergentIds.map(id => {
        const i = fileIds.indexOf(id);
        const entry = sprintsJson.sprints[i];
        return {
          id: dbSprints[i].id,
          name: entry.name,
          coderAgentId: entry.coder_agent_id ?? null,
          maxRounds: fileMaxRounds,
        };
      });
      updateHarnessPendingSprintsFromReseed(project.id, updates, totals, fileHashes);
      logger.info(
        { projectId: project.id, updated: divergentIds },
        'Reseed: sprints pending atualizados a partir do sprints.json (status/rounds preservados)',
      );
      return { action: 'updated-pending', ...totals };
    }
    throw new Error(
      `Fila de sprints divergente do sprints.json em sprint(s) ja executado(s) [${nonPendingDivergent.join(', ')}] — ` +
      `o conteudo aprovado nao pode ser reconciliado automaticamente sem apagar historico. ${SPRINT_QUEUE_PLAYBOOK}`,
    );
  }

  throw new Error(
    `Fila de sprints divergente do sprints.json (fila: [${dbIds.join(', ')}] vs arquivo: [${fileIds.join(', ')}]) ` +
    `com sprint(s) ja executado(s)/rounds registrados — reconciliar automaticamente apagaria historico. ${SPRINT_QUEUE_PLAYBOOK}`,
  );
}

export type SprintQueueIntegrityResult =
  | { ok: true; warning?: string }
  | {
      ok: false;
      kind: 'file-missing' | 'invalid-file' | 'added-removed' | 'reordered' | 'content-changed';
      message: string;
    };

export function checkHarnessSprintQueueIntegrity(
  project: HarnessProject,
  dbSprints: HarnessSprint[],
): SprintQueueIntegrityResult {
  const freshProject = getHarnessProject(project.id) ?? project;

  const readPath = findHarnessSprintsReadPath(freshProject);
  if (!readPath) {
    return {
      ok: false,
      kind: 'file-missing',
      message: `sprints.json canonico nao encontrado para o projeto ${project.id}. ${SPRINT_QUEUE_PLAYBOOK}`,
    };
  }

  let sprintsJson: SprintsJson;
  try {
    sprintsJson = JSON.parse(fs.readFileSync(readPath, 'utf-8')) as SprintsJson;
  } catch (err) {
    return {
      ok: false,
      kind: 'invalid-file',
      message: `sprints.json ilegivel/invalido em ${readPath}: ${(err as Error).message}. ${SPRINT_QUEUE_PLAYBOOK}`,
    };
  }

  const fileIds = (sprintsJson.sprints ?? []).map(s => s.id);
  const dbIds = dbSprints.map(s => s.sprintJsonId);
  const hashMap = freshProject.config.sprintJsonHashes;
  const hashMapPresent = !!hashMap && Object.keys(hashMap).length > 0;

  const idsEqual = fileIds.length === dbIds.length && fileIds.every((id, i) => id === dbIds[i]);

  if (idsEqual) {
    const fileHashes = computeSprintJsonHashes(sprintsJson);
    if (!hashMapPresent) {
      mergeHarnessProjectSprintJsonHashes(project.id, fileHashes);
      return { ok: true, warning: 'mapa de hashes ausente (projeto legado) — semeado a partir do sprints.json atual' };
    }
    const changed = fileIds.filter(id => hashMap?.[id] !== undefined && fileHashes[id] !== hashMap[id]);
    if (changed.length > 0) {
      return {
        ok: false,
        kind: 'content-changed',
        message:
          `Conteudo do sprints.json mudou apos a aprovacao para sprint(s) [${changed.join(', ')}] (IDs identicos, hash divergente) — ` +
          `possivel edicao mid-run; o plano em execucao nao corresponde ao aprovado. ${SPRINT_QUEUE_PLAYBOOK}`,
      };
    }
    const missing: Record<string, string> = {};
    for (const id of fileIds) {
      if (hashMap?.[id] === undefined) missing[id] = fileHashes[id];
    }
    if (Object.keys(missing).length > 0) {
      mergeHarnessProjectSprintJsonHashes(project.id, missing);
    }
    return { ok: true };
  }

  const sameMultiset =
    fileIds.length === dbIds.length &&
    [...fileIds].sort().join(' ') === [...dbIds].sort().join(' ');
  const kind = sameMultiset ? 'reordered' : 'added-removed';

  if (!hashMapPresent) {
    const pendingIds = dbSprints
      .filter(s => s.status === 'pending' || s.status === 'running')
      .map(s => s.sprintJsonId);
    let cursor = 0;
    const pendingSubsequenceOk = pendingIds.every(id => {
      const at = fileIds.indexOf(id, cursor);
      if (at === -1) return false;
      cursor = at + 1;
      return true;
    });
    if (pendingSubsequenceOk) {
      return {
        ok: true,
        warning:
          `fila de sprints diverge do sprints.json (projeto legado pre-fix, ${kind === 'reordered' ? 'reordenacao' : 'sprint adicionado/removido'}) — ` +
          `tolerado porque os sprints pendentes seguem presentes na mesma ordem. Para reconciliar de vez: ${SPRINT_QUEUE_PLAYBOOK}`,
      };
    }
  }

  const detail = kind === 'reordered'
    ? `sprints foram REORDENADOS sem mudanca de IDs (fila: [${dbIds.join(', ')}] vs arquivo: [${fileIds.join(', ')}]) — a ordem decide a execucao e o lookup posicional de design do dev-v2`
    : `sprint(s) foram ADICIONADOS/REMOVIDOS no arquivo (fila: [${dbIds.join(', ')}] vs arquivo: [${fileIds.join(', ')}])`;
  return {
    ok: false,
    kind,
    message: `Fila de sprints divergente do sprints.json: ${detail}. ${SPRINT_QUEUE_PLAYBOOK}`,
  };
}

export { getAllAgents };
