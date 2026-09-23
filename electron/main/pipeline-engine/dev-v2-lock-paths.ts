import path from 'path';
import { createLogger } from '../logger';
import { getPipelineDocsContext } from '../pipeline-paths';
import type { OpenDesignConfig } from '../../../src/types/open-design';

const logger = createLogger('dev-v2-lock-paths');

export interface ProjectLockPathsInput {
  id: string;
  projectPath: string;
  pipelineType?: string;
  pipelineDocsId?: string | null;
  config?: { openDesign?: Partial<OpenDesignConfig> };
}

export function buildDesignLockPathsBlock(project: ProjectLockPathsInput): string | null {
  if (project.pipelineType !== 'development-v2') return null;
  const od = project.config?.openDesign;
  if (!od || od.locked !== true) return null;

  const snapshotDir = od.snapshotDir ?? null;
  const fallbackBase = snapshotDir;

  const resolvedContract = od.contractPath ?? (fallbackBase ? path.join(fallbackBase, 'design-contract.json') : null);
  const resolvedBrief = od.briefPath ?? (fallbackBase ? path.join(fallbackBase, 'design-brief.md') : null);
  const resolvedReport = od.lockReportPath ?? (fallbackBase ? path.join(fallbackBase, 'design-lock-report.md') : null);
  const resolvedArtifact =
    od.artifactHtmlPath ?? (fallbackBase ? path.join(fallbackBase, 'artifact', 'index.html') : null);
  const resolvedManifest = od.manifestPath ?? (fallbackBase ? path.join(fallbackBase, 'manifest.json') : null);
  const openDesignProjectId = od.openDesignProjectId;
  const conversationId = od.conversationId;

  if (
    !resolvedContract ||
    !resolvedBrief ||
    !resolvedReport ||
    !resolvedArtifact ||
    !resolvedManifest ||
    !openDesignProjectId ||
    !conversationId
  ) {
    logger.warn(
      {
        projectId: project.id,
        locked: od.locked,
        hasSnapshotDir: !!snapshotDir,
        hasContract: !!resolvedContract,
        hasBrief: !!resolvedBrief,
        hasReport: !!resolvedReport,
        hasArtifact: !!resolvedArtifact,
        hasManifest: !!resolvedManifest,
        hasOdProjectId: !!openDesignProjectId,
        hasConversationId: !!conversationId,
      },
      'buildDesignLockPathsBlock: openDesign config locked but missing required paths/ids — skipping block injection',
    );
    return null;
  }

  const docsCtx = getPipelineDocsContext(project.projectPath, project.pipelineDocsId ?? null);
  const storiesPath = docsCtx
    ? docsCtx.resolveDocPath('stories-requisitos.md')
    : path.join(project.projectPath, 'stories-requisitos.md');
  const prdPath = docsCtx ? docsCtx.resolveDocPath('PRD.md') : path.join(project.projectPath, 'PRD.md');

  return [
    '**Inputs explicitos do design lock:**',
    `- User stories:        ${storiesPath}`,
    `- PRD path:            ${prdPath}`,
    `- Design Contract:     ${resolvedContract}`,
    `- Design Brief:        ${resolvedBrief}`,
    `- Lock Report:         ${resolvedReport}`,
    `- Artifact HTML:       ${resolvedArtifact}`,
    `- Manifest:            ${resolvedManifest}`,
    `- OpenDesign Project:  ${openDesignProjectId}`,
    `- Conversation:        ${conversationId}`,
    '',
    'O agente DEVE ler esses arquivos via Read tool antes de gerar saida.',
    'NAO chute caminhos: os arquivos com timestamp ficam em docs/Docs<id>/.',
  ].join('\n');
}
