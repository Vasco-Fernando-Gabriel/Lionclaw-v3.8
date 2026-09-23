export type OpenDesignProviderMode = 'local-cli' | 'api-byok';

export interface PreflightResult {
  ok: boolean;
  vendorRoot: string;
  status: 'ready' | 'deps-missing' | 'vendor-missing';
  reason?: string;
}

export type BootInstallStatus =
  | { kind: 'idle' }
  | { kind: 'installing'; runner: 'pnpm' | 'corepack' | 'npx'; startedAt: string }
  | { kind: 'ready'; finishedAt: string }
  | { kind: 'failed'; error: string; failedAt: string };

export type BootInstallStreamEvent =
  | { kind: 'start'; runner: 'pnpm' | 'corepack' | 'npx' }
  | { kind: 'stdout'; chunk: string }
  | { kind: 'stderr'; chunk: string }
  | { kind: 'exit'; code: number | null; signal: NodeJS.Signals | null }
  | { kind: 'error'; message: string };

export interface BootstrapResult {
  openDesignProjectId: string;
  conversationId: string;
  webUrl: string;
  initialPromptHash: string;
  initialPromptSentAt: string;
  bootstrappedAt: string;
}

export type OpenDesignEnsureResult = BootstrapResult | { error: string };

export interface OpenDesignStartStatus {
  driveEngaged: boolean;
  startPending: boolean;
}

export type OpenDesignBootstrapStage =
  | 'run-dir'
  | 'design-briefing'
  | 'design-briefing-validator'
  | 'sidecar'
  | 'od-config'
  | 'od-project'
  | 'conversation'
  | 'prompt'
  | 'prompt-injection'
  | 'prompt-verification'
  | 'studio';

export type OpenDesignBootstrapProgressStatus = 'pending' | 'running' | 'done' | 'warning' | 'error';

export interface OpenDesignBootstrapProgressEvent {
  projectId: string;
  stage: OpenDesignBootstrapStage;
  status: OpenDesignBootstrapProgressStatus;
  label: string;
  detail?: string;
  at: string;
}

export interface LockedSnapshotPaths {
  snapshotDir: string;
  manifestPath: string;
  contractPath: string;
  artifactHtmlPath: string;
}

export interface OpenDesignSessionConfig {
  agentId: string;
  model: string;
  reasoning?: 'low' | 'medium' | 'high';
  designSystemId?: string;
  memoryEnabled: boolean;
  mcpServerIds: string[];
  locale: 'pt-BR' | string;
  configuredAt: string;
}

export interface OpenDesignConfig {
  enabled: boolean;
  providerMode?: OpenDesignProviderMode;
  provider?: string;
  model?: string;
  runId?: string;
  runDir?: string;
  designRevisionId?: string;
  dataDir?: string;
  daemonUrl?: string;
  webUrl?: string;
  locked?: boolean;
  lockedAt?: string;
  snapshotDir?: string;
  manifestPath?: string;
  contractPath?: string;
  artifactHtmlPath?: string;
  briefPath?: string;
  lockReportPath?: string;
  pipelineDocsId?: string;
  sessionConfig?: OpenDesignSessionConfig;
  openDesignProjectId?: string;
  conversationId?: string;
  initialPromptHash?: string;
  initialPromptSentAt?: string;
  sessionConfigHash?: string;
  bootstrappedAt?: string;
}

export interface DesignNavigationItem {
  id: string;
  label: string;
  targetScreenId: string;
  userStoryIds: string[];
}

export interface DesignAction {
  id: string;
  label: string;
  type: 'navigate' | 'submit' | 'filter' | 'open-modal' | 'close-modal' | 'toggle' | 'download' | 'upload' | 'other';
  targetScreenId?: string;
  userStoryIds: string[];
  apiExpectationIds?: string[];
}

export interface DesignScreen {
  id: string;
  title: string;
  route: string;
  purpose: string;
  userStoryIds: string[];
  states: Array<'loading' | 'empty' | 'error' | 'success' | 'disabled' | 'readonly'>;
  actions: DesignAction[];
  dataRequirementIds: string[];
}

export interface DesignComponent {
  id: string;
  name: string;
  type:
    | 'layout'
    | 'navigation'
    | 'form'
    | 'table'
    | 'card'
    | 'chart'
    | 'modal'
    | 'drawer'
    | 'chat'
    | 'calendar'
    | 'kanban'
    | 'other';
  usedInScreenIds: string[];
  props?: Record<string, string>;
  states?: string[];
}

export interface DesignDataRequirement {
  id: string;
  name: string;
  description: string;
  entityHint?: string;
  fields: Array<{ name: string; typeHint: string; required: boolean }>;
  sourceScreenIds: string[];
  userStoryIds: string[];
}

