
import type { PipelineType } from '../types/pipeline';
import type { LocalRepositoryRecord } from '../types/repo-graph';


export type PipelineHandoffType = PipelineType;

export interface PipelineHandoffRequest {
  source: 'pipeline';
  pipelineType: PipelineHandoffType;
  projectId: string;
  projectName: string;
  projectPath: string | null;
  specPath?: string | null;
  bugOutcome?: 'pending' | 'fix' | 'no-bug';
  bugRunId?: string | null;
}

export interface WorkflowHandoffRequest {
  source: 'workflow';
  projectId: string;
  projectName: string;
  projectPath: string | null;
  branch?: string | null;
  workflowSummary?: string;
}

export type HandoffRequest = PipelineHandoffRequest | WorkflowHandoffRequest;


export interface GraphHint {
  state: 'ready' | 'stale' | 'unavailable';
}

type HandoffVariantKey =
  | 'pipeline:development'
  | 'pipeline:feature'
  | 'pipeline:development-v2'
  | 'pipeline:security'
  | 'pipeline:architecture-review'
  | 'pipeline:bug'
  | 'workflow';

type PromptBuilder = (req: HandoffRequest, graph: GraphHint) => string;

const WORKFLOW_SUMMARY_MAX = 1200;

function readableLabel(req: HandoffRequest): string {
  return req.source === 'workflow' ? 'workflow' : req.pipelineType;
}

function commonHeader(req: HandoffRequest, graph: GraphHint): string {
  const lines: string[] = [];
  lines.push(
    `Projeto: ${req.projectName} (id ${req.projectId}, pipeline ${readableLabel(req)}).`,
  );
  if (req.projectPath) {
    lines.push(`Pasta do projeto: ${req.projectPath}.`);
  }
  if (graph.state === 'unavailable') {
    lines.push(
      'Observacao: este repositorio ainda nao foi indexado pelo CodeGraph. Trabalhe lendo os arquivos diretamente depois que voce me informar a pasta.',
    );
  } else {
    lines.push(
      'O CodeGraph foi solicitado para este repositorio; se estiver disponivel no contexto, use-o antes de ler arquivos manualmente.',
    );
  }
  return lines.join('\n');
}

function specLine(req: HandoffRequest, prefix: string): string | null {
  if (req.source !== 'pipeline') return null;
  const specPath = req.specPath;
  if (!specPath) return null;
  return `${prefix} ${specPath}`;
}

function runProjectPrompt(req: HandoffRequest, graph: GraphHint): string {
  if (!req.projectPath) return fallbackNoPathPrompt(req, graph);
  const steps: string[] = [
    '1. Inspecione a pasta e descubra como rodar este projeto: gerenciador de pacotes, scripts de build/dev, variaveis de ambiente necessarias, e dependencias de sistema.',
    '2. Liste os comandos exatos, na ordem, para instalar dependencias, aplicar migracoes (se houver banco) e subir a aplicacao.',
    '3. Aponte qualquer configuracao obrigatoria (arquivos .env, segredos, servicos externos) que eu preciso preencher antes de rodar.',
  ];
  const spec = specLine(req, '4. Se existir, leia o documento de SPEC em');
  if (spec) {
    steps.push(`${spec} para entender o escopo entregue e o que validar.`);
  }
  return [
    commonHeader(req, graph),
    '',
    'Acabei de concluir um pipeline de desenvolvimento neste repositorio. Quero rodar o projeto localmente.',
    '',
    'Por favor:',
    ...steps,
    '',
    'Comece confirmando o estado do diretorio e o stack detectado. Depois me de o passo a passo para rodar.',
  ].join('\n');
}

function securityValidatePrompt(req: HandoffRequest, graph: GraphHint): string {
  if (!req.projectPath) return fallbackNoPathPrompt(req, graph);
  const steps: string[] = [
    '1. Localize o relatorio consolidado de seguranca deste pipeline no repositorio (procure em .lionclaw/pipelines/security/ ou em arquivos de audit/relatorio) para entender quais vulnerabilidades foram identificadas e quais correcoes deveriam ter sido aplicadas.',
  ];
  const spec = specLine(req, '2. Se existir, leia a SPEC em');
  if (spec) {
    steps.push(`${spec} com o detalhamento das correcoes.`);
  }
  steps.push(
    '3. Confirme, lendo o codigo, que cada correcao foi de fato aplicada e que as vulnerabilidades reportadas estao fechadas.',
  );
  steps.push(
    '4. Rode o build, os testes e as migracoes que existirem, e verifique que nada quebrou com as correcoes.',
  );
  steps.push(
    '5. Aponte qualquer correcao ausente, incompleta, ou que tenha introduzido regressao.',
  );
  return [
    commonHeader(req, graph),
    '',
    'Acabei de concluir um pipeline de SEGURANCA neste repositorio, que aplicou correcoes a partir de uma auditoria. Preciso que voce VALIDE a mudanca.',
    '',
    'Por favor:',
    ...steps,
    '',
    'Comece confirmando o estado do diretorio. Depois me de um veredito: as vulnerabilidades estao fechadas e o projeto continua integro?',
  ].join('\n');
}

