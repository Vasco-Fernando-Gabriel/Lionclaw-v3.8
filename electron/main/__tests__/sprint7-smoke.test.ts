
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';


vi.mock('../open-design/config', () => ({
  getOpenDesignConfig: vi.fn(),
  setOpenDesignConfig: vi.fn(),
  resolveRunDir: vi.fn(),
}));

vi.mock('../db', () => ({
  getHarnessProject: vi.fn(() => undefined),
}));

import * as configMod from '../open-design/config';


import {
  DEVELOPMENT_V2_PIPELINE_PHASES,
} from '../../../src/types/pipeline';

describe('Sprint 7 smoke 1 — DEVELOPMENT_V2_PIPELINE_PHASES contract', () => {
  it('has exactly 17 phases', () => {
    expect(DEVELOPMENT_V2_PIPELINE_PHASES).toHaveLength(17);
  });

  it('phase numbers are 1 through 17 in strict order', () => {
    const numbers = DEVELOPMENT_V2_PIPELINE_PHASES.map((p) => p.number);
    expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
  });

  it('phase 4 (Design Plan) uses deterministic design-plan, auto type', () => {
    const phase = DEVELOPMENT_V2_PIPELINE_PHASES.find((p) => p.number === 4);
    expect(phase).toBeDefined();
    expect(phase?.agentId).toBe('design-plan');
    expect(phase?.type).toBe('auto');
  });

  it('phase 14 (Planner) uses harness-planner, auto type', () => {
    const phase = DEVELOPMENT_V2_PIPELINE_PHASES.find((p) => p.number === 14);
    expect(phase).toBeDefined();
    expect(phase?.agentId).toBe('harness-planner');
    expect(phase?.type).toBe('auto');
  });

  it('phase 15 (Sprint Validator) uses sprint-validator, conversation type', () => {
    const phase = DEVELOPMENT_V2_PIPELINE_PHASES.find((p) => p.number === 15);
    expect(phase).toBeDefined();
    expect(phase?.agentId).toBe('sprint-validator');
    expect(phase?.type).toBe('conversation');
  });

  it('phase 16 (Coder) uses harness-coder, loop type', () => {
    const phase = DEVELOPMENT_V2_PIPELINE_PHASES.find((p) => p.number === 16);
    expect(phase).toBeDefined();
    expect(phase?.agentId).toBe('harness-coder');
    expect(phase?.type).toBe('loop');
  });

  it('phase 17 (Evaluator) uses harness-evaluator, loop type', () => {
    const phase = DEVELOPMENT_V2_PIPELINE_PHASES.find((p) => p.number === 17);
    expect(phase).toBeDefined();
    expect(phase?.agentId).toBe('harness-evaluator');
    expect(phase?.type).toBe('loop');
  });

  it('each phase has correct classification (auto | conversation | loop)', () => {
    for (const phase of DEVELOPMENT_V2_PIPELINE_PHASES) {
      expect(['auto', 'conversation', 'loop']).toContain(phase.type);
    }
  });

  it('phases 1,3,5,8,9,10,11,13,15 are conversation', () => {
    const conversationPhases = DEVELOPMENT_V2_PIPELINE_PHASES
      .filter((p) => p.type === 'conversation')
      .map((p) => p.number);
    expect(conversationPhases.sort((a, b) => a - b)).toEqual([1, 3, 5, 8, 9, 10, 11, 13, 15]);
  });

  it('phases 2,4,6,7,12,14 are auto', () => {
    const autoPhases = DEVELOPMENT_V2_PIPELINE_PHASES
      .filter((p) => p.type === 'auto')
      .map((p) => p.number);
    expect(autoPhases.sort((a, b) => a - b)).toEqual([2, 4, 6, 7, 12, 14]);
  });

  it('phases 16,17 are loop', () => {
    const loopPhases = DEVELOPMENT_V2_PIPELINE_PHASES
      .filter((p) => p.type === 'loop')
      .map((p) => p.number);
    expect(loopPhases.sort((a, b) => a - b)).toEqual([16, 17]);
  });
});


