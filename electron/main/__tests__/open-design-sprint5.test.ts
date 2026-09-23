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
  getHarnessProject: vi.fn(() => null),
}));

import * as configMod from '../open-design/config';

import { storyRequiresUI } from '../open-design/validator';

describe('storyRequiresUI', () => {
  const positives: string[] = [
    'Como usuario, quero ver a tela de relatorios.',
    'Como admin, devo ter acesso ao menu principal.',
    'Deve exibir um dashboard com graficos.',
    'Formulario de cadastro com botao de submit.',
    'Tela de login com lista de usuarios.',
    'Navigation bar deve estar visivel.',
    'Modal de confirmacao ao deletar.',
    'O chart de vendas deve ser interativo.',
    'Clique no botao para navegar.',
    'O painel de controle exibe cards.',
    'A page deve renderizar corretamente.',
    'Screen for user profile.',
    'Drawer opens on click.',
    'Kanban board com colunas.',
    'Calendar view exibe eventos.',
    'Table com ordenacao.',
    'Grafico de barras mensal.',
    'Form para criar usuario.',
    'Mostrar feedback ao usuario.',
    'Visualizar historico de pedidos.',
    'UI flow para checkout.',
    'Fluxo de UI de pagamento.',
  ];

  const negatives: string[] = [
    'Como sistema, devo logar evento X no banco.',
    'O servico deve processar webhooks assincronamente.',
    'Migration de dados legados para novo schema.',
    'Integrar API de pagamento via REST.',
    'Configurar rate limiting no backend.',
    'Criar job de limpeza de cache.',
    'Health check endpoint deve retornar 200.',
  ];

  for (const text of positives) {
    it(`matches UI keyword: "${text.slice(0, 60)}"`, () => {
      expect(storyRequiresUI(text)).toBe(true);
    });
  }

  for (const text of negatives) {
    it(`does NOT match: "${text.slice(0, 60)}"`, () => {
      expect(storyRequiresUI(text)).toBe(false);
    });
  }

  it('is case-insensitive for single keywords', () => {
    expect(storyRequiresUI('TELA de login')).toBe(true);
    expect(storyRequiresUI('SCREEN rendering')).toBe(true);
  });

  it('matches multi-word "fluxo de UI"', () => {
    expect(storyRequiresUI('Define o fluxo de UI para onboarding.')).toBe(true);
  });

  it('matches "ui flow"', () => {
    expect(storyRequiresUI('Define the UI flow for checkout.')).toBe(true);
  });
});

import type { DesignContract } from '../../../src/types/open-design';

function makeContract(overrides: Partial<DesignContract> = {}): DesignContract {
  return {
    version: '1.0',
    visual: {
      direction: 'Clean minimal',
      density: 'balanced',
      tokens: { colors: {}, typography: {}, spacing: {}, radii: {} },
    },
    navigation: {
      primary: [{ id: 'nav-home', label: 'Home', targetScreenId: 'screen-home', userStoryIds: ['US-01'] }],
    },
    screens: [
      {
        id: 'screen-home',
        title: 'Home',
        route: '/',
        purpose: 'Landing',
        userStoryIds: ['US-01'],
        states: ['loading', 'success'],
        actions: [
          {
            id: 'action-goto-list',
            label: 'Ver Lista',
            type: 'navigate',
            targetScreenId: 'screen-list',
            userStoryIds: ['US-01'],
          },
        ],
        dataRequirementIds: [],
      },
    ],
    components: [],
    dataRequirements: [],
    apiExpectations: [],
    deltas: [],
    ...overrides,
  };
}

function setupTempProject(contract: DesignContract | null, htmlContent?: string) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lionclaw-sprint5-test-'));
  const runDir = tmpDir;
  const snapshotDir = path.join(runDir, 'open-design', 'snapshots', 'latest');
  const artifactDir = path.join(snapshotDir, 'artifact');
  fs.mkdirSync(artifactDir, { recursive: true });

  const htmlPath = path.join(artifactDir, 'index.html');
  const contractPath = path.join(snapshotDir, 'design-contract.json');

  const embedded = contract
    ? `<script type="application/json" id="lionclaw-design-contract">${JSON.stringify(contract)}</script>`
    : '';
  const html = htmlContent ?? `<html><body>${embedded}</body></html>`;
  fs.writeFileSync(htmlPath, html, 'utf-8');

  if (contract) {
    fs.writeFileSync(contractPath, JSON.stringify(contract, null, 2), 'utf-8');
  }

  return { tmpDir, runDir, snapshotDir, htmlPath, contractPath };
}