function archValidatePrompt(req: HandoffRequest, graph: GraphHint): string {
  if (!req.projectPath) return fallbackNoPathPrompt(req, graph);
  const steps: string[] = [
    '1. Localize as decisoes arquiteturais e o diagnostico deste pipeline no repositorio (procure em .lionclaw/pipelines/architecture-review/) para entender qual refactor foi decidido e por que.',
  ];
  const spec = specLine(req, '2. Se existir, leia a SPEC em');
  if (spec) {
    steps.push(`${spec} com o detalhamento da implementacao.`);
  }
  steps.push(
    '3. Confirme, lendo o codigo, que o refactor foi aplicado conforme as decisoes e que a estrutura nova esta integra (sem imports quebrados, sem dependencias circulares novas, sem codigo morto deixado para tras).',
  );
  steps.push(
    '4. Rode o build, os testes e as migracoes que existirem, e verifique que nada quebrou.',
  );
  steps.push(
    '5. Aponte qualquer divergencia entre o que foi decidido e o que foi implementado.',
  );
  return [
    commonHeader(req, graph),
    '',
    'Acabei de concluir um pipeline de REVISAO ARQUITETURAL neste repositorio, que aplicou um refactor estrutural. Preciso que voce VALIDE a mudanca.',
    '',
    'Por favor:',
    ...steps,
    '',
    'Comece confirmando o estado do diretorio. Depois me de um veredito: o refactor esta integro e o projeto continua funcionando?',
  ].join('\n');
}

function workflowPrompt(req: HandoffRequest, graph: GraphHint): string {
  if (!req.projectPath) return fallbackNoPathPrompt(req, graph);
  const lines: string[] = [commonHeader(req, graph)];
  if (req.source === 'workflow') {
    if (req.branch) {
      lines.push(`Branch da entrega: ${req.branch}.`);
    }
    const summary = (req.workflowSummary ?? '').trim();
    if (summary) {
      lines.push(`Resumo da entrega: ${summary.slice(0, WORKFLOW_SUMMARY_MAX)}`);
    }
  }
  lines.push('');
  lines.push(
    'Acabei de concluir um workflow neste repositorio. Quero continuar a partir da entrega.',
  );
  lines.push('');
  lines.push(
    'Por favor, confirme o estado do diretorio, me diga o que foi entregue e como rodar/validar localmente. Voce pode executar comandos, ler e editar arquivos.',
  );
  return lines.join('\n');
}

function bugPrompt(req: HandoffRequest, graph: GraphHint): string {
  if (!req.projectPath) return fallbackNoPathPrompt(req, graph);
  const outcome = req.source === 'pipeline' ? req.bugOutcome : undefined;
  const runId = req.source === 'pipeline' ? req.bugRunId ?? null : null;
  const planoPath = runId
    ? `${req.projectPath}/.lionclaw/pipelines/bug/${runId}/plano-de-correcao-${runId}.md`
    : `${req.projectPath}/.lionclaw/pipelines/bug/<runId>/plano-de-correcao-<runId>.md`;

  if (outcome === 'no-bug') {
    return [
      commonHeader(req, graph),
      '',
      'Este pipeline de bug foi ENCERRADO SEM CORRECAO: o plano concluiu que nao ha bug a corrigir. Nao houve entrega e nenhum codigo foi escrito por ele.',
      '',
      'Por favor:',
      `1. Leia o plano de correcao em ${planoPath} e o campo "## Desfecho" dele.`,
      '2. Me explique em poucas linhas por que o pipeline concluiu que nao ha bug (causa investigada, o que foi descartado e com qual evidencia).',
      '3. Se voce discordar do desfecho, diga o que ainda precisa ser investigado. NAO comece a corrigir nada sem eu confirmar.',
      '',
      'Comece confirmando o estado do diretorio e lendo o plano. Nao afirme que houve entrega.',
    ].join('\n');
  }

  if (outcome === 'fix') {
    const steps: string[] = [
      `1. Leia o plano de correcao em ${planoPath} para entender a causa consolidada e a correcao proposta.`,
    ];
    const spec = specLine(req, '2. Se existir, leia a SPEC de correcao em');
    if (spec) steps.push(`${spec} com o detalhamento do que foi implementado.`);
    steps.push(
      '3. Confirme, lendo o codigo, que a correcao foi de fato aplicada onde o plano dizia.',
    );
    steps.push(
      '4. Rode o build e os testes (com atencao aos testes de REGRESSAO do bug) e me diga o que passou e o que falhou.',
    );
    return [
      commonHeader(req, graph),
      '',
      'Este pipeline de bug concluiu com uma CORRECAO aplicada. Quero validar a correcao antes de considerar o bug fechado.',
      '',
      'Por favor:',
      ...steps,
      '',
      'Comece confirmando o estado do diretorio e o que mudou (git diff / git log). Se algo do plano nao foi implementado, diga explicitamente.',
    ].join('\n');
  }

  return [
    commonHeader(req, graph),
    '',
    'Este e um pipeline de bug que terminou, mas eu nao tenho aqui o desfecho registrado (correcao aplicada ou encerrado sem correcao).',
    '',
    'Por favor:',
    `1. Leia o plano de correcao em ${planoPath} e me diga o que diz o campo "## Desfecho".`,
    '2. So depois disso conclua se houve correcao aplicada; se houve, confirme no codigo e rode os testes de regressao.',
    '',
    'Comece confirmando o estado do diretorio. NAO afirme que houve entrega antes de ler o plano.',
  ].join('\n');
}