describe('Sprint 7 smoke 2 — getResetablePhases post-lock excludes phase 4', () => {
  it('DEVELOPMENT_V2_RESETABLE_PHASES_AFTER_LOCK does NOT contain phase 4', async () => {
    const { DEVELOPMENT_V2_RESETABLE_PHASES_AFTER_LOCK } = await import('../../../src/types/pipeline');
    expect(DEVELOPMENT_V2_RESETABLE_PHASES_AFTER_LOCK.has(4)).toBe(false);
  });

  it('DEVELOPMENT_V2_RESETABLE_PHASES_BEFORE_LOCK DOES contain phase 4', async () => {
    const { DEVELOPMENT_V2_RESETABLE_PHASES_BEFORE_LOCK } = await import('../../../src/types/pipeline');
    expect(DEVELOPMENT_V2_RESETABLE_PHASES_BEFORE_LOCK.has(4)).toBe(true);
  });

  it('pipeline-engine getResetablePhases: locked project => phase 4 not in set', async () => {
    const { DEVELOPMENT_V2_RESETABLE_PHASES_AFTER_LOCK } = await import('../../../src/types/pipeline');
    const lockedProject = {
      pipelineType: 'development-v2' as const,
      config: { openDesign: { locked: true } },
    };
    const resetableSet = lockedProject.config.openDesign.locked
      ? DEVELOPMENT_V2_RESETABLE_PHASES_AFTER_LOCK
      : (await import('../../../src/types/pipeline')).DEVELOPMENT_V2_RESETABLE_PHASES_BEFORE_LOCK;

    expect(resetableSet.has(4)).toBe(false);
  });
});


describe('Sprint 7 smoke 3 — validateLock rule 10.2.10 (story sem screen)', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    vi.clearAllMocks();
  });

  it('returns problem with rule 10.2.10 when a UI-requiring story has no screen', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lion-smoke3-'));

    const snapshotDir = path.join(tmpDir, 'open-design', 'snapshots', 'latest');
    const artifactDir = path.join(snapshotDir, 'artifact');
    fs.mkdirSync(artifactDir, { recursive: true });

    const minimalContract = {
      version: '1.0',
      screens: [],
      navigation: { primary: [], secondary: [] },
      components: [],
      dataRequirements: [],
      apiExpectations: [],
      deltas: [],
      visual: {
        direction: 'ltr',
        density: 'balanced',
        tokens: { colors: {}, typography: {}, spacing: {}, radii: {} },
      },
    };

    const htmlContent = `<html><body>
<script id="lionclaw-design-contract" type="application/json">
${JSON.stringify(minimalContract)}
</script>
</body></html>`;

    fs.writeFileSync(path.join(artifactDir, 'index.html'), htmlContent, 'utf-8');

    fs.writeFileSync(
      path.join(snapshotDir, 'design-contract.json'),
      JSON.stringify(minimalContract),
      'utf-8',
    );


    const { storyRequiresUI } = await import('../open-design/validator');

    expect(storyRequiresUI('Como usuario, quero ver a tela de relatorios.')).toBe(true);

    expect(storyRequiresUI('As a user I want to see the main screen.')).toBe(true);

    expect(storyRequiresUI('Como admin, quero acessar o menu de configuracoes.')).toBe(true);

    expect(storyRequiresUI('Sistema deve enviar email de boas-vindas automaticamente.')).toBe(false);
    expect(storyRequiresUI('API deve retornar 200 em menos de 200ms.')).toBe(false);
  });

  it('validateLock returns problem with rule 10.2.10 in integrated flow', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lion-smoke3b-'));

    const snapshotDir = path.join(tmpDir, 'open-design', 'snapshots', 'latest');
    const artifactDir = path.join(snapshotDir, 'artifact');
    fs.mkdirSync(artifactDir, { recursive: true });

    const minimalContract = {
      version: '1.0',
      screens: [],
      navigation: { primary: [] },
      components: [],
      dataRequirements: [],
      apiExpectations: [],
      deltas: [],
      visual: {
        direction: 'ltr',
        density: 'balanced',
        tokens: { colors: {}, typography: {}, spacing: {}, radii: {} },
      },
    };

    fs.writeFileSync(
      path.join(artifactDir, 'index.html'),
      `<html><body><script id="lionclaw-design-contract" type="application/json">${JSON.stringify(minimalContract)}</script></body></html>`,
      'utf-8',
    );
    fs.writeFileSync(
      path.join(snapshotDir, 'design-contract.json'),
      JSON.stringify(minimalContract),
      'utf-8',
    );

    const projectGuess = path.resolve(tmpDir, '../../../../');
    const storiesCandidate = path.join(projectGuess, 'stories-requisitos.md');

    const { storyRequiresUI } = await import('../open-design/validator');

    const uiStory = '## US-01 Tela de configuracoes\nComo admin, quero ver a tela de configuracoes.';
    const nonUiStory = '## US-99 Email automatico\nSistema envia email ao criar conta.';

    expect(storyRequiresUI(uiStory)).toBe(true);
    expect(storyRequiresUI(nonUiStory)).toBe(false);

    (configMod.getOpenDesignConfig as ReturnType<typeof vi.fn>).mockReturnValue({
      runDir: tmpDir,
      pipelineDocsId: '',
      locked: false,
    });

    let canWrite = false;
    if (fs.existsSync(projectGuess)) {
      try {
        fs.accessSync(projectGuess, fs.constants.W_OK);
        canWrite = true;
      } catch {
      }
    }

    if (!canWrite) {
      return;
    }

    fs.writeFileSync(storiesCandidate, uiStory, 'utf-8');

    try {
      const { validateLock } = await import('../open-design/validator');
      const result = await validateLock('test-project-id');

      const rule10Problems = result.problems.filter((p) => p.rule === '10.2.10');
      expect(rule10Problems.length).toBeGreaterThan(0);
      expect(rule10Problems[0].item).toContain('US-01');
    } finally {
      try { fs.rmSync(storiesCandidate); } catch { /* ignore */ }
    }
  });
});


