import {
  buildKimiChildEnv,
  resolveKimiBinary,
  resolveKimiHome,
} from '../agent-runtime/kimi-availability';
import { KIMI_MODELS } from '../../../src/constants/kimi-models';
import {
  defaultAcpTransportFactory,
  type AcpTransport,
  type AcpTransportFactory,
} from './acp-transport';

export interface KimiProviderProbeResult {
  ok: boolean;
  currentModel: string | null;
  availableModels: string[];
  message: string;
}

interface KimiProviderProbeOptions {
  binary?: string;
  home?: string;
  cwd?: string;
  timeoutMs?: number;
  transportFactory?: AcpTransportFactory;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function modelOption(value: unknown): Record<string, unknown> {
  const options = asRecord(value)['configOptions'];
  if (!Array.isArray(options)) return {};
  return options.map(asRecord).find((option) => option['id'] === 'model') ?? {};
}

function modelValues(option: Record<string, unknown>): string[] {
  const values = option['options'];
  if (!Array.isArray(values)) return [];
  return values.flatMap((value) => {
    const candidate = asRecord(value)['value'];
    return typeof candidate === 'string' ? [candidate] : [];
  });
}

async function requestWithTimeout(
  transport: AcpTransport,
  method: string,
  params: unknown,
  timeoutMs: number,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} timed out after ${timeoutMs}ms`)), timeoutMs);
    timer.unref?.();
    transport.request(method, params).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export async function probeKimiProvider(
  options: KimiProviderProbeOptions = {},
): Promise<KimiProviderProbeResult> {
  const binary = options.binary ?? await resolveKimiBinary();
  if (!binary) {
    return { ok: false, currentModel: null, availableModels: [], message: 'CLI Kimi nao encontrado.' };
  }

  const home = options.home ?? resolveKimiHome();
  const cwd = options.cwd ?? home;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const transportFactory = options.transportFactory ?? defaultAcpTransportFactory;
  let transport: AcpTransport | null = null;

  try {
    transport = await transportFactory({
      binary,
      cwd,
      env: buildKimiChildEnv({ home }),
    });
    await requestWithTimeout(
      transport,
      'initialize',
      { protocolVersion: 1, clientCapabilities: {} },
      timeoutMs,
    );
    const session = asRecord(await requestWithTimeout(
      transport,
      'session/new',
      { cwd, mcpServers: [] },
      timeoutMs,
    ));
    if (typeof session['sessionId'] !== 'string' || session['sessionId'].length === 0) {
      throw new Error('session/new retornou sem sessionId');
    }

    const option = modelOption(session);
    const announcedModels = modelValues(option);
    const supported = new Set(KIMI_MODELS.map((model) => model.slug));
    const availableModels = announcedModels.filter((model) => supported.has(model));
    const currentModel = typeof option['currentValue'] === 'string' ? option['currentValue'] : null;
    if (availableModels.length === 0) {
      throw new Error('session/new nao anunciou modelo Kimi suportado pelo LionClaw');
    }

    return {
      ok: true,
      currentModel,
      availableModels,
      message: `Kimi conectado pela sessao oficial (${currentModel ?? availableModels[0]}).`,
    };
  } catch (error) {
    return {
      ok: false,
      currentModel: null,
      availableModels: [],
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (transport) {
      transport.kill('provider-probe-complete');
      await transport.waitClosed(3_000).catch(() => false);
    }
  }
}
