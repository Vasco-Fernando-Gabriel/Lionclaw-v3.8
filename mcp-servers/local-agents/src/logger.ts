type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface Logger {
  debug: (data: Record<string, unknown>, msg?: string) => void;
  info: (data: Record<string, unknown>, msg?: string) => void;
  warn: (data: Record<string, unknown>, msg?: string) => void;
  error: (data: Record<string, unknown>, msg?: string) => void;
}

export function createLogger(name: string): Logger {
  function log(level: LogLevel, data: Record<string, unknown>, msg?: string): void {
    const timestamp = new Date().toISOString();
    const payload = { timestamp, level, name, ...data, ...(msg ? { msg } : {}) };
    console.error(JSON.stringify(payload));
  }

  return {
    debug: (data, msg) => log('debug', data, msg),
    info: (data, msg) => log('info', data, msg),
    warn: (data, msg) => log('warn', data, msg),
    error: (data, msg) => log('error', data, msg),
  };
}