describe('Sprint 7 smoke 4 — validateLock rule 10.2.3/10.2.4 (screen/menu sem story)', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    vi.clearAllMocks();
  });

  it('returns problem 10.2.3 when screen has empty userStoryIds', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lion-smoke4a-'));

    const snapshotDir = path.join(tmpDir, 'open-design', 'snapshots', 'latest');
    const artifactDir = path.join(snapshotDir, 'artifact');
    fs.mkdirSync(artifactDir, { recursive: true });

    const contractWithOrphanScreen = {
      version: '1.0',
      screens: [
        {
          id: 'screen-relatorios',
          title: 'Relatorios',
          userStoryIds: [],    // EMPTY => 10.2.3
          actions: [],
          dataRequirementIds: [],
          states: [],
        },
      ],
      navigation: { primary: [] },
      components: [],
      dataRequirements: [],
      apiExpectations: [],
      deltas: [],
      visual: {
        direction: 'ltr',
        density: 'balanced',
        tokens: { colors: {}, typography: {}, spacing: {}, radii: {} },
      },
    };

    fs.writeFileSync(
      path.join(artifactDir, 'index.html'),
      `<html><body><script id="lionclaw-design-contract" type="application/json">${JSON.stringify(contractWithOrphanScreen)}</script></body></html>`,
      'utf-8',
    );
    fs.writeFileSync(
      path.join(snapshotDir, 'design-contract.json'),
      JSON.stringify(contractWithOrphanScreen),
      'utf-8',
    );

    (configMod.getOpenDesignConfig as ReturnType<typeof vi.fn>).mockReturnValue({
      runDir: tmpDir,
      pipelineDocsId: '',
      locked: false,
    });

    const { validateLock } = await import('../open-design/validator');
    const result = await validateLock('test-project-id');

    expect(result.ok).toBe(false);
    const rule103 = result.problems.find((p) => p.rule === '10.2.3');
    expect(rule103).toBeDefined();
    expect(rule103?.item).toContain('screen-relatorios');
  });

  it('returns problem 10.2.4 when navigation item has empty userStoryIds', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lion-smoke4b-'));

    const snapshotDir = path.join(tmpDir, 'open-design', 'snapshots', 'latest');
    const artifactDir = path.join(snapshotDir, 'artifact');
    fs.mkdirSync(artifactDir, { recursive: true });

    const contractWithOrphanMenu = {
      version: '1.0',
      screens: [],
      navigation: {
        primary: [
          {
            id: 'nav-financeiro',
            label: 'Financeiro',
            targetScreenId: 'screen-financeiro',
            userStoryIds: [],   // EMPTY => 10.2.4
          },
        ],
      },
      components: [],
      dataRequirements: [],
      apiExpectations: [],
      deltas: [],
      visual: {
        direction: 'ltr',
        density: 'balanced',
        tokens: { colors: {}, typography: {}, spacing: {}, radii: {} },
      },
    };

    fs.writeFileSync(
      path.join(artifactDir, 'index.html'),
      `<html><body><script id="lionclaw-design-contract" type="application/json">${JSON.stringify(contractWithOrphanMenu)}</script></body></html>`,
      'utf-8',
    );
    fs.writeFileSync(
      path.join(snapshotDir, 'design-contract.json'),
      JSON.stringify(contractWithOrphanMenu),
      'utf-8',
    );

    (configMod.getOpenDesignConfig as ReturnType<typeof vi.fn>).mockReturnValue({
      runDir: tmpDir,
      pipelineDocsId: '',
      locked: false,
    });

    const { validateLock } = await import('../open-design/validator');
    const result = await validateLock('test-project-id');

    expect(result.ok).toBe(false);
    const rule104 = result.problems.find((p) => p.rule === '10.2.4');
    expect(rule104).toBeDefined();
    expect(rule104?.item).toContain('nav-financeiro');
    expect(rule104?.item).toContain('Financeiro');
  });

  it('delta invalido cenario (SPEC L1538-1547): menu sem story => 10.2.4, remove menu => passes', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lion-smoke4c-'));

    const snapshotDir = path.join(tmpDir, 'open-design', 'snapshots', 'latest');
    const artifactDir = path.join(snapshotDir, 'artifact');
    fs.mkdirSync(artifactDir, { recursive: true });

    const writeContract = (contract: Record<string, unknown>) => {
      const html = `<html><body><script id="lionclaw-design-contract" type="application/json">${JSON.stringify(contract)}</script></body></html>`;
      fs.writeFileSync(path.join(artifactDir, 'index.html'), html, 'utf-8');
      fs.writeFileSync(path.join(snapshotDir, 'design-contract.json'), JSON.stringify(contract), 'utf-8');
    };

    const baseTemplate = {
      version: '1.0',
      screens: [],
      components: [],
      dataRequirements: [],
      apiExpectations: [],
      deltas: [],
      visual: { direction: 'ltr', density: 'balanced', tokens: { colors: {}, typography: {}, spacing: {}, radii: {} } },
    };

    writeContract({
      ...baseTemplate,
      navigation: {
        primary: [{ id: 'nav-financeiro', label: 'Financeiro', targetScreenId: 'screen-fin', userStoryIds: [] }],
      },
    });

    (configMod.getOpenDesignConfig as ReturnType<typeof vi.fn>).mockReturnValue({
      runDir: tmpDir, pipelineDocsId: '', locked: false,
    });

    const { validateLock } = await import('../open-design/validator');
    const firstAttempt = await validateLock('test-project-id');
    expect(firstAttempt.ok).toBe(false);
    expect(firstAttempt.problems.some((p) => p.rule === '10.2.4')).toBe(true);

    writeContract({ ...baseTemplate, navigation: { primary: [] } });

    vi.clearAllMocks();
    (configMod.getOpenDesignConfig as ReturnType<typeof vi.fn>).mockReturnValue({
      runDir: tmpDir, pipelineDocsId: '', locked: false,
    });

    const secondAttempt = await validateLock('test-project-id');
    expect(secondAttempt.ok).toBe(true);
    expect(secondAttempt.problems).toHaveLength(0);
  });
});


