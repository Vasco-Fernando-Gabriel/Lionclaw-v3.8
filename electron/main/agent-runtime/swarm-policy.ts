import fs from 'node:fs/promises';
import path from 'node:path';
import glob from 'glob';
import { Worker } from 'node:worker_threads';
import type { AgentPermissionProfile } from './types';

export const SWARM_READ_TOOLS = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'] as const;
export function swarmEffectiveTools(requested: readonly string[]): string[] {
  return [...new Set(requested.filter((t) => (SWARM_READ_TOOLS as readonly string[]).includes(t)).concat('Write'))];
}

async function canonicalReadPath(cwd: string, value: unknown): Promise<string> {
  if (value !== undefined && typeof value !== 'string') throw new Error('Path invalido');
  const root = await fs.realpath(cwd);
  const target = await fs.realpath(path.resolve(root, typeof value === 'string' ? value : '.'));
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error('Leitura fora do alvo autorizado');
  return target;
}

export function createSwarmToolDispatch(options: {
  cwd: string;
  findingsPath: string;
  allowedTools: readonly string[];
  signal: AbortSignal;
  writeFindings: (content: string) => Promise<void>;
}) {
  return async (name: string, input: Record<string, unknown>): Promise<{ result: string; isError: boolean }> => {
    options.signal.throwIfAborted();
    try {
      if (!options.allowedTools.includes(name)) throw new Error(`Tool negada: ${name}`);
      if (name === 'Write') {
        if (
          typeof input.file_path !== 'string' ||
          path.resolve(input.file_path) !== options.findingsPath ||
          typeof input.content !== 'string'
        )
          throw new Error('Escrita permitida somente no findings da tentativa');
        await options.writeFindings(input.content);
        options.signal.throwIfAborted();
        return { result: `Findings salvo em ${options.findingsPath}`, isError: false };
      }
      if (name === 'Read') {
        const target = await canonicalReadPath(options.cwd, input.file_path);
        if ((await fs.stat(target)).size > 16_000_000)
          throw new Error('Read: arquivo acima de 16 MB; selecione um alvo menor');
        const text = await fs.readFile(target, { encoding: 'utf8', signal: options.signal });
        const offset =
          typeof input.offset === 'number' && Number.isSafeInteger(input.offset) ? Math.max(0, input.offset) : 0;
        const limit =
          typeof input.limit === 'number' && Number.isSafeInteger(input.limit)
            ? Math.min(2000, Math.max(1, input.limit))
            : 2000;
        return {
          result: text
            .split('\n')
            .slice(offset, offset + limit)
            .join('\n'),
          isError: false,
        };
      }
      if (name === 'Glob' || name === 'Grep') {
        const root = await canonicalReadPath(options.cwd, input.path);
        if (typeof input.pattern !== 'string' || input.pattern.length > 512) throw new Error('Pattern invalido');
        if (name === 'Glob') {
          const matches = await new Promise<string[]>((resolve, reject) => {
            const abort = (): void => {
              search.abort();
              reject(options.signal.reason ?? new Error('Aborted'));
            };
            const search = glob(
              String(input.pattern),
              { cwd: root, nodir: true, follow: false, absolute: true, ignore: ['**/node_modules/**', '**/.git/**'] },
              (error, files) => {
                options.signal.removeEventListener('abort', abort);
                if (error) reject(error);
                else resolve(files);
              },
            );
            options.signal.addEventListener('abort', abort, { once: true });
            if (options.signal.aborted) abort();
          });
          const safe: string[] = [];
          for (const file of matches) safe.push(await canonicalReadPath(options.cwd, file));
          return { result: safe.join('\n'), isError: false };
        }
        const matches: string[] = [];
        const walk = async (target: string): Promise<void> => {
          options.signal.throwIfAborted();
          if (matches.length >= 2000) return;
          const stat = await fs.lstat(target);
          if (stat.isSymbolicLink()) return;
          if (stat.isDirectory()) {
            for (const entry of await fs.readdir(target)) {
              if (['.git', 'node_modules'].includes(entry)) continue;
              await walk(path.join(target, entry));
            }
          } else if (stat.isFile()) {
            if (stat.size > 2_000_000) {
              matches.push(`${target}: [nao pesquisado: arquivo excede 2 MB; use Read]`);
              return;
            }
            const text = await fs.readFile(target, { encoding: 'utf8', signal: options.signal });
            const lines = await matchLines(String(input.pattern), text, options.signal);
            for (const match of lines) {
              if (matches.length >= 2000) break;
              matches.push(`${target}:${match.line}:${match.text}`);
            }
          }
        };
        await walk(root);
        return {
          result:
            matches.join('\n') +
            (matches.length >= 2000 ? '\n[Busca parcial: limite de 2000 resultados; restrinja path/pattern.]' : ''),
          isError: false,
        };
      }
      throw new Error(`Capability nao implementada no dispatcher: ${name}`);
    } catch (error) {
      options.signal.throwIfAborted();
      return { result: error instanceof Error ? error.message : String(error), isError: true };
    }
  };
}

