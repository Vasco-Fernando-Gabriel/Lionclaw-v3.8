import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { createLogger } from '../logger';
import type { PreflightResult } from '../../../src/types/open-design';
import { resolveOpenDesignRoot } from './paths';
import { ensurePnpm } from './pnpm-runner';
import { app } from 'electron';
import { resolveOpenDesignSidecar } from '../distribution-runtime';

const logger = createLogger('open-design-installer');

export type { PreflightResult };

export async function preflight(): Promise<PreflightResult> {
  if (app.isPackaged) {
    try {
      const runtime = resolveOpenDesignSidecar({ packaged: true, resourcesPath: process.resourcesPath });
      return { ok: true, vendorRoot: runtime.root, status: 'ready' };
    } catch (err) {
      return {
        ok: false,
        vendorRoot: path.join(process.resourcesPath, 'open-design'),
        status: 'vendor-missing',
        reason: `LionDesign standalone empacotado inválido: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  const vendorRoot = resolveOpenDesignRoot();

  try {
    const nodeVer = execFileSync('node', ['--version'], { encoding: 'utf-8', timeout: 5000 }).trim();
    logger.info({ nodeVersion: nodeVer }, 'open-design preflight: node detected');
  } catch (err) {
    logger.warn({ err }, 'open-design preflight: failed to detect node version');
  }

  try {
    const inv = await ensurePnpm();
    logger.info({ runner: inv.kind }, 'open-design preflight: pnpm-runner ready');
  } catch (err) {
    logger.error({ err }, 'open-design preflight: pnpm-runner cascade failed');
  }

  if (!fs.existsSync(vendorRoot)) {
    logger.warn({ vendorRoot }, 'open-design preflight: vendor directory missing');
    return {
      ok: false,
      vendorRoot,
      status: 'vendor-missing',
      reason: `vendor/open-design ausente em ${vendorRoot}. Rode \`git status\` e recupere o vendor.`,
    };
  }

  const nodeModulesPath = path.join(vendorRoot, 'node_modules');
  if (!fs.existsSync(nodeModulesPath)) {
    return {
      ok: false,
      vendorRoot,
      status: 'deps-missing',
      reason: 'node_modules ausente no vendor. boot-installer cuida disso em background.',
    };
  }

  return {
    ok: true,
    vendorRoot,
    status: 'ready',
  };
}