export interface DesignApiExpectation {
  id: string;
  operation: string;
  screenIds: string[];
  actionIds: string[];
  methodHint?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  requestShape?: Record<string, string>;
  responseShape?: Record<string, string>;
  userStoryIds: string[];
}

export interface DesignDelta {
  id: string;
  type: 'new-screen' | 'new-feature' | 'new-data' | 'new-permission' | 'scope-change' | 'unclear';
  description: string;
  impact: 'low' | 'medium' | 'high';
  relatedUserStoryIds: string[];
  requiresRequirementsChange: boolean;
}

export interface DesignContract {
  version: '1.0';
  source?: {
    openDesignProjectId?: string;
    artifactPath: string;
    lockedAt?: string;
    htmlSha256?: string;
  };
  visual: {
    direction: string;
    designSystem?: string;
    density: 'dense' | 'balanced' | 'editorial' | 'mobile-first' | 'unknown';
    tokens: {
      colors: Record<string, string>;
      typography: Record<string, string>;
      spacing: Record<string, string>;
      radii: Record<string, string>;
    };
  };
  navigation: {
    primary: DesignNavigationItem[];
    secondary?: DesignNavigationItem[];
  };
  screens: DesignScreen[];
  components: DesignComponent[];
  dataRequirements: DesignDataRequirement[];
  apiExpectations: DesignApiExpectation[];
  deltas: DesignDelta[];
}

export function isValidDesignContract(input: unknown): input is DesignContract {
  return collectDesignContractIssues(input).length === 0;
}

