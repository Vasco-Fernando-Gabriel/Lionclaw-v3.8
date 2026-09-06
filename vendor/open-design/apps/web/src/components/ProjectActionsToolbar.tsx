// Project-level action bar mounted between the AppChromeHeader and
// the chat-and-workspace split (#451). Hosts the new project-scoped
// actions ("Finalize design package", "Continue in CLI"); per-file
// actions (Export PDF/PPTX/ZIP, Deploy) stay in the FileViewer share
// menu where they already live.
//
// The bar is intentionally thin: presentation, layout, and a couple
// of conditional flags. Behavior lives in ProjectView (handlers,
// hooks) and the per-button components.
//
// LionClaw embed-mode patch (vendor/.lionclaw-patches/embed-mode.md):
// when `isLionClawEmbedded()` is true (URL has `?host=lionclaw`), both
// finalize/CLI buttons are hidden — the Design Lock is produced by the
// LionClaw PipelineEngine, not by upstream OD finalize/CLI flows.
// See docs/spec-opendesign-vendor.md section 5.11 (lines 905-973).

import { ContinueInCliButton } from './ContinueInCliButton';
import { FinalizeDesignButton } from './FinalizeDesignButton';
import { isLionClawEmbedded } from '../lib/embed-mode';
import type { DesignMdState } from '../hooks/useDesignMdState';
import type { FinalizeStatus } from '../hooks/useFinalizeProject';

export interface ProjectActionsToolbarProps {
  designMdState: Pick<DesignMdState, 'exists' | 'isStale' | 'staleReason'>;
  finalizeStatus: FinalizeStatus;
  onFinalize: () => void;
  onCancelFinalize: () => void;
  onContinueInCli: () => void | Promise<void>;
  hidden?: boolean;
}

export function ProjectActionsToolbar({
  designMdState,
  finalizeStatus,
  onFinalize,
  onCancelFinalize,
  onContinueInCli,
  hidden,
}: ProjectActionsToolbarProps) {
  if (hidden) return null;
  const embedded = isLionClawEmbedded();
  return (
    <div
      className="project-actions-toolbar"
      role="toolbar"
      aria-label="Project actions"
    >
      {embedded ? null : (
        <span data-testid="finalize-package">
          <FinalizeDesignButton
            designMdState={designMdState}
            status={finalizeStatus}
            onFinalize={onFinalize}
            onCancel={onCancelFinalize}
          />
        </span>
      )}
      {embedded ? null : (
        <span data-testid="continue-in-cli">
          <ContinueInCliButton designMdState={designMdState} onClick={onContinueInCli} />
        </span>
      )}
    </div>
  );
}