export function createSwarmPermission(options: {
  cwd: string;
  allowedTools: readonly string[];
  signal: AbortSignal;
  dispatch: ReturnType<typeof createSwarmToolDispatch>;
}): AgentPermissionProfile {
  return {
    mode: 'default',
    dangerouslySkipPermissions: false,
    canUseTool: async (name, input) => {
      if (options.signal.aborted) return { behavior: 'deny', message: 'Tentativa encerrada' };
      if (!options.allowedTools.includes(name)) return { behavior: 'deny', message: `Swarm: tool negada ${name}` };
      if (name === 'Write') {
        const result = await options.dispatch(name, input);
        return {
          behavior: 'deny',
          message: result.isError
            ? result.result
            : `Operacao concluida pelo host. ${result.result}. Nao repita; prossiga com o trailer.`,
        };
      }
      if (name === 'Read' || name === 'Glob' || name === 'Grep') {
        try {
          await canonicalReadPath(options.cwd, name === 'Read' ? input.file_path : input.path);
        } catch (error) {
          return { behavior: 'deny', message: String(error) };
        }
        return { behavior: 'allow', updatedInput: input };
      }
      if (name === 'WebSearch' || name === 'WebFetch') return { behavior: 'allow', updatedInput: input };
      return { behavior: 'deny', message: 'Swarm: tool nao autorizada' };
    },
  };
}

async function matchLines(
  pattern: string,
  text: string,
  signal: AbortSignal,
): Promise<Array<{ line: number; text: string }>> {
  signal.throwIfAborted();
  const worker = new Worker(
    `const {parentPort,workerData}=require('node:worker_threads');
    try { const regex=new RegExp(workerData.pattern); const matches=[];
      workerData.text.split('\\n').forEach((text,i)=>{if(regex.test(text))matches.push({line:i+1,text})});
      parentPort.postMessage({matches});
    } catch(error) {parentPort.postMessage({error:String(error)})}`,
    { eval: true, workerData: { pattern, text } },
  );
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, matches?: Array<{ line: number; text: string }>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      void worker.terminate().then(() => {
        if (error) reject(error);
        else resolve(matches ?? []);
      }, reject);
    };
    const abort = (): void => finish(new Error('Pesquisa cancelada'));
    const timer = setTimeout(
      () => finish(new Error('Regex excedeu limite de computacao; simplifique o pattern')),
      5000,
    );
    signal.addEventListener('abort', abort, { once: true });
    worker.once('error', (error) => finish(error instanceof Error ? error : new Error(String(error))));
    worker.once('message', (message: { error?: string; matches?: Array<{ line: number; text: string }> }) =>
      finish(message.error ? new Error(message.error) : undefined, message.matches),
    );
    if (signal.aborted) abort();
  });
}
