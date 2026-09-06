
import { createLogger } from './logger';
import { getSecret } from './secrets-vault';
import { getSetting } from './db';
import {
  VISION_DEFAULT,
  isVisionModelForProvider,
  defaultVisionModelForProvider,
  type VisionProvider,
} from '../../src/constants/vision-models';
import { VISION_TRANSCRIPTION_MARKER } from '../../src/constants/vision';

const logger = createLogger('vision-engine');

const DEFAULT_VISION_TIMEOUT_MS = 120_000;

const ANTHROPIC_IMAGE_MEDIA_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
] as const;
type AnthropicImageMediaType = (typeof ANTHROPIC_IMAGE_MEDIA_TYPES)[number];

const VISION_TRANSCRIPTION_PROMPT = [
  'Transcreva e descreva esta imagem de forma fiel e objetiva, em portugues do Brasil.',
  'Regras:',
  '1. Reproduza na INTEGRA todo o texto visivel (OCR): rotulos, botoes, legendas,',
  '   numeros, tabelas, codigo, URLs. Preserve a grafia e a ordem de leitura.',
  '2. Descreva o layout e a estrutura (secoes, colunas, cabecalhos, listas) o',
  '   suficiente para quem nao ve a imagem entender a organizacao.',
  '3. Cite elementos relevantes: graficos, diagramas, icones, fotos, cores quando',
  '   forem informativas.',
  '4. NAO opine, NAO invente e NAO resuma removendo texto: transcreva o que esta la.',
  '5. Se a imagem estiver ilegivel ou vazia, diga isso de forma curta.',
].join('\n');

export interface DescribeImageInput {
  data: string;
  mimeType: string;
  hint?: string;
}

export class VisionUnconfiguredError extends Error {
  readonly code = 'vision_unconfigured';
  constructor(message: string) {
    super(message);
    this.name = 'VisionUnconfiguredError';
  }
}

export class VisionCallError extends Error {
  readonly code = 'vision_call_failed';
  constructor(message: string) {
    super(message);
    this.name = 'VisionCallError';
  }
}

function getVisionProvider(): VisionProvider {
  const raw = (getSetting('vision_provider') || '').trim();
  return raw === 'openai' || raw === 'anthropic' ? raw : VISION_DEFAULT.provider;
}

function getVisionModel(provider: VisionProvider): string {
  const raw = (getSetting('vision_model') || '').trim();
  if (raw && isVisionModelForProvider(provider, raw)) return raw;
  return defaultVisionModelForProvider(provider);
}

function getVisionTimeoutMs(): number {
  const raw = parseInt(getSetting('vision_timeout_ms') || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_VISION_TIMEOUT_MS;
}

function normalizeAnthropicMediaType(mimeType: string): AnthropicImageMediaType {
  return (ANTHROPIC_IMAGE_MEDIA_TYPES as readonly string[]).includes(mimeType)
    ? (mimeType as AnthropicImageMediaType)
    : 'image/png';
}

function buildPromptText(hint?: string): string {
  const clean = hint?.trim();
  if (!clean) return VISION_TRANSCRIPTION_PROMPT;
  return `${VISION_TRANSCRIPTION_PROMPT}\n\nContexto do usuario (foco sugerido): ${clean}`;
}

export async function describeImage(input: DescribeImageInput): Promise<string> {
  const provider = getVisionProvider();
  const model = getVisionModel(provider);
  const timeoutMs = getVisionTimeoutMs();

  if (provider === 'openai') {
    return describeWithOpenAI(input, model, timeoutMs);
  }
  return describeWithAnthropic(input, model, timeoutMs);
}

function timeoutSignal(timeoutMs: number): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { signal: controller.signal, cancel: () => clearTimeout(timer) };
}

async function describeWithOpenAI(
  input: DescribeImageInput,
  model: string,
  timeoutMs: number,
): Promise<string> {
  const apiKey = await getSecret('OPENAI_API_KEY');
  if (!apiKey) {
    throw new VisionUnconfiguredError(
      'OPENAI_API_KEY nao configurada. Adicione a chave no Vault para usar visao com OpenAI.',
    );
  }

  const dataUrl = `data:${input.mimeType};base64,${input.data}`;
  const { signal, cancel } = timeoutSignal(timeoutMs);

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      signal,
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: buildPromptText(input.hint) },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      logger.error({ status: response.status, model }, 'OpenAI vision failed');
      throw new VisionCallError(
        `OpenAI vision falhou: ${response.status} ${response.statusText} ${errorText.slice(0, 200)}`.trim(),
      );
    }

    const result = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = result.choices?.[0]?.message?.content?.trim() || '';
    logger.info({ model, textLength: text.length }, 'OpenAI vision complete');
    return text;
  } catch (err) {
    if (err instanceof VisionCallError || err instanceof VisionUnconfiguredError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    const isTimeout = err instanceof Error && err.name === 'AbortError';
    logger.error({ err: message, model, isTimeout }, 'OpenAI vision error');
    throw new VisionCallError(
      isTimeout ? `OpenAI vision expirou apos ${timeoutMs}ms.` : `OpenAI vision falhou: ${message}`,
    );
  } finally {
    cancel();
  }
}

async function describeWithAnthropic(
  input: DescribeImageInput,
  model: string,
  timeoutMs: number,
): Promise<string> {
  const apiKey = await getSecret('ANTHROPIC_API_KEY');
  if (!apiKey) {
    throw new VisionUnconfiguredError(
      'ANTHROPIC_API_KEY nao configurada. Adicione a chave no Vault para usar visao com Anthropic.',
    );
  }

  const { signal, cancel } = timeoutSignal(timeoutMs);

  try {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create(
      {
        model,
        max_tokens: 4096,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: normalizeAnthropicMediaType(input.mimeType),
                  data: input.data,
                },
              },
              { type: 'text', text: buildPromptText(input.hint) },
            ],
          },
        ],
      },
      { signal },
    );

    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => ('text' in b ? (b as { text: string }).text : ''))
      .join('')
      .trim();
    logger.info({ model, textLength: text.length }, 'Anthropic vision complete');
    return text;
  } catch (err) {
    if (err instanceof VisionCallError || err instanceof VisionUnconfiguredError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    const isTimeout = err instanceof Error && err.name === 'AbortError';
    logger.error({ err: message, model, isTimeout }, 'Anthropic vision error');
    throw new VisionCallError(
      isTimeout
        ? `Anthropic vision expirou apos ${timeoutMs}ms.`
        : `Anthropic vision falhou: ${message}`,
    );
  } finally {
    cancel();
  }
}

export { VISION_TRANSCRIPTION_MARKER };

export function buildTranscriptionBlock(baseText: string, transcription: string): string {
  const clean = transcription.trim();
  if (!clean) return baseText;
  const block = `${VISION_TRANSCRIPTION_MARKER}\n${clean}`;
  const base = baseText.trim();
  return base ? `${base}\n\n${block}` : block;
}

export function visionUnavailableNotice(err: unknown): string {
  let reason = 'erro inesperado';
  if (err instanceof VisionUnconfiguredError) {
    reason = 'vision nao configurado (verifique provider/modelo e a chave no Vault)';
  } else if (err instanceof VisionCallError) {
    reason = err.message;
  } else if (err instanceof Error) {
    reason = err.message;
  }
  return `Vision indisponivel: ${reason}. Seguindo so com o texto.`;
}

export const __visionEngineInternal = {
  getVisionProvider,
  getVisionModel,
  getVisionTimeoutMs,
  buildPromptText,
  normalizeAnthropicMediaType,
  VISION_TRANSCRIPTION_PROMPT,
};
