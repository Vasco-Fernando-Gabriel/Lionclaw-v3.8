import crypto from 'crypto';
import { createLogger } from '../logger';
import type { OpenDesignSessionConfig } from '../../../src/types/open-design';

const logger = createLogger('open-design-adapter-http');

const DEFAULT_TIMEOUT_MS = 10_000;

export interface AdapterConfig {
  baseUrl: string;
  timeoutMs?: number;
}

export interface CreateProjectPayload {
  id: string;
  name: string;
  skillId?: string | null;
  designSystemId?: string | null;
  pendingPrompt: null;
  metadata: {
    kind: 'prototype';
    fidelity: 'high-fidelity';
    source: 'lionclaw-development-v2';
    lionclawProjectId: string;
    lionclawRunId: string;
    sessionConfigVersion: 1;
  };
}

export interface ChatMessageShape {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  runId?: string;
  runStatus?: 'pending' | 'running' | 'completed' | 'failed';
  createdAt?: string;
}

export interface ChatRunCreateRequest {
  projectId: string;
  conversationId: string;
  assistantMessageId: string;
  clientRequestId: string;
  agentId: string;
  message: string;
  currentPrompt: string;
  model?: string;
  reasoning?: 'low' | 'medium' | 'high';
  designSystemId?: string | null;
  skillId?: string | null;
  skillIds?: string[];
}

export interface OpenDesignAppConfigPrefs {
  agentId?: string | null;
  agentModels?: Record<string, { model?: string; reasoning?: string }>;
  designSystemId?: string | null;
}

export interface FileEntry {
  path: string;
  size?: number;
  hash?: string;
  updatedAt?: string;
  metadata?: { entryFile?: boolean; [key: string]: unknown };
}

export interface Adapter {
  health(): Promise<boolean>;
  createProject(payload: CreateProjectPayload): Promise<{ projectId: string; conversationId: string }>;
  createConversation(projectId: string, title?: string): Promise<{ conversationId: string }>;
  putMessage(projectId: string, conversationId: string, messageId: string, message: ChatMessageShape): Promise<void>;
  startRun(payload: ChatRunCreateRequest): Promise<{ runId: string }>;
  getAppConfig(): Promise<{ config: OpenDesignAppConfigPrefs }>;
  updateAppConfig(payload: OpenDesignAppConfigPrefs): Promise<{ config: OpenDesignAppConfigPrefs }>;
  startInitialRun(args: {
    projectId: string;
    conversationId: string;
    prompt: string;
    sessionConfig: OpenDesignSessionConfig;
    userMessageId: string;
    assistantMessageId: string;
    clientRequestId: string;
    skillId?: string | null;
    skillIds?: string[];
  }): Promise<{ runId: string }>;
  listMessages(projectId: string, conversationId: string): Promise<ChatMessageShape[]>;
  listFiles(projectId: string): Promise<FileEntry[]>;
  readFile(projectId: string, filePath: string): Promise<string>;
  fetchFinalArtifact(projectId: string): Promise<{ html: string; fileName: string; hash: string }>;
  waitForRunComplete(
    runId: string,
    opts?: { timeoutMs?: number; pollIntervalMs?: number },
  ): Promise<{
    status: 'completed' | 'failed' | 'cancelled' | 'timeout';
    raw: unknown;
  }>;
  callRaw(method: string, urlPath: string, body?: unknown): Promise<unknown>;
}

export function isForbiddenPath(urlPath: string): boolean {
  const p = urlPath.toLowerCase();
  if (p.includes('/finalize/') || p.endsWith('/finalize') || /\/finalize\//.test(p)) return true;
  if (p.endsWith('/design.md')) return true;
  return false;
}

function assertAllowed(method: string, urlPath: string): void {
  if (isForbiddenPath(urlPath)) {
    throw new Error(
      `Adapter HTTP: endpoint proibido em modo embedded: ${method.toUpperCase()} ${urlPath} ` +
        `(SPEC L811-819 — finalize/* e DESIGN.md sao bloqueados; lock usa /api/projects/:id/files).`,
    );
  }
}

function joinUrl(baseUrl: string, urlPath: string): string {
  const trimmedBase = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const trimmedPath = urlPath.startsWith('/') ? urlPath : `/${urlPath}`;
  return `${trimmedBase}${trimmedPath}`;
}

async function rawFetch(
  baseUrl: string,
  method: string,
  urlPath: string,
  body: unknown,
  timeoutMs: number,
): Promise<Response> {
  const url = joinUrl(baseUrl, urlPath);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const init: RequestInit = {
      method,
      signal: controller.signal,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    };
    return await fetch(url, init);
  } finally {
    clearTimeout(timer);
  }
}

