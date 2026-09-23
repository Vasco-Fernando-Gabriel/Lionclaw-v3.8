#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

const client = new ElevenLabsClient();
const DEFAULT_ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'RGymW84CSmfVugnA5tvA';

function resolveVoiceId(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_ELEVENLABS_VOICE_ID;
}

const server = new Server({ name: 'elevenlabs', version: '1.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'list_voices',
      description: 'Listar vozes disponiveis na ElevenLabs. Retorna nome, voice_id, categoria, idiomas.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          search: { type: 'string', description: 'Filtrar por nome' },
          category: { type: 'string', description: 'Filtrar por categoria (premade, cloned, generated)' },
        },
      },
    },
    {
      name: 'get_voice',
      description: 'Detalhes completos de uma voz: settings, samples, labels, idiomas verificados.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          voice_id: { type: 'string', description: 'ID da voz' },
        },
        required: ['voice_id'],
      },
    },
    {
      name: 'text_to_speech',
      description:
        'Gerar audio a partir de texto. Salva em arquivo e retorna o path. O usuario vai ouvir o audio no chat.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          voice_id: { type: 'string', description: `ID da voz. Default: ${DEFAULT_ELEVENLABS_VOICE_ID}` },
          text: { type: 'string', description: 'Texto para converter em fala' },
          model_id: { type: 'string', description: 'Modelo (default: eleven_multilingual_v2)' },
        },
        required: ['text'],
      },
    },
    {
      name: 'speech_to_text',
      description: 'Transcrever audio para texto usando Scribe v2. Aceita path de arquivo de audio.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          audio_path: { type: 'string', description: 'Caminho do arquivo de audio' },
          language: { type: 'string', description: 'Codigo do idioma (default: pt)' },
        },
        required: ['audio_path'],
      },
    },
    {
      name: 'preview_voice',
      description: 'Gerar um preview curto de uma voz para o usuario ouvir e comparar.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          voice_id: { type: 'string', description: `ID da voz. Default: ${DEFAULT_ELEVENLABS_VOICE_ID}` },
          text: { type: 'string', description: 'Texto de teste (default: frase padrao em PT-BR)' },
        },
        required: [],
      },
    },
    {
      name: 'get_voice_settings',
      description: 'Ver configuracoes atuais de uma voz: stability, similarity_boost, style, speed.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          voice_id: { type: 'string', description: 'ID da voz' },
        },
        required: ['voice_id'],
      },
    },
    {
      name: 'update_voice_settings',
      description: 'Alterar configuracoes de uma voz.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          voice_id: { type: 'string', description: 'ID da voz' },
          stability: { type: 'number', description: '0-1. Mais alto = mais consistente, mais baixo = mais expressivo' },
          similarity_boost: { type: 'number', description: '0-1. Quanto a voz deve se parecer com a original' },
          style: { type: 'number', description: '0-1. Exagero de estilo (consome mais recursos)' },
          speed: { type: 'number', description: '0.5-2.0. Velocidade da fala (1.0 = normal)' },
        },
        required: ['voice_id'],
      },
    },
    {
      name: 'get_models',
      description: 'Listar modelos TTS disponiveis com detalhes de latencia, idiomas e pricing.',
      inputSchema: { type: 'object' as const, properties: {} },
    },
    {
      name: 'get_user_info',
      description: 'Informacoes da conta ElevenLabs: creditos restantes, tier, limite de caracteres.',
      inputSchema: { type: 'object' as const, properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const a = (args || {}) as Record<string, unknown>;

  try {
    switch (name) {
      case 'list_voices': {
        const voices = await client.voices.search({
          search: a.search as string | undefined,
        });
        const formatted =
          voices.voices?.map((v) => ({
            voice_id: v.voiceId,
            name: v.name,
            category: v.category,
            labels: v.labels,
            preview_url: v.previewUrl,
          })) || [];
        return { content: [{ type: 'text' as const, text: JSON.stringify(formatted, null, 2) }] };
      }

      case 'get_voice': {
        const voice = await client.voices.get(a.voice_id as string);
        return { content: [{ type: 'text' as const, text: JSON.stringify(voice, null, 2) }] };
      }

      case 'text_to_speech': {
        const voiceId = resolveVoiceId(a.voice_id);
        const audio = await client.textToSpeech.convert(voiceId, {
          text: a.text as string,
          modelId: (a.model_id as string) || 'eleven_multilingual_v2',
        });
        const id = crypto.randomUUID();
        const tmpPath = path.join(os.tmpdir(), `lionclaw-tts-${id}.mp3`);
        const chunks: Buffer[] = [];
        for await (const chunk of audio) {
          chunks.push(Buffer.from(chunk));
        }
        fs.writeFileSync(tmpPath, Buffer.concat(chunks));

        return {
          content: [
            {
              type: 'text' as const,
              text: `Audio gerado com sucesso.\nARQUIVO_AUDIO: ${tmpPath}\nDuracao estimada: ${Math.round(Buffer.concat(chunks).length / 16000)}s`,
            },
          ],
        };
      }

      case 'preview_voice': {
        const voiceId = resolveVoiceId(a.voice_id);
        const previewText = (a.text as string) || 'Ola! Eu sou uma voz da ElevenLabs. Como posso ajudar voce hoje?';
        const audio = await client.textToSpeech.convert(voiceId, {
          text: previewText,
          modelId: 'eleven_flash_v2_5',
        });
        const id = crypto.randomUUID();
        const tmpPath = path.join(os.tmpdir(), `lionclaw-preview-${id}.mp3`);
        const chunks: Buffer[] = [];
        for await (const chunk of audio) {
          chunks.push(Buffer.from(chunk));
        }
        fs.writeFileSync(tmpPath, Buffer.concat(chunks));

        return {
          content: [
            {
              type: 'text' as const,
              text: `Preview de voz gerado.\nARQUIVO_AUDIO: ${tmpPath}`,
            },
          ],
        };
      }

      case 'speech_to_text': {
        const audioBuffer = fs.readFileSync(a.audio_path as string);
        const blob = new Blob([audioBuffer]);
        const transcript = await client.speechToText.convert({
          file: blob,
          modelId: 'scribe_v1',
          languageCode: (a.language as string) || 'pt',
        });
        return { content: [{ type: 'text' as const, text: JSON.stringify(transcript, null, 2) }] };
      }

      case 'get_voice_settings': {
        const voice = await client.voices.get(a.voice_id as string);
        const settings = voice.settings;
        return { content: [{ type: 'text' as const, text: JSON.stringify(settings, null, 2) }] };
      }

      case 'update_voice_settings': {
        const currentVoice = await client.voices.get(a.voice_id as string);
        const newSettings = {
          stability: (a.stability as number) ?? currentVoice.settings?.stability,
          similarityBoost: (a.similarity_boost as number) ?? currentVoice.settings?.similarityBoost,
          style: (a.style as number) ?? currentVoice.settings?.style,
          speed: (a.speed as number) ?? currentVoice.settings?.speed,
        };
        const apiKey = process.env.ELEVENLABS_API_KEY;
        await fetch(`https://api.elevenlabs.io/v1/voices/${a.voice_id}/settings/edit`, {
          method: 'POST',
          headers: { 'xi-api-key': apiKey || '', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            stability: newSettings.stability,
            similarity_boost: newSettings.similarityBoost,
            style: newSettings.style,
            speed: newSettings.speed,
          }),
        });
        return { content: [{ type: 'text' as const, text: 'Configuracoes da voz atualizadas com sucesso.' }] };
      }

      case 'get_models': {
        const models = await client.models.list();
        return { content: [{ type: 'text' as const, text: JSON.stringify(models, null, 2) }] };
      }

      case 'get_user_info': {
        const user = await client.user.subscription.get();
        return { content: [{ type: 'text' as const, text: JSON.stringify(user, null, 2) }] };
      }

      default:
        return { content: [{ type: 'text' as const, text: `Tool desconhecida: ${name}` }], isError: true };
    }
  } catch (err) {
    return {
      content: [{ type: 'text' as const, text: `Erro ElevenLabs: ${(err as Error).message}` }],
      isError: true,
    };
  }
});

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err}\n`);
  process.exit(1);
});
