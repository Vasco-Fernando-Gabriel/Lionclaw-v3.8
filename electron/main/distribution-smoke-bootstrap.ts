import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import { distributionSmokeRoot } from './distribution-smoke-contract';
import { installDistributionSmokeNodeGuard } from './distribution-smoke-node-guard';

function isolateSmokeEnvironment(root: string): void {
  const home = path.join(root, 'home');
  const temp = path.join(root, 'temp');
  const userData = path.join(root, 'user-data');
  assertOwnedPhysicalRoot(root);
  if (fs.existsSync(userData)) {
    throw new Error('distribution smoke exige user-data novo e nao preexistente');
  }
  for (const directory of [root, home, temp, userData]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  app.setPath('userData', userData);
  app.setPath('temp', temp);
  process.env.LIONCLAW_DISTRIBUTION_SMOKE = '1';
  process.env.LIONCLAW_DISTRIBUTION_SMOKE_ROOT = root;
  process.env.LIONCLAW_DISABLE_AUTO_UPDATE = '1';
  process.env.LIONCLAW_DISABLE_REMOTE_SERVICES = '1';
  if (!app.isPackaged) {
    process.env.LIONCLAW_INTERNAL_DISTRIBUTION_SCHEMA_ROOT = path.join(
      app.getAppPath(),
      'out',
      'distribution',
      'payload',
      `${process.platform}-${process.arch}`,
      'distribution',
      'schemas',
    );
    process.env.LIONCLAW_INTERNAL_DISTRIBUTION_SCHEMA_ROOT_ACTIVE = '1';
  }
  process.env.HOME = home;
  process.env.TMPDIR = temp;
  process.env.TMP = temp;
  process.env.TEMP = temp;
  if (process.platform === 'win32') {
    const roaming = path.join(home, 'AppData', 'Roaming');
    const local = path.join(home, 'AppData', 'Local');
    fs.mkdirSync(roaming, { recursive: true });
    fs.mkdirSync(local, { recursive: true });
    process.env.USERPROFILE = home;
    process.env.APPDATA = roaming;
    process.env.LOCALAPPDATA = local;
  } else {
    for (const [name, suffix] of [
      ['XDG_CONFIG_HOME', 'config'],
      ['XDG_CACHE_HOME', 'cache'],
      ['XDG_DATA_HOME', 'data'],
      ['XDG_STATE_HOME', 'state'],
      ['XDG_RUNTIME_DIR', 'runtime'],
    ] as const) {
      const directory = path.join(home, suffix);
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      process.env[name] = directory;
    }
  }
}

function assertOwnedPhysicalRoot(root: string): void {
  const stat = fs.lstatSync(root, { throwIfNoEntry: false });
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('distribution smoke exige root fisico regular criado pelo harness');
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error('distribution smoke exige root pertencente ao usuario do processo');
  }
}

const inheritedSmokeFlag = process.env.LIONCLAW_DISTRIBUTION_SMOKE;
const inheritedSmokeRoot = process.env.LIONCLAW_DISTRIBUTION_SMOKE_ROOT;
delete process.env.LIONCLAW_DISTRIBUTION_SMOKE;
delete process.env.LIONCLAW_DISTRIBUTION_SMOKE_ROOT;
const root = distributionSmokeRoot(process.argv);
if (app.isPackaged) {
  delete process.env.LIONCLAW_INTERNAL_DISTRIBUTION_SCHEMA_ROOT;
  delete process.env.LIONCLAW_INTERNAL_DISTRIBUTION_SCHEMA_ROOT_ACTIVE;
} else if (!root) {
  const appPath = app.getAppPath();
  const candidates = [
    path.join(appPath, 'distribution', 'schemas'),
    path.resolve(appPath, '..', '..', 'distribution', 'schemas'),
    path.resolve(process.cwd(), 'distribution', 'schemas'),
  ];
  process.env.LIONCLAW_INTERNAL_DISTRIBUTION_SCHEMA_ROOT = candidates.find((candidate) =>
    fs.existsSync(path.join(candidate, 'distribution-manifest-v1.schema.json')),
  ) ?? candidates[0];
  process.env.LIONCLAW_INTERNAL_DISTRIBUTION_SCHEMA_ROOT_ACTIVE = '1';
}
if (root) {
  if (inheritedSmokeFlag !== undefined || inheritedSmokeRoot !== undefined) {
    throw new Error('distribution smoke nao aceita autoridade herdada por variavel de ambiente');
  }
  isolateSmokeEnvironment(root);
  const failBeforeBoot = (kind: string, error: unknown): void => {
    const failurePath = path.join(root, 'distribution-smoke-failed.json');
    if (!fs.existsSync(failurePath)) {
      const temporaryPath = `${failurePath}.${process.pid}.tmp`;
      try {
        fs.writeFileSync(temporaryPath, `${JSON.stringify({
          schemaVersion: 1,
          type: 'distribution-smoke-failed',
          stage: `module-${kind}`,
          pid: process.pid,
          message: error instanceof Error ? error.message : String(error),
        })}\n`, { flag: 'wx', mode: 0o600 });
        fs.renameSync(temporaryPath, failurePath);
      } catch {
      }
    }
    app.exit(1);
  };
  try {
    installDistributionSmokeNodeGuard();
  } catch (error) {
    failBeforeBoot('egress-guard', error);
  }
  if (process.env.LIONCLAW_EGRESS_GUARD_ACTIVE !== '1') {
    failBeforeBoot('egress-guard', new Error('guard de egress não foi ativado no processo Electron'));
  }
  process.prependListener('uncaughtException', (error) => failBeforeBoot('uncaught-exception', error));
  process.prependListener('unhandledRejection', (reason) => failBeforeBoot('unhandled-rejection', reason));
}