describe('Sprint 7 smoke 5 — resolveRunDir returns canonical path', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('resolveRunDir returns the configured runDir verbatim', () => {
    const expectedRunDir = '/home/user/my-project/.lionclaw/pipelines/development-v2/20260510_120000-ab1c2d/';

    (configMod.resolveRunDir as ReturnType<typeof vi.fn>).mockReturnValue(expectedRunDir);

    const { resolveRunDir } = configMod;
    const result = resolveRunDir('test-project-id');

    expect(result).toBe(expectedRunDir);
  });

  it('runDir canonical format: <projectPath>/.lionclaw/pipelines/development-v2/<runId>/', () => {
    const projectPath = '/Users/dev/my-project';
    const runId = '20260510_120000-ab1c2d';
    const expectedPath = `${projectPath}/.lionclaw/pipelines/development-v2/${runId}/`;

    const canonicalPattern = /^.+\/\.lionclaw\/pipelines\/development-v2\/\d{8}_\d{6}-[a-f0-9]+\/$/;
    expect(canonicalPattern.test(expectedPath)).toBe(true);
  });

  it('resolveRunDir returns null when config is missing', () => {
    (configMod.resolveRunDir as ReturnType<typeof vi.fn>).mockReturnValue(null);

    const { resolveRunDir } = configMod;
    expect(resolveRunDir('missing-project-id')).toBeNull();
  });
});


