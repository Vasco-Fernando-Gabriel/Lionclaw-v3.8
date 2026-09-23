import { describe, it, expect } from 'vitest';
import type { DesignContract } from '../../../src/types/open-design';
import { buildBrief } from '../open-design/brief-builder';

const MINIMAL_CONTRACT: DesignContract = {
  version: '1.0',
  source: { artifactPath: 'artifact/index.html' },
  visual: {
    direction: 'Tech Utility',
    designSystem: 'Neutral Modern',
    density: 'dense',
    tokens: {
      colors: { primary: '#3b82f6', background: '#0f0f10' },
      typography: { body: '14px Inter' },
      spacing: { base: '8px' },
      radii: { md: '6px' },
    },
  },
  navigation: {
    primary: [
      { id: 'nav-dashboard', label: 'Dashboard', targetScreenId: 'screen-dash', userStoryIds: ['US-1'] },
      { id: 'nav-settings', label: 'Settings', targetScreenId: 'screen-settings', userStoryIds: ['US-2'] },
    ],
  },
  screens: [
    {
      id: 'screen-dash',
      title: 'Dashboard',
      route: '/dashboard',
      purpose: 'Overview',
      userStoryIds: ['US-1'],
      states: ['loading', 'empty'],
      actions: [],
      dataRequirementIds: [],
    },
    {
      id: 'screen-settings',
      title: 'Settings',
      route: '/settings',
      purpose: 'User preferences',
      userStoryIds: ['US-2'],
      states: ['loading'],
      actions: [],
      dataRequirementIds: [],
    },
  ],
  components: [
    { id: 'comp-header', name: 'AppHeader', type: 'layout', usedInScreenIds: ['screen-dash'] },
    { id: 'comp-sidebar', name: 'Sidebar', type: 'navigation', usedInScreenIds: ['screen-dash', 'screen-settings'] },
  ],
  dataRequirements: [],
  apiExpectations: [],
  deltas: [
    {
      id: 'delta-1',
      type: 'new-screen',
      description: 'Added an admin panel not in stories',
      impact: 'high',
      relatedUserStoryIds: [],
      requiresRequirementsChange: true,
    },
  ],
};

const CONTRACT_EMPTY_TOKENS: DesignContract = {
  ...MINIMAL_CONTRACT,
  visual: {
    direction: 'Editorial',
    density: 'editorial',
    tokens: { colors: {}, typography: {}, spacing: {}, radii: {} },
  },
  deltas: [],
  screens: [],
  navigation: { primary: [] },
  components: [],
};

describe('buildBrief', () => {
  it('returns a non-empty Markdown string', () => {
    const md = buildBrief(MINIMAL_CONTRACT);
    expect(typeof md).toBe('string');
    expect(md.length).toBeGreaterThan(0);
  });

  it('contains the h1 header', () => {
    const md = buildBrief(MINIMAL_CONTRACT);
    expect(md).toContain('# Design Brief');
  });

  it('contains Direcao Visual section', () => {
    const md = buildBrief(MINIMAL_CONTRACT);
    expect(md).toContain('## Direcao Visual');
    expect(md).toContain('Tech Utility');
  });

  it('contains Tokens section', () => {
    const md = buildBrief(MINIMAL_CONTRACT);
    expect(md).toContain('## Tokens');
  });

  it('contains Mapa de Telas section with screen info', () => {
    const md = buildBrief(MINIMAL_CONTRACT);
    expect(md).toContain('## Mapa de Telas');
    expect(md).toContain('Dashboard');
    expect(md).toContain('/dashboard');
    expect(md).toContain('US-1');
  });

  it('contains Navegacao Principal section with nav items', () => {
    const md = buildBrief(MINIMAL_CONTRACT);
    expect(md).toContain('## Navegacao Principal');
    expect(md).toContain('nav-dashboard');
    expect(md).toContain('nav-settings');
  });

  it('contains Componentes Principais section', () => {
    const md = buildBrief(MINIMAL_CONTRACT);
    expect(md).toContain('## Componentes Principais');
    expect(md).toContain('AppHeader');
    expect(md).toContain('Sidebar');
  });

  it('contains Deltas section when deltas exist', () => {
    const md = buildBrief(MINIMAL_CONTRACT);
    expect(md).toContain('## Deltas');
    expect(md).toContain('delta-1');
    expect(md).toContain('REQUER MUDANCA DE REQUISITOS');
  });

  it('does NOT include Deltas section when deltas array is empty', () => {
    const md = buildBrief(CONTRACT_EMPTY_TOKENS);
    expect(md).not.toContain('## Deltas');
  });

  it('skips token tables when token objects are empty', () => {
    const md = buildBrief(CONTRACT_EMPTY_TOKENS);
    expect(md).not.toContain('### Cores');
    expect(md).not.toContain('### Tipografia');
  });

  it('shows "(nenhuma tela declarada)" when screens is empty', () => {
    const md = buildBrief(CONTRACT_EMPTY_TOKENS);
    expect(md).toContain('nenhuma tela declarada');
  });

  it('shows "(nenhum item de navegacao declarado)" when primary nav is empty', () => {
    const md = buildBrief(CONTRACT_EMPTY_TOKENS);
    expect(md).toContain('nenhum item de navegacao declarado');
  });

  it('includes designSystem in output when provided', () => {
    const md = buildBrief(MINIMAL_CONTRACT);
    expect(md).toContain('Neutral Modern');
  });
});