function fallbackNoPathPrompt(req: HandoffRequest, _graph: GraphHint): string {
  return [
    commonHeader(req, { state: 'unavailable' }),
    '',
    'Concluo um pipeline mas nao tenho uma pasta de projeto resolvida para vincular. Me informe a pasta do projeto antes de mexer em arquivos.',
    '',
    'Depois me ajude a continuar: pode executar comandos, ler e editar arquivos. Comece confirmando o estado do diretorio assim que eu te passar o caminho.',
  ].join('\n');
}

const PROMPT_BUILDERS: Record<HandoffVariantKey, PromptBuilder> = {
  'pipeline:development': runProjectPrompt,
  'pipeline:feature': runProjectPrompt,
  'pipeline:development-v2': runProjectPrompt,
  'pipeline:security': securityValidatePrompt,
  'pipeline:architecture-review': archValidatePrompt,
  'pipeline:bug': bugPrompt,
  workflow: workflowPrompt,
};

const variantKey = (req: HandoffRequest): HandoffVariantKey =>
  req.source === 'workflow'
    ? 'workflow'
    : (`pipeline:${req.pipelineType}` as HandoffVariantKey);

export function buildHandoffPrompt(req: HandoffRequest, graph: GraphHint): string {
  const builder = PROMPT_BUILDERS[variantKey(req)] ?? runProjectPrompt; // fallback default
  return builder(req, graph);
}


export interface HandoffDeps {
  ensureSession(
    preferredSessionId?: string,
  ): Promise<{ sessionId: string } | { error: string }>;
  selectSession(sessionId: string): Promise<void>;
  addRepository(path: string): Promise<LocalRepositoryRecord | { error: string }>;
  attachSession(
    sessionId: string,
    repoId: string,
  ): Promise<{ ok: true } | { error: string }>;
  build(repoId: string, sessionId: string): Promise<{ runId: string } | { error: string }>;
  update(repoId: string, sessionId: string): Promise<{ runId: string } | { error: string }>;
  setPendingChat(
    message: string,
    agentId: string | undefined,
    handoff?: { awaitRepoReady?: string; targetSessionId?: string },
  ): void;
  setPage(page: 'chat'): void;
  currentSessionId(): string | null;
}

function isError(value: unknown): value is { error: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'error' in value &&
    typeof (value as { error: unknown }).error === 'string'
  );
}

// instancia do app. O import dinamico @vite-ignore anterior resolvia stores

function graphHintForStatus(status: LocalRepositoryRecord['status']): GraphHint {
  if (status === 'ready') return { state: 'ready' };
  if (status === 'stale') return { state: 'stale' };
  return { state: 'ready' };
}

export async function handoffToOrchestrator(
  req: HandoffRequest,
  beforeHandoff: (() => Promise<{ ok: true } | { error: string }>) | undefined,
  deps: HandoffDeps,
): Promise<{ ok: true } | { error: string }> {
  const d = deps;

  if (beforeHandoff) {
    const pre = await beforeHandoff();
    if (isError(pre)) return { error: pre.error };
  }

  const preferred = d.currentSessionId() ?? undefined;
  const ensured = await d.ensureSession(preferred);
  if (isError(ensured)) {
    return { error: ensured.error };
  }
  const sessionId = ensured.sessionId;

  await d.selectSession(sessionId);

  if (req.projectPath == null) {
    const prompt = buildHandoffPrompt(req, { state: 'unavailable' });
    d.setPendingChat(prompt, undefined);
    d.setPage('chat');
    return { ok: true };
  }

  const record = await d.addRepository(req.projectPath);
  if (isError(record)) {
    const prompt = buildHandoffPrompt(req, { state: 'unavailable' });
    d.setPendingChat(prompt, undefined);
    d.setPage('chat');
    return { ok: true };
  }

  await d.attachSession(sessionId, record.id);

  if (record.status === 'stale') {
    await d.update(record.id, sessionId);
  } else if (record.status === 'absent' || record.status === 'error') {
    await d.build(record.id, sessionId);
  }

  const prompt = buildHandoffPrompt(req, graphHintForStatus(record.status));
  d.setPendingChat(prompt, undefined, {
    awaitRepoReady: record.id,
    targetSessionId: sessionId,
  });
  d.setPage('chat');
  return { ok: true };
}
