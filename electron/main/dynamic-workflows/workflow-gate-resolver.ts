
import type { GateCheckSpec } from './workflow-gates';

export interface GateCheckResolutionContext {
  repoRoot: string;
  protectedPaths?: string[];
  touchedFiles?: string[];
  nodeOutputs?: Record<string, unknown>;
  schemaRequiredKeysByNode?: Record<string, string[]>;
  defaultSchemaRequiredKeys?: string[];
  baselineMaxErrorsByCommand?: Record<string, number>;
  commandTimeoutMs?: number;
}

export function splitCommand(command: string): { bin: string; args: string[] } {
  const parts = command
    .trim()
    .split(/\s+/)
    .filter((p) => p.length > 0);
  const [bin, ...args] = parts;
  return { bin: bin ?? '', args };
}

function isConcreteCommand(check: Record<string, unknown>): boolean {
  const command = typeof check.command === 'string' ? check.command : '';
  const hasArgs = Array.isArray(check.args);
  const baselineSymbolic = typeof check.baselineRef === 'string';
  return hasArgs && !command.includes(' ') && !baselineSymbolic;
}

function resolveCommand(
  check: Record<string, unknown>,
  rc: GateCheckResolutionContext,
): GateCheckSpec {
  if (isConcreteCommand(check)) return check as unknown as GateCheckSpec;

  const rawCommand = typeof check.command === 'string' ? check.command : '';
  const { bin, args } = splitCommand(rawCommand);

  let maxErrors: number | undefined =
    typeof check.maxErrors === 'number' ? check.maxErrors : undefined;
  if (maxErrors === undefined && typeof check.baselineRef === 'string') {
    const fromBaseline = rc.baselineMaxErrorsByCommand?.[rawCommand];
    if (typeof fromBaseline === 'number') maxErrors = fromBaseline;
  }

  const resolved: Record<string, unknown> = {
    kind: 'command',
    id: typeof check.id === 'string' ? check.id : `cmd:${rawCommand}`,
    command: bin,
    args: Array.isArray(check.args) ? (check.args as string[]) : args,
    cwd: typeof check.cwd === 'string' ? check.cwd : rc.repoRoot,
  };
  if (maxErrors !== undefined) resolved.maxErrors = maxErrors;
  if (typeof check.errorPattern === 'string') resolved.errorPattern = check.errorPattern;
  const timeoutMs =
    typeof check.timeoutMs === 'number' ? check.timeoutMs : rc.commandTimeoutMs;
  if (typeof timeoutMs === 'number') resolved.timeoutMs = timeoutMs;
  return resolved as unknown as GateCheckSpec;
}

function resolveContainment(
  check: Record<string, unknown>,
  rc: GateCheckResolutionContext,
): GateCheckSpec {
  const protectedPaths = Array.isArray(check.protectedPaths)
    ? (check.protectedPaths as string[])
    : rc.protectedPaths ?? [];
  const touchedFiles = Array.isArray(check.touchedFiles)
    ? (check.touchedFiles as string[])
    : rc.touchedFiles ?? [];
  const baseDir =
    typeof check.baseDir === 'string'
      ? check.baseDir
      : // touched-files vem relativo ao repo; resolve contra repoRoot pro match.
        rc.repoRoot;
  return {
    kind: 'containment',
    id: typeof check.id === 'string' ? check.id : 'containment',
    protectedPaths,
    touchedFiles,
    baseDir,
  } as unknown as GateCheckSpec;
}

function resolveSchema(
  check: Record<string, unknown>,
  rc: GateCheckResolutionContext,
): GateCheckSpec[] {
  if ('value' in check && check.value !== undefined) {
    return [check as unknown as GateCheckSpec];
  }
  const nodeIds = Array.isArray(check.nodeIds) ? (check.nodeIds as string[]) : [];
  if (nodeIds.length === 0) {
    return [
      {
        kind: 'schema',
        id: typeof check.id === 'string' ? check.id : 'schema',
        value: {},
        requiredKeys: [],
      } as unknown as GateCheckSpec,
    ];
  }
  const defaults = rc.defaultSchemaRequiredKeys ?? [];
  return nodeIds.map((nodeId) => {
    const value = rc.nodeOutputs?.[nodeId];
    const requiredKeys = rc.schemaRequiredKeysByNode?.[nodeId] ?? defaults;
    return {
      kind: 'schema',
      id: `schema:${nodeId}`,
      value,
      requiredKeys,
    } as unknown as GateCheckSpec;
  });
}

export function resolveGateChecks(
  checks: ReadonlyArray<GateCheckSpec>,
  rc: GateCheckResolutionContext,
): GateCheckSpec[] {
  const out: GateCheckSpec[] = [];
  for (const raw of checks) {
    const check = raw as unknown as Record<string, unknown>;
    const kind = typeof check.kind === 'string' ? check.kind : '';
    switch (kind) {
      case 'command':
        out.push(resolveCommand(check, rc));
        break;
      case 'containment':
        out.push(resolveContainment(check, rc));
        break;
      case 'schema':
        out.push(...resolveSchema(check, rc));
        break;
      default:
        out.push(raw as GateCheckSpec);
    }
  }
  return out;
}