async function callHttp<T = unknown>(
  baseUrl: string,
  method: string,
  urlPath: string,
  body: unknown,
  timeoutMs: number,
  parse: 'json' | 'text' = 'json',
): Promise<T> {
  assertAllowed(method, urlPath);

  async function attemptOnce(): Promise<{ ok: true; value: T } | { ok: false; retryable: boolean; error: Error }> {
    try {
      const res = await rawFetch(baseUrl, method, urlPath, body, timeoutMs);
      if (res.ok) {
        if (parse === 'text') return { ok: true, value: (await res.text()) as unknown as T };
        const text = await res.text();
        if (!text) return { ok: true, value: undefined as unknown as T };
        return { ok: true, value: JSON.parse(text) as T };
      }
      const text = await res.text().catch(() => '');
      const error = new Error(`Adapter HTTP ${method} ${urlPath} -> ${res.status} ${res.statusText}: ${text}`);
      const retryable = res.status >= 500 && res.status < 600;
      return { ok: false, retryable, error };
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        return {
          ok: false,
          retryable: false,
          error: new Error(`Adapter HTTP ${method} ${urlPath} timed out after ${timeoutMs}ms`),
        };
      }
      return {
        ok: false,
        retryable: true,
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }
  }

  const first = await attemptOnce();
  if (first.ok) return first.value;
  if (!first.retryable) throw first.error;
  logger.warn({ urlPath, err: first.error }, 'adapter: retryable failure, retrying once');
  const second = await attemptOnce();
  if (second.ok) return second.value;
  throw second.error;
}

