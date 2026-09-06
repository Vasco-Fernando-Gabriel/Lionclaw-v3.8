import { app } from 'electron';
import fs from 'fs';
import path from 'path';

function readPackageVersion(): string {
  const candidates = [
    path.join(__dirname, '../../package.json'),
    path.join(process.cwd(), 'package.json'),
  ];

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8')) as {
        version?: unknown;
      };
      if (typeof parsed.version === 'string' && parsed.version.length > 0) {
        return parsed.version;
      }
    } catch {
    }
  }

  return '0.0.0';
}

const PACKAGE_VERSION = readPackageVersion();

export function getAppVersion(): string {
  try {
    return app.isPackaged ? app.getVersion() || PACKAGE_VERSION : PACKAGE_VERSION;
  } catch {
    return PACKAGE_VERSION;
  }
}

export function formatAppVersionLabel(version = getAppVersion()): string {
  return `v${version.replace(/\.0$/, '')}`;
}
