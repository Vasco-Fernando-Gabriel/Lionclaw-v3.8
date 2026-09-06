import { getHarnessProject, updateHarnessProject } from '../db';
import type { OpenDesignConfig } from '../../../src/types/open-design';

export function getOpenDesignConfig(projectId: string): OpenDesignConfig | null {
  const project = getHarnessProject(projectId);
  if (!project) return null;
  const od = project.config?.openDesign;
  if (!od || typeof od !== 'object') return null;
  return od as unknown as OpenDesignConfig;
}

export function setOpenDesignConfig(projectId: string, patch: Partial<OpenDesignConfig>): void {
  const project = getHarnessProject(projectId);
  if (!project) throw new Error(`Project not found: ${projectId}`);
  const existing = project.config;
  const existingOd = (existing.openDesign as Partial<OpenDesignConfig>) ?? {};
  updateHarnessProject(projectId, {
    config: {
      ...existing,
      openDesign: { ...existingOd, ...patch } as typeof existing.openDesign,
    },
  });
}

export function resolveRunDir(projectId: string): string | null {
  const cfg = getOpenDesignConfig(projectId);
  if (!cfg?.runDir) return null;
  return cfg.runDir;
}