export function collectDesignContractIssues(input: unknown): string[] {
  const issues: string[] = [];

  if (typeof input !== 'object' || input === null) {
    issues.push('Root: JSON precisa ser um object literal `{...}` no topo. Nao pode ser array nem string.');
    return issues;
  }
  const c = input as Record<string, unknown>;

  if (c['version'] !== '1.0') {
    issues.push('Falta campo obrigatorio `version: "1.0"` no topo (literal string "1.0").');
  }

  if (typeof c['visual'] !== 'object' || c['visual'] === null) {
    issues.push('Falta campo obrigatorio `visual: { direction, density, tokens }` no topo (object).');
  } else {
    const visual = c['visual'] as Record<string, unknown>;
    if (typeof visual['direction'] !== 'string') {
      issues.push(
        'Falta `visual.direction` (string descrevendo a direcao visual, ex: "editorial dark com acento sage").',
      );
    }
    if (typeof visual['tokens'] !== 'object' || visual['tokens'] === null) {
      issues.push('Falta `visual.tokens` (object obrigatorio).');
    } else {
      const tokens = visual['tokens'] as Record<string, unknown>;
      if (typeof tokens['colors'] !== 'object' || tokens['colors'] === null) {
        issues.push('Falta `visual.tokens.colors` (object com chaves arbitrarias, mesmo que basico).');
      }
      if (typeof tokens['typography'] !== 'object' || tokens['typography'] === null) {
        issues.push('Falta `visual.tokens.typography` (object com chaves arbitrarias, mesmo que so 1 entrada).');
      }
      if (typeof tokens['spacing'] !== 'object' || tokens['spacing'] === null) {
        issues.push('Falta `visual.tokens.spacing` (object com chaves arbitrarias, mesmo que so 1 entrada).');
      }
      if (typeof tokens['radii'] !== 'object' || tokens['radii'] === null) {
        issues.push('Falta `visual.tokens.radii` (object com chaves arbitrarias, mesmo que so 1 entrada).');
      }
    }
  }

  if (typeof c['navigation'] !== 'object' || c['navigation'] === null) {
    issues.push('Falta `navigation: { primary: [...], secondary?: [...] }` no topo (object).');
  } else {
    const nav = c['navigation'] as Record<string, unknown>;
    if (!Array.isArray(nav['primary'])) {
      issues.push('Falta `navigation.primary` (array de itens com `{ id: string, userStoryIds: string[] }`).');
    } else {
      (nav['primary'] as unknown[]).forEach((item, i) => {
        if (typeof item !== 'object' || item === null) {
          issues.push(`navigation.primary[${i}] precisa ser object \`{ id, userStoryIds }\`.`);
          return;
        }
        const n = item as Record<string, unknown>;
        if (typeof n['id'] !== 'string') issues.push(`navigation.primary[${i}].id ausente ou nao-string.`);
        if (!Array.isArray(n['userStoryIds']))
          issues.push(`navigation.primary[${i}].userStoryIds precisa ser array (use ["US-XX"] ou [] se nao houver).`);
      });
    }
  }

  if (!Array.isArray(c['screens'])) {
    issues.push(
      'Falta `screens` (array no topo). Cada item: `{ id: string, userStoryIds: string[], ...campos extras OK }`.',
    );
  } else {
    (c['screens'] as unknown[]).forEach((item, i) => {
      if (typeof item !== 'object' || item === null) {
        issues.push(`screens[${i}] precisa ser object.`);
        return;
      }
      const s = item as Record<string, unknown>;
      if (typeof s['id'] !== 'string') issues.push(`screens[${i}].id ausente ou nao-string.`);
      if (!Array.isArray(s['userStoryIds'])) {
        issues.push(
          `screens[${i}].userStoryIds precisa ser array de strings (NAO use "covers" nem "acceptance_criteria_visualized" como substituto — use "userStoryIds": ["US-01", "US-02", ...]).`,
        );
      }
    });
  }

  if (!Array.isArray(c['components'])) {
    issues.push(
      'Falta `components` (array no topo). Cada item: `{ id: string, ...campos extras OK }`. Pode ser array vazio `[]`.',
    );
  } else {
    (c['components'] as unknown[]).forEach((item, i) => {
      if (typeof item !== 'object' || item === null) {
        issues.push(`components[${i}] precisa ser object com pelo menos { id }.`);
        return;
      }
      const comp = item as Record<string, unknown>;
      if (typeof comp['id'] !== 'string') issues.push(`components[${i}].id ausente ou nao-string.`);
    });
  }

  if (!Array.isArray(c['dataRequirements'])) {
    issues.push('Falta `dataRequirements` (array no topo). Pode ser `[]` se nenhum dado for necessario.');
  } else {
    (c['dataRequirements'] as unknown[]).forEach((item, i) => {
      if (typeof item !== 'object' || item === null) {
        issues.push(
          `dataRequirements[${i}] precisa ser object com pelo menos { id, fields, sourceScreenIds, userStoryIds }.`,
        );
        return;
      }
      const dr = item as Record<string, unknown>;
      if (typeof dr['id'] !== 'string') issues.push(`dataRequirements[${i}].id ausente ou nao-string.`);
      if (!Array.isArray(dr['fields'])) issues.push(`dataRequirements[${i}].fields precisa ser array (pode ser []).`);
      if (!Array.isArray(dr['sourceScreenIds']))
        issues.push(`dataRequirements[${i}].sourceScreenIds precisa ser array (pode ser []).`);
      if (!Array.isArray(dr['userStoryIds']))
        issues.push(`dataRequirements[${i}].userStoryIds precisa ser array (use ["US-XX"] ou [] se nao houver).`);
    });
  }

  if (!Array.isArray(c['apiExpectations'])) {
    issues.push('Falta `apiExpectations` (array no topo). Pode ser `[]` se nenhum endpoint for necessario.');
  } else {
    (c['apiExpectations'] as unknown[]).forEach((item, i) => {
      if (typeof item !== 'object' || item === null) {
        issues.push(
          `apiExpectations[${i}] precisa ser object com pelo menos { id, operation, screenIds, actionIds, userStoryIds }.`,
        );
        return;
      }
      const api = item as Record<string, unknown>;
      if (typeof api['id'] !== 'string') issues.push(`apiExpectations[${i}].id ausente ou nao-string.`);
      if (typeof api['operation'] !== 'string') issues.push(`apiExpectations[${i}].operation ausente ou nao-string.`);
      if (!Array.isArray(api['screenIds']))
        issues.push(`apiExpectations[${i}].screenIds precisa ser array (pode ser []).`);
      if (!Array.isArray(api['actionIds']))
        issues.push(`apiExpectations[${i}].actionIds precisa ser array (pode ser []).`);
      if (!Array.isArray(api['userStoryIds']))
        issues.push(`apiExpectations[${i}].userStoryIds precisa ser array (use ["US-XX"] ou [] se nao houver).`);
    });
  }

  if (!Array.isArray(c['deltas'])) {
    issues.push(
      'Falta `deltas` (array no topo). Pode ser `[]`. Cada item (se houver): `{ id: string, summary: string }`.',
    );
  } else {
    (c['deltas'] as unknown[]).forEach((item, i) => {
      if (typeof item !== 'object' || item === null) {
        issues.push(`deltas[${i}] precisa ser object com pelo menos { id }.`);
        return;
      }
      const d = item as Record<string, unknown>;
      if (typeof d['id'] !== 'string') issues.push(`deltas[${i}].id ausente ou nao-string.`);
      if (!Array.isArray(d['relatedUserStoryIds']))
        issues.push(`deltas[${i}].relatedUserStoryIds precisa ser array (pode ser []).`);
    });
  }

  return issues;
}