export function createAdapter(cfg: AdapterConfig): Adapter {
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const baseUrl = cfg.baseUrl;

  async function callRaw(method: string, urlPath: string, body?: unknown): Promise<unknown> {
    return callHttp<unknown>(baseUrl, method, urlPath, body, timeoutMs);
  }

  return {
    async health(): Promise<boolean> {
      try {
        const res = await callHttp<{ ok?: boolean }>(baseUrl, 'GET', '/api/health', undefined, timeoutMs);
        return !!res?.ok;
      } catch (err) {
        logger.warn({ err }, 'adapter.health: failed');
        return false;
      }
    },

    async createProject(payload: CreateProjectPayload): Promise<{ projectId: string; conversationId: string }> {
      const res = await callHttp<{
        project?: { id?: string };
        conversationId?: string;
      }>(baseUrl, 'POST', '/api/projects', payload, timeoutMs);
      const projectId = res?.project?.id ?? payload.id;
      const conversationId = res?.conversationId ?? '';
      if (!conversationId) {
        throw new Error('Adapter HTTP: /api/projects nao retornou conversationId');
      }
      return { projectId, conversationId };
    },

    async createConversation(projectId: string, title?: string): Promise<{ conversationId: string }> {
      const res = await callHttp<{ conversation?: { id?: string }; conversationId?: string }>(
        baseUrl,
        'POST',
        `/api/projects/${encodeURIComponent(projectId)}/conversations`,
        title === undefined ? {} : { title },
        timeoutMs,
      );
      const id = res?.conversation?.id ?? res?.conversationId ?? '';
      if (!id) {
        throw new Error('Adapter HTTP: /api/projects/:id/conversations nao retornou conversationId');
      }
      return { conversationId: id };
    },

    async putMessage(
      projectId: string,
      conversationId: string,
      messageId: string,
      message: ChatMessageShape,
    ): Promise<void> {
      const urlPath = `/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(
        conversationId,
      )}/messages/${encodeURIComponent(messageId)}`;
      await callHttp<unknown>(baseUrl, 'PUT', urlPath, message, timeoutMs);
    },

    async startRun(payload: ChatRunCreateRequest): Promise<{ runId: string }> {
      const res = await callHttp<{ runId?: string }>(baseUrl, 'POST', '/api/runs', payload, timeoutMs);
      const runId = res?.runId ?? '';
      if (!runId) {
        throw new Error('Adapter HTTP: /api/runs nao retornou runId');
      }
      return { runId };
    },

    async getAppConfig(): Promise<{ config: OpenDesignAppConfigPrefs }> {
      const res = await callHttp<{ config?: OpenDesignAppConfigPrefs }>(
        baseUrl,
        'GET',
        '/api/app-config',
        undefined,
        timeoutMs,
      );
      return { config: res?.config ?? {} };
    },

    async updateAppConfig(payload: OpenDesignAppConfigPrefs): Promise<{ config: OpenDesignAppConfigPrefs }> {
      const res = await callHttp<{ config?: OpenDesignAppConfigPrefs }>(
        baseUrl,
        'PUT',
        '/api/app-config',
        payload,
        timeoutMs,
      );
      return { config: res?.config ?? {} };
    },

    async startInitialRun(args): Promise<{ runId: string }> {
      const { projectId, conversationId, prompt, sessionConfig } = args;
      const userMessageId = args.userMessageId;
      const assistantMessageId = args.assistantMessageId;
      const clientRequestId = args.clientRequestId;

      await this.putMessage(projectId, conversationId, userMessageId, {
        id: userMessageId,
        role: 'user',
        content: prompt,
      });

      await this.putMessage(projectId, conversationId, assistantMessageId, {
        id: assistantMessageId,
        role: 'assistant',
        content: '',
        runStatus: 'running',
      });

      const runPayload: ChatRunCreateRequest = {
        projectId,
        conversationId,
        assistantMessageId,
        clientRequestId,
        agentId: sessionConfig.agentId,
        message: prompt,
        currentPrompt: prompt,
        model: sessionConfig.model,
        reasoning: sessionConfig.reasoning,
        designSystemId: sessionConfig.designSystemId ?? null,
        skillId: args.skillId ?? null,
        skillIds: args.skillIds,
      };
      const run = await this.startRun(runPayload);

      await this.putMessage(projectId, conversationId, userMessageId, {
        id: userMessageId,
        role: 'user',
        content: prompt,
      });
      await this.putMessage(projectId, conversationId, assistantMessageId, {
        id: assistantMessageId,
        role: 'assistant',
        content: '',
        runId: run.runId,
        runStatus: 'running',
      });

      return run;
    },

    async listMessages(projectId: string, conversationId: string): Promise<ChatMessageShape[]> {
      const res = await callHttp<{ messages?: ChatMessageShape[] }>(
        baseUrl,
        'GET',
        `/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/messages`,
        undefined,
        timeoutMs,
      );
      return Array.isArray(res?.messages) ? res.messages : [];
    },

    async waitForRunComplete(runId, opts) {
      const totalTimeoutMs = opts?.timeoutMs ?? 180_000;
      const pollIntervalMs = opts?.pollIntervalMs ?? 1_500;
      const start = Date.now();

      while (Date.now() - start < totalTimeoutMs) {
        try {
          const raw = await callHttp<Record<string, unknown>>(
            baseUrl,
            'GET',
            `/api/runs/${encodeURIComponent(runId)}`,
            undefined,
            10_000,
          );
          const status =
            (raw?.['status'] as string | undefined) ??
            ((raw?.['run'] as Record<string, unknown> | undefined)?.['status'] as string | undefined) ??
            '';
          if (status === 'completed' || status === 'failed' || status === 'cancelled') {
            return { status: status as 'completed' | 'failed' | 'cancelled', raw };
          }
        } catch (err) {
          logger.warn({ err, runId }, 'waitForRunComplete: poll attempt failed (continuing)');
        }
        await new Promise((r) => setTimeout(r, pollIntervalMs));
      }
      return { status: 'timeout' as const, raw: null };
    },

    async listFiles(projectId: string): Promise<FileEntry[]> {
      const res = await callHttp<{ files?: FileEntry[] }>(
        baseUrl,
        'GET',
        `/api/projects/${encodeURIComponent(projectId)}/files`,
        undefined,
        timeoutMs,
      );
      return res?.files ?? [];
    },

    async readFile(projectId: string, filePath: string): Promise<string> {
      const safe = filePath
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/');
      const urlPath = `/api/projects/${encodeURIComponent(projectId)}/files/${safe}`;
      return callHttp<string>(baseUrl, 'GET', urlPath, undefined, timeoutMs, 'text');
    },

    async fetchFinalArtifact(projectId: string): Promise<{ html: string; fileName: string; hash: string }> {
      const files = await this.listFiles(projectId);

      let chosen: FileEntry | null = null;
      let chosenHtml: string | null = null;
      for (const f of files) {
        if (f.metadata?.entryFile === true && f.path.toLowerCase().endsWith('.html')) {
          chosen = f;
          break;
        }
      }

      if (!chosen) {
        const htmlFiles = files
          .filter((f) => f.path.toLowerCase().endsWith('.html'))
          .slice()
          .sort((a, b) => {
            const ta = a.updatedAt ?? '';
            const tb = b.updatedAt ?? '';
            if (ta === tb) return 0;
            return ta < tb ? 1 : -1;
          });
        for (const f of htmlFiles) {
          try {
            const content = await this.readFile(projectId, f.path);
            if (content.includes('lionclaw-design-contract')) {
              chosen = f;
              chosenHtml = content;
              break;
            }
          } catch (err) {
            logger.warn({ err, file: f.path }, 'fetchFinalArtifact: failed to read candidate, skipping');
          }
        }
      }

      if (!chosen) {
        throw new Error(
          `Adapter HTTP: nao foi possivel localizar artifact HTML final para ${projectId} ` +
            `(nenhum entryFile e nenhum HTML contendo "lionclaw-design-contract"). ` +
            `Patches do vendor com /api/lionclaw/* podem ser necessarios em Sprint 3.`,
        );
      }

      const html = chosenHtml ?? (await this.readFile(projectId, chosen.path));
      const hash = crypto.createHash('sha256').update(html).digest('hex');
      const fileName = chosen.path.split('/').pop() ?? chosen.path;
      return { html, fileName, hash };
    },

    callRaw,
  };
}
