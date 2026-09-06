import pino from 'pino';
import path from 'path';
import { mkdirSync, renameSync, statSync, promises as fsp } from 'node:fs';
import { getLionClawHome } from './paths';
import { systemLogStream } from './system-log-buffer';

const isDev = process.env.NODE_ENV === 'development';
const basePath = getLionClawHome();
mkdirSync(path.join(basePath, 'data'), { recursive: true });

const LOG_MAX_BYTES = 50 * 1024 * 1024;

export function rotateLogFileIfNeededForBoot(
  filePath: string,
  maxBytes: number = LOG_MAX_BYTES,
): boolean {
  try {
    if (statSync(filePath).size <= maxBytes) return false;
    renameSync(filePath, `${filePath}.1`);
    return true;
  } catch {
    return false;
  }
}

rotateLogFileIfNeededForBoot(path.join(basePath, 'data', 'lionclaw.log'));
rotateLogFileIfNeededForBoot(path.join(basePath, 'data', 'lionclaw-dev.log'));

const devLogFile = path.join(basePath, 'data', 'lionclaw-dev.log');
const devLogEnabled = isDev && process.env.LIONCLAW_NO_DEV_LOG !== '1';

const prettyTerminal = {
  target: 'pino-pretty',
  options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
};
const prettyFile = {
  target: 'pino-pretty',
  options: {
    colorize: false,
    translateTime: 'HH:MM:ss',
    ignore: 'pid,hostname',
    destination: devLogFile,
    mkdir: true,
  },
};

export const errorSerializers = {
  err: pino.stdSerializers.err,
  error: pino.stdSerializers.err,
  reason: pino.stdSerializers.err,
} as const;

const transport = isDev
  ? pino.transport({
      targets: devLogEnabled ? [prettyTerminal, prettyFile] : [prettyTerminal],
    })
  : pino.transport({
      target: 'pino/file',
      options: { destination: path.join(basePath, 'data', 'lionclaw.log') },
    });

const rootLogger = pino(
  {
    level: isDev ? 'debug' : 'info',
    serializers: errorSerializers,
  },
  pino.multistream(
    [
      { stream: transport, level: 'trace' },
      { stream: systemLogStream, level: 'trace' },
    ],
    { dedupe: false },
  ),
);

export function getSystemLogFilePath(): string {
  return devLogEnabled ? devLogFile : path.join(basePath, 'data', 'lionclaw.log');
}

let sessionRotationBusy = false;

export async function rotateLogFileInSessionIfNeeded(
  filePath: string,
  maxBytes: number = LOG_MAX_BYTES,
): Promise<boolean> {
  if (sessionRotationBusy) return false;
  sessionRotationBusy = true;
  try {
    const { size } = await fsp.stat(filePath);
    if (size <= maxBytes) return false;
    await fsp.copyFile(filePath, `${filePath}.1`);
    await fsp.truncate(filePath, 0);
    return true;
  } catch {
    return false;
  } finally {
    sessionRotationBusy = false;
  }
}

const SESSION_ROTATION_INTERVAL_MS = 60_000;
setInterval(() => {
  void rotateLogFileInSessionIfNeeded(getSystemLogFilePath());
}, SESSION_ROTATION_INTERVAL_MS).unref();

if (devLogEnabled) {
  rootLogger.info({ devLogFile }, '[temp] dev log file ativo (remover apos validacao)');
}

export function createLogger(module: string): pino.Logger {
  return rootLogger.child({ module });
}

export { rootLogger };