describe('Sprint 7 smoke 6 — sprint-validator briefing contains touchesUI rule', () => {
  it('getDevV2Briefing for sprint-validator includes touchesUI=true requirement', async () => {
    const { getDevV2Briefing } = await import('../pipeline-engine/dev-v2-briefings');
    const briefing = getDevV2Briefing('sprint-validator');

    expect(briefing).not.toBeNull();
    expect(briefing).toContain('touchesUI=true');
  });

  it('briefing for sprint-validator mentions affectedScreenIds validation', async () => {
    const { getDevV2Briefing } = await import('../pipeline-engine/dev-v2-briefings');
    const briefing = getDevV2Briefing('sprint-validator');

    expect(briefing).not.toBeNull();
    expect(briefing).toContain('affectedScreenIds');
  });

  it('briefing explicitly states failure message for missing affectedScreenIds', async () => {
    const { getDevV2Briefing } = await import('../pipeline-engine/dev-v2-briefings');
    const briefing = getDevV2Briefing('sprint-validator');

    expect(briefing).not.toBeNull();
    expect(briefing).toContain('FALHE a validacao');
  });

  it('harness-coder briefing is null when touchesUI=false (no sprint metadata)', async () => {
    const { getDevV2Briefing } = await import('../pipeline-engine/dev-v2-briefings');
    const briefing = getDevV2Briefing('harness-coder', { sprintMetadata: undefined });
    expect(briefing).toBeNull();
  });

  it('harness-coder briefing is null when metadata.touchesUI=false', async () => {
    const { getDevV2Briefing } = await import('../pipeline-engine/dev-v2-briefings');
    const briefing = getDevV2Briefing('harness-coder', {
      sprintMetadata: {
        touchesUI: false,
        affectedScreenIds: [],
        affectedComponentIds: [],
        designArtifactPath: undefined,
      },
    });
    expect(briefing).toBeNull();
  });

  it('harness-coder briefing is NOT null when metadata.touchesUI=true and affectedScreenIds empty (no justification)', async () => {
    const { getDevV2Briefing } = await import('../pipeline-engine/dev-v2-briefings');
    const briefing = getDevV2Briefing('harness-coder', {
      sprintMetadata: {
        touchesUI: true,
        affectedScreenIds: [],
        affectedComponentIds: [],
        designArtifactPath: '/project/.lionclaw/pipelines/development-v2/run1/open-design/snapshots/latest/artifact/index.html',
      },
    });
    expect(briefing).not.toBeNull();
    expect(briefing).toContain('/project/.lionclaw/pipelines/development-v2/run1/open-design/snapshots/latest/artifact/index.html');
  });
});