import { validateLock } from '../open-design/validator';

describe('validateLock — 13 rules', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  async function runValidator(
    runDir: string,
    _contract: DesignContract | null,
    htmlExists = true,
    opts: { pipelineDocsId?: string } = {},
  ) {
    (configMod.getOpenDesignConfig as ReturnType<typeof vi.fn>).mockReturnValue({
      runDir,
      pipelineDocsId: opts.pipelineDocsId ?? 'test123',
    });

    const htmlPath = path.join(runDir, 'open-design', 'snapshots', 'latest', 'artifact', 'index.html');
    if (!htmlExists && fs.existsSync(htmlPath)) fs.unlinkSync(htmlPath);

    return validateLock('test-project-id');
  }

  it('rule 10.2.1 — fails when HTML missing', async () => {
    const { tmpDir, runDir } = setupTempProject(makeContract());
    try {
      const result = await runValidator(runDir, null, false);
      expect(result.ok).toBe(false);
      expect(result.problems.some((p) => p.rule === '10.2.1')).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rule 10.2.2 — fails when no valid contract in HTML', async () => {
    const { tmpDir, runDir, snapshotDir } = setupTempProject(null, '<html><body>no contract here</body></html>');
    const contractPath = path.join(snapshotDir, 'design-contract.json');
    if (fs.existsSync(contractPath)) fs.unlinkSync(contractPath);
    try {
      const result = await runValidator(runDir, null);
      expect(result.ok).toBe(false);
      expect(result.problems.some((p) => p.rule === '10.2.2')).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rule 10.2.2 — reports malformed apiExpectation arrays instead of throwing', async () => {
    const contract = makeContract({
      apiExpectations: [
        {
          id: 'api-create-user',
          operation: 'POST /users',
          screenIds: ['screen-home'],
          userStoryIds: ['US-01'],
        } as unknown as DesignContract['apiExpectations'][number],
      ],
    });
    const { tmpDir, runDir } = setupTempProject(contract);
    try {
      const result = await runValidator(runDir, contract);
      expect(result.ok).toBe(false);
      expect(result.problems.some((p) => p.rule === '10.2.2' && p.hint.includes('apiExpectations[0].actionIds'))).toBe(
        true,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rule 10.2.3 — fails when screen has no userStoryIds', async () => {
    const contract = makeContract({
      screens: [
        {
          id: 'screen-orphan',
          title: 'Orphan Screen',
          route: '/orphan',
          purpose: 'Test',
          userStoryIds: [],
          states: [],
          actions: [],
          dataRequirementIds: [],
        },
      ],
    });
    const { tmpDir, runDir } = setupTempProject(contract);
    try {
      const result = await runValidator(runDir, contract);
      expect(result.ok).toBe(false);
      expect(result.problems.some((p) => p.rule === '10.2.3')).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rule 10.2.4 — fails when navigation item has no userStoryIds', async () => {
    const contract = makeContract({
      navigation: {
        primary: [
          {
            id: 'nav-orphan',
            label: 'Novo Menu',
            targetScreenId: 'screen-home',
            userStoryIds: [],
          },
        ],
      },
    });
    const { tmpDir, runDir } = setupTempProject(contract);
    try {
      const result = await runValidator(runDir, contract);
      expect(result.ok).toBe(false);
      expect(result.problems.some((p) => p.rule === '10.2.4')).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rule 10.2.5 — fails when primary action (submit) has no userStoryIds', async () => {
    const contract = makeContract({
      screens: [
        {
          id: 'screen-home',
          title: 'Home',
          route: '/',
          purpose: 'Landing',
          userStoryIds: ['US-01'],
          states: [],
          actions: [{ id: 'action-submit', label: 'Submit', type: 'submit', userStoryIds: [] }],
          dataRequirementIds: [],
        },
      ],
    });
    const { tmpDir, runDir } = setupTempProject(contract);
    try {
      const result = await runValidator(runDir, contract);
      expect(result.ok).toBe(false);
      expect(result.problems.some((p) => p.rule === '10.2.5')).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rule 10.2.6 — fails when delta has requiresRequirementsChange=true', async () => {
    const contract = makeContract({
      deltas: [
        {
          id: 'delta-1',
          type: 'new-permission',
          description: 'Needs new admin permission',
          impact: 'high',
          relatedUserStoryIds: [],
          requiresRequirementsChange: true,
        },
      ],
    });
    const { tmpDir, runDir } = setupTempProject(contract);
    try {
      const result = await runValidator(runDir, contract);
      expect(result.ok).toBe(false);
      expect(result.problems.some((p) => p.rule === '10.2.6')).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rule 10.2.7 — fails when new-screen delta has no related stories', async () => {
    const contract = makeContract({
      deltas: [
        {
          id: 'delta-new-screen',
          type: 'new-screen',
          description: 'Added analytics screen without story',
          impact: 'medium',
          relatedUserStoryIds: [],
          requiresRequirementsChange: false,
        },
      ],
    });
    const { tmpDir, runDir } = setupTempProject(contract);
    try {
      const result = await runValidator(runDir, contract);
      expect(result.ok).toBe(false);
      expect(result.problems.some((p) => p.rule === '10.2.7')).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rule 10.2.8 — fails when dataRequirement has no userStoryIds', async () => {
    const contract = makeContract({
      dataRequirements: [
        {
          id: 'dr-1',
          name: 'UserProfile',
          description: 'User profile data',
          fields: [{ name: 'email', typeHint: 'string', required: true }],
          sourceScreenIds: [],
          userStoryIds: [],
        },
      ],
    });
    const { tmpDir, runDir } = setupTempProject(contract);
    try {
      const result = await runValidator(runDir, contract);
      expect(result.ok).toBe(false);
      expect(result.problems.some((p) => p.rule === '10.2.8')).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rule 10.2.9 — fails when apiExpectation has no action or screen', async () => {
    const contract = makeContract({
      apiExpectations: [
        {
          id: 'api-1',
          operation: 'GET /users',
          screenIds: [],
          actionIds: [],
          userStoryIds: ['US-01'],
        },
      ],
    });
    const { tmpDir, runDir } = setupTempProject(contract);
    try {
      const result = await runValidator(runDir, contract);
      expect(result.ok).toBe(false);
      expect(result.problems.some((p) => p.rule === '10.2.9')).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rule 10.2.10 — skipped gracefully when stories file not found', async () => {
    const contract = makeContract();
    const { tmpDir, runDir } = setupTempProject(contract);
    try {
      const result = await runValidator(runDir, contract, true, { pipelineDocsId: 'notexistent99999' });
      expect(typeof result.ok).toBe('boolean');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rule 10.2.11 — fails when submit action has no apiExpectation', async () => {
    const contract = makeContract({
      screens: [
        {
          id: 'screen-form',
          title: 'Create User',
          route: '/users/new',
          purpose: 'Form',
          userStoryIds: ['US-01'],
          states: [],
          actions: [
            {
              id: 'action-create-user',
              label: 'Criar Usuario',
              type: 'submit',
              userStoryIds: ['US-01'],
            },
          ],
          dataRequirementIds: [],
        },
      ],
      apiExpectations: [],
    });
    const { tmpDir, runDir } = setupTempProject(contract);
    try {
      const result = await runValidator(runDir, contract);
      expect(result.ok).toBe(false);
      expect(result.problems.some((p) => p.rule === '10.2.11')).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rule 10.2.12 — fails when dataRequirement not consumed by any screen', async () => {
    const contract = makeContract({
      screens: [
        {
          id: 'screen-home',
          title: 'Home',
          route: '/',
          purpose: 'Landing',
          userStoryIds: ['US-01'],
          states: [],
          actions: [],
          dataRequirementIds: [], // dr-orphan NOT referenced here
        },
      ],
      dataRequirements: [
        {
          id: 'dr-orphan',
          name: 'OrphanData',
          description: 'Not used by any screen',
          fields: [],
          sourceScreenIds: [],
          userStoryIds: ['US-01'],
        },
      ],
    });
    const { tmpDir, runDir } = setupTempProject(contract);
    try {
      const result = await runValidator(runDir, contract);
      expect(result.ok).toBe(false);
      expect(result.problems.some((p) => p.rule === '10.2.12')).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rule 10.2.13 — fails when duplicate IDs exist across screens', async () => {
    const contract = makeContract({
      screens: [
        {
          id: 'screen-dup',
          title: 'Screen A',
          route: '/a',
          purpose: 'A',
          userStoryIds: ['US-01'],
          states: [],
          actions: [],
          dataRequirementIds: [],
        },
        {
          id: 'screen-dup', // DUPLICATE
          title: 'Screen B',
          route: '/b',
          purpose: 'B',
          userStoryIds: ['US-01'],
          states: [],
          actions: [],
          dataRequirementIds: [],
        },
      ],
    });
    const { tmpDir, runDir } = setupTempProject(contract);
    try {
      const result = await runValidator(runDir, contract);
      expect(result.ok).toBe(false);
      expect(result.problems.some((p) => p.rule === '10.2.13')).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('passes all rules when contract is fully compliant', async () => {
    const contract: DesignContract = {
      version: '1.0',
      visual: {
        direction: 'Clean minimal',
        density: 'balanced',
        tokens: { colors: { primary: '#3B82F6' }, typography: {}, spacing: {}, radii: {} },
      },
      navigation: {
        primary: [
          {
            id: 'nav-home',
            label: 'Home',
            targetScreenId: 'screen-home',
            userStoryIds: ['US-01'],
          },
        ],
      },
      screens: [
        {
          id: 'screen-home',
          title: 'Home',
          route: '/',
          purpose: 'Landing page',
          userStoryIds: ['US-01'],
          states: ['loading', 'success'],
          actions: [
            {
              id: 'action-go-form',
              label: 'Criar',
              type: 'navigate',
              targetScreenId: 'screen-form',
              userStoryIds: ['US-02'],
            },
          ],
          dataRequirementIds: ['dr-users'],
        },
        {
          id: 'screen-form',
          title: 'Novo Usuario',
          route: '/users/new',
          purpose: 'Create form',
          userStoryIds: ['US-02'],
          states: ['error', 'success'],
          actions: [
            {
              id: 'action-submit-user',
              label: 'Salvar',
              type: 'submit',
              userStoryIds: ['US-02'],
              apiExpectationIds: ['api-create-user'],
            },
          ],
          dataRequirementIds: ['dr-users'],
        },
      ],
      components: [
        {
          id: 'comp-table',
          name: 'UserTable',
          type: 'table',
          usedInScreenIds: ['screen-home'],
        },
      ],
      dataRequirements: [
        {
          id: 'dr-users',
          name: 'Users',
          description: 'User entity',
          fields: [{ name: 'email', typeHint: 'string', required: true }],
          sourceScreenIds: ['screen-form'],
          userStoryIds: ['US-01', 'US-02'],
        },
      ],
      apiExpectations: [
        {
          id: 'api-create-user',
          operation: 'POST /users',
          screenIds: ['screen-form'],
          actionIds: ['action-submit-user'],
          methodHint: 'POST',
          userStoryIds: ['US-02'],
        },
      ],
      deltas: [],
    };

    const { tmpDir, runDir } = setupTempProject(contract);
    try {
      const result = await runValidator(runDir, contract);
      expect(result.ok).toBe(true);
      expect(result.problems).toHaveLength(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

import {
  DEVELOPMENT_V2_RESETABLE_PHASES_BEFORE_LOCK,
  DEVELOPMENT_V2_RESETABLE_PHASES_AFTER_LOCK,
} from '../../../src/types/pipeline';

describe('getResetablePhases — locked=true disables design phases, enables 7-15', () => {
  it('BEFORE lock set: phases 4 and 5 are included, phase 6 is NOT', () => {
    expect(DEVELOPMENT_V2_RESETABLE_PHASES_BEFORE_LOCK.has(4)).toBe(true);
    expect(DEVELOPMENT_V2_RESETABLE_PHASES_BEFORE_LOCK.has(5)).toBe(true);
    expect(DEVELOPMENT_V2_RESETABLE_PHASES_BEFORE_LOCK.has(6)).toBe(false);
  });

  it('AFTER lock set: phases 4 and 5 are NOT included', () => {
    expect(DEVELOPMENT_V2_RESETABLE_PHASES_AFTER_LOCK.has(4)).toBe(false);
    expect(DEVELOPMENT_V2_RESETABLE_PHASES_AFTER_LOCK.has(5)).toBe(false);
  });

  it('AFTER lock set: phases 7-15 are all included', () => {
    for (let p = 7; p <= 15; p++) {
      expect(DEVELOPMENT_V2_RESETABLE_PHASES_AFTER_LOCK.has(p)).toBe(true);
    }
  });

  it('DEVELOPMENT_V2_RESETABLE_PHASES_BEFORE_LOCK has exactly {1,2,3,4,5}', () => {
    expect(DEVELOPMENT_V2_RESETABLE_PHASES_BEFORE_LOCK).toEqual(new Set([1, 2, 3, 4, 5]));
  });

  it('DEVELOPMENT_V2_RESETABLE_PHASES_AFTER_LOCK has exactly {7..15}', () => {
    expect(DEVELOPMENT_V2_RESETABLE_PHASES_AFTER_LOCK).toEqual(new Set([7, 8, 9, 10, 11, 12, 13, 14, 15]));
  });
});
