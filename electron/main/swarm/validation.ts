import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { SwarmMember, SwarmSettings, SwarmStartInput } from '../../../src/types/swarm';

export class SwarmDomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SwarmDomainError';
  }
}
const nonempty = z.string().trim().min(1);
const safeId = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const runtime = z.enum(['cloud', 'codex', 'zai', 'minimax-tp', 'kimi', 'local', 'external']);
const member = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('registered'), agentId: nonempty }).strict(),
  z
    .object({
      kind: z.literal('ephemeral'),
      runtime,
      model: nonempty,
      rolePrompt: nonempty,
      allowedTools: z.array(nonempty),
      providerProfileId: nonempty.optional(),
    })
    .strict(),
]);
export const swarmMemberSchema = member;
const common = { requestId: safeId, cwd: nonempty, objective: nonempty, knownContext: z.string().optional() };
export const swarmStartSchema = z.discriminatedUnion('mode', [
  z
    .object({
      ...common,
      mode: z.literal('fanout'),
      promptTemplate: nonempty.refine((v) => v.includes('{{item}}')),
      member,
      items: z
        .array(z.object({ target: nonempty }).strict())
        .min(1)
        .max(100),
    })
    .strict(),
  z
    .object({
      ...common,
      mode: z.literal('comite'),
      target: nonempty,
      members: z
        .array(z.object({ slug: z.string(), objective: nonempty, member }).strict())
        .min(1)
        .max(100),
    })
    .strict(),
]);
export function validateSwarmSettings(value: unknown): SwarmSettings {
  const parsed = z
    .object({
      concurrencyCap: z.number().int().min(1).max(100),
      maxAttempts: z.number().int().min(1).max(16),
      idleTimeoutMs: z.number().int().min(1).max(2_147_483_647),
      hardTimeoutMs: z.number().int().min(1).max(2_147_483_647),
    })
    .strict()
    .refine((s) => s.idleTimeoutMs <= s.hardTimeoutMs)
    .safeParse(value);
  if (!parsed.success)
    throw new SwarmDomainError(
      'invalid-settings',
      'Settings Swarm inválidos: concorrência 1-100, tentativas 1-16 e timeouts positivos, idle <= teto duro.',
    );
  return parsed.data;
}
export function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
export function parseSwarmInput(value: unknown, readRoots: readonly string[]): SwarmStartInput {
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    throw new SwarmDomainError('invalid-input', 'Entrada Swarm precisa ser JSON válido.');
  }
  if (bytes > 64 * 1024)
    throw new SwarmDomainError('input-too-large', 'Entrada excede 64 KiB. Divida em runs menores.');
  const parsed = swarmStartSchema.safeParse(value);
  if (!parsed.success)
    throw new SwarmDomainError(
      'invalid-input',
      `Plano Swarm inválido: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  const input = parsed.data;
  if (!path.isAbsolute(input.cwd)) throw new SwarmDomainError('invalid-cwd', 'cwd precisa ser absoluto.');
  let cwd: string;
  let roots: string[];
  try {
    cwd = fs.realpathSync(input.cwd);
    if (!fs.statSync(cwd).isDirectory()) throw new Error('not a directory');
    roots = readRoots.map((root) => fs.realpathSync(root));
  } catch {
    throw new SwarmDomainError('invalid-cwd', 'Workspace inexistente ou não legível.');
  }
  if (!roots.some((root) => isWithin(root, cwd)))
    throw new SwarmDomainError('workspace-denied', 'cwd está fora dos workspaces autorizados para a sessão.');
  const targets = input.mode === 'fanout' ? input.items.map((item) => item.target) : [input.target];
  for (const target of targets) {
    if (/^https?:\/\//i.test(target)) {
      try {
        new URL(target);
      } catch {
        throw new SwarmDomainError('invalid-target', 'URL inválida.');
      }
      continue;
    }
    const candidate = path.resolve(cwd, target);
    if (fs.existsSync(candidate)) {
      if (!roots.some((root) => isWithin(root, fs.realpathSync(candidate))))
        throw new SwarmDomainError('target-denied', 'Alvo resolve fora do workspace autorizado.');
      fs.accessSync(candidate, fs.constants.R_OK);
    } else if (path.isAbsolute(target) || /^(\.\.?[\\/]|[\w.-]+[\\/])/.test(target)) {
      throw new SwarmDomainError('invalid-target', `Alvo local inexistente: ${target}`);
    }
  }
  return { ...input, cwd };
}
export function stableJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJSON).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableJSON(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export function inputHash(value: SwarmStartInput): string {
  return createHash('sha256').update(stableJSON(value)).digest('hex');
}
export function normalizedItems(
  input: SwarmStartInput,
): Array<{ slug: string; target: string; prompt: string; member: SwarmMember }> {
  const seen = new Set<string>();
  const items =
    input.mode === 'fanout'
      ? input.items.map((item) => ({
          slug: item.target,
          target: item.target,
          objective: input.promptTemplate.split('{{item}}').join(item.target),
          member: input.member,
        }))
      : input.members.map((item) => ({ ...item, target: input.target }));
  return items.map((item, i) => {
    const source =
      input.mode === 'fanout'
        ? item.slug
            .replace(/\.[a-zA-Z0-9]+$/, '')
            .split(/[\\/]/)
            .slice(-2)
            .join('-')
        : item.slug;
    const base =
      source
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 70) || `item-${String(i + 1).padStart(2, '0')}`;
    let slug = base;
    let suffix = 2;
    while (seen.has(slug)) slug = `${base}-${suffix++}`;
    seen.add(slug);
    return {
      slug,
      target: item.target,
      member: item.member,
      prompt: `OBJETIVO DA RUN: ${input.objective}\nOBJETIVO DO ITEM: ${item.objective}\nALVO: ${item.target}\nCONTEXTO CONHECIDO: ${input.knownContext ?? 'Não informado.'}`,
    };
  });
}
