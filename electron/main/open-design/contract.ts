import fs from 'fs';
import { createLogger } from '../logger';
import type { DesignContract } from '../../../src/types/open-design';
import { isValidDesignContract, collectDesignContractIssues } from '../../../src/types/open-design';

const lastIssuesByPath = new Map<string, string[]>();

export function getLastContractIssues(htmlPath: string): string[] {
  return lastIssuesByPath.get(htmlPath) ?? [];
}

const logger = createLogger('open-design-contract');

const CONTRACT_SCRIPT_RE = /<script[^>]*id=["']lionclaw-design-contract["'][^>]*>([\s\S]*?)<\/script>/i;

export async function extractContractFromHtml(htmlPath: string): Promise<DesignContract | null> {
  let html: string;
  try {
    html = fs.readFileSync(htmlPath, 'utf-8');
  } catch (err) {
    logger.warn({ err, htmlPath }, 'extractContractFromHtml: failed to read HTML file');
    return null;
  }

  const match = CONTRACT_SCRIPT_RE.exec(html);
  if (!match || !match[1]) {
    logger.warn({ htmlPath }, 'extractContractFromHtml: <script id="lionclaw-design-contract"> not found in HTML');
    return null;
  }

  const rawJson = match[1].trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (err) {
    logger.warn({ err, htmlPath }, 'extractContractFromHtml: invalid JSON in design contract script');
    return null;
  }

  if (!isValidDesignContract(parsed)) {
    const issues = collectDesignContractIssues(parsed);
    lastIssuesByPath.set(htmlPath, issues);
    logger.warn(
      { htmlPath, issueCount: issues.length, firstIssues: issues.slice(0, 3) },
      'extractContractFromHtml: design contract JSON does not satisfy schema',
    );
    return null;
  }

  lastIssuesByPath.delete(htmlPath);
  return parsed;
}
