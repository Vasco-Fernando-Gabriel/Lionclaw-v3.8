
export const SANDBOX_PROTOCOL_VERSION = 1 as const;

export const SANDBOX_PRIMITIVES = [
  'phase',
  'agent',
  'parallel',
  'pipeline',
  'gate',
  'artifact',
  'checkpoint',
  'log',
  'validateSprintPlan',
  'materializeSprintPlan',
  'greenCheck',
] as const;

export type SandboxPrimitive = (typeof SANDBOX_PRIMITIVES)[number];


export const PROXIED_PRIMITIVES = [
  'phase',
  'agent',
  'gate',
  'artifact',
  'checkpoint',
  'log',
  'validateSprintPlan',
  'materializeSprintPlan',
  'greenCheck',
] as const;

export type ProxiedPrimitive = (typeof PROXIED_PRIMITIVES)[number];

const PROXIED_PRIMITIVE_SET: ReadonlySet<string> = new Set(PROXIED_PRIMITIVES);

export function isProxiedPrimitive(value: unknown): value is ProxiedPrimitive {
  return typeof value === 'string' && PROXIED_PRIMITIVE_SET.has(value);
}


export interface SandboxChildHello {
  t: 'hello';
  protocol: number;
}

export interface SandboxChildHeartbeat {
  t: 'heartbeat';
  uptimeMs: number;
}

export interface SandboxChildCall {
  t: 'call';
  callId: number;
  primitive: ProxiedPrimitive;
  arg: unknown;
}

export interface SandboxChildResult {
  t: 'result';
  value: unknown;
}

export interface SandboxChildFatal {
  t: 'fatal';
  message: string;
  stack?: string;
}

export type SandboxChildMessage =
  | SandboxChildHello
  | SandboxChildHeartbeat
  | SandboxChildCall
  | SandboxChildResult
  | SandboxChildFatal;


export interface SandboxParentRun {
  t: 'run';
  transformedSource: string;
  input?: Record<string, unknown>;
  maxPlanRounds?: number;
  maxDevRounds?: number;
  agentCatalog?: SandboxAgentCatalogEntry[];
}

export interface SandboxAgentCatalogEntry {
  id: string;
  name: string;
  description?: string;
}

export interface SandboxParentResolve {
  t: 'primitive-result';
  callId: number;
  value: unknown;
}

export interface SandboxParentReject {
  t: 'primitive-error';
  callId: number;
  message: string;
  fatal?: boolean;
}

export type SandboxParentMessage =
  | SandboxParentRun
  | SandboxParentResolve
  | SandboxParentReject;


function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function parseChildMessage(value: unknown): SandboxChildMessage | null {
  if (!isRecord(value)) return null;
  const t = value.t;
  switch (t) {
    case 'hello':
      return typeof value.protocol === 'number'
        ? { t: 'hello', protocol: value.protocol }
        : null;
    case 'heartbeat':
      return typeof value.uptimeMs === 'number'
        ? { t: 'heartbeat', uptimeMs: value.uptimeMs }
        : null;
    case 'call':
      if (typeof value.callId !== 'number') return null;
      if (!isProxiedPrimitive(value.primitive)) return null;
      return { t: 'call', callId: value.callId, primitive: value.primitive, arg: value.arg };
    case 'result':
      return { t: 'result', value: value.value };
    case 'fatal':
      if (typeof value.message !== 'string') return null;
      return {
        t: 'fatal',
        message: value.message,
        stack: typeof value.stack === 'string' ? value.stack : undefined,
      };
    default:
      return null;
  }
}

export function parseParentMessage(value: unknown): SandboxParentMessage | null {
  if (!isRecord(value)) return null;
  const t = value.t;
  switch (t) {
    case 'run': {
      if (typeof value.transformedSource !== 'string') return null;
      const run: SandboxParentRun = {
        t: 'run',
        transformedSource: value.transformedSource,
      };
      if (isRecord(value.input)) {
        run.input = value.input;
      }
      if (isPositiveInt(value.maxPlanRounds)) {
        run.maxPlanRounds = value.maxPlanRounds;
      }
      if (isPositiveInt(value.maxDevRounds)) {
        run.maxDevRounds = value.maxDevRounds;
      }
      if (Array.isArray(value.agentCatalog)) {
        run.agentCatalog = value.agentCatalog
          .filter(
            (e): e is Record<string, unknown> =>
              isRecord(e) && typeof e.id === 'string' && typeof e.name === 'string',
          )
          .map((e) => ({
            id: e.id as string,
            name: e.name as string,
            description: typeof e.description === 'string' ? e.description : undefined,
          }));
      }
      return run;
    }
    case 'primitive-result':
      return typeof value.callId === 'number'
        ? { t: 'primitive-result', callId: value.callId, value: value.value }
        : null;
    case 'primitive-error':
      if (typeof value.callId !== 'number') return null;
      if (typeof value.message !== 'string') return null;
      return {
        t: 'primitive-error',
        callId: value.callId,
        message: value.message,
        fatal: value.fatal === true,
      };
    default:
      return null;
  }
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}


export function isSafeArtifactRelativePath(rel: unknown): rel is string {
  if (typeof rel !== 'string') return false;
  if (rel.length === 0) return false;
  if (rel.indexOf(String.fromCharCode(0)) !== -1) return false;
  for (let i = 0; i < rel.length; i++) {
    if (rel.charCodeAt(i) < 0x20) return false;
  }
  if (rel.startsWith('/') || rel.startsWith('~')) return false;
  if (/^[a-zA-Z]:[\\/]/.test(rel)) return false;
  if (rel.startsWith('\\')) return false;
  const segments = rel.split(/[\\/]+/);
  for (const seg of segments) {
    if (seg === '..') return false;
  }
  return true;
}
