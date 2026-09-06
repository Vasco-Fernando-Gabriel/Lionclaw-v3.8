#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { GoogleGenAI } from '@google/genai';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

function getClient(): GoogleGenAI {
  const apiKey = process.env.GOOGLE_GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GOOGLE_GEMINI_API_KEY nao configurada.');
  }
  return new GoogleGenAI({ apiKey });
}

function extractImage(
  parts: Array<{ inlineData?: { data: string; mimeType: string }; text?: string }>,
): { base64: string; mimeType: string; text: string } | null {
  let imageBase64 = '';
  let mimeType = 'image/png';
  let text = '';

  for (const part of parts) {
    if (part.inlineData) {
      imageBase64 = part.inlineData.data;
      mimeType = part.inlineData.mimeType || 'image/png';
    }
    if (part.text) {
      text = part.text;
    }
  }

  if (!imageBase64) return null;
  return { base64: imageBase64, mimeType, text };
}

const server = new Server(
  { name: 'nano-banana', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'generate_image',
      description: 'Gerar uma imagem a partir de um prompt de texto usando Gemini 2.5 Flash Image (Nano Banana). Retorna o caminho do arquivo PNG gerado. Gratuito, 500 imagens/dia.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          prompt: {
            type: 'string',
            description: 'Descricao detalhada da imagem a gerar. Quanto mais detalhado, melhor o resultado.',
          },
          aspect_ratio: {
            type: 'string',
            enum: ['1:1', '3:4', '4:3', '9:16', '16:9'],
            description: 'Proporcao da imagem. Padrao: 1:1',
          },
        },
        required: ['prompt'],
      },
    },
    {
      name: 'edit_image',
      description: 'Editar uma imagem existente com instrucoes em texto. Passa a imagem original e um prompt descrevendo as alteracoes desejadas.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          prompt: {
            type: 'string',
            description: 'Instrucoes de edicao (ex: "remova o fundo", "adicione um chapeu").',
          },
          image_path: {
            type: 'string',
            description: 'Caminho do arquivo de imagem a editar.',
          },
          aspect_ratio: {
            type: 'string',
            enum: ['1:1', '3:4', '4:3', '9:16', '16:9'],
            description: 'Proporcao da imagem resultante. Padrao: mantém a original.',
          },
        },
        required: ['prompt', 'image_path'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const a = (args || {}) as Record<string, unknown>;

  try {
    switch (name) {
      case 'generate_image': {
        const ai = getClient();
        const prompt = a.prompt as string;
        const aspectRatio = a.aspect_ratio as string | undefined;

        const response = await ai.models.generateContent({
          model: 'gemini-2.5-flash-image',
          contents: [{ text: prompt }],
          config: {
            responseModalities: ['TEXT', 'IMAGE'],
            ...(aspectRatio && {
              imageConfig: { aspectRatio },
            }),
          },
        });

        const parts = response.candidates?.[0]?.content?.parts;
        if (!parts) {
          return { content: [{ type: 'text' as const, text: 'Erro: resposta vazia da API Gemini.' }], isError: true };
        }

        const image = extractImage(
          parts as Array<{ inlineData?: { data: string; mimeType: string }; text?: string }>,
        );
        if (!image) {
          const textOnly = parts.map((p) => 'text' in p ? (p as { text?: string }).text : undefined).filter(Boolean).join('\n');
          return {
            content: [{ type: 'text' as const, text: `Nao foi possivel gerar a imagem.${textOnly ? ` Resposta: ${textOnly}` : ''}` }],
            isError: true,
          };
        }

        const ext = image.mimeType.includes('png') ? 'png' : 'jpg';
        const tmpPath = path.join(os.tmpdir(), `lionclaw-nano-${crypto.randomUUID()}.${ext}`);
        fs.writeFileSync(tmpPath, Buffer.from(image.base64, 'base64'));

        return {
          content: [{
            type: 'text' as const,
            text: `Imagem gerada com sucesso.\nARQUIVO_IMAGEM: ${tmpPath}\nPrompt: ${prompt}${image.text ? `\nDescricao: ${image.text}` : ''}`,
          }],
        };
      }

      case 'edit_image': {
        const ai = getClient();
        const prompt = a.prompt as string;
        const imagePath = a.image_path as string;
        const aspectRatio = a.aspect_ratio as string | undefined;

        if (!fs.existsSync(imagePath)) {
          return { content: [{ type: 'text' as const, text: `Arquivo nao encontrado: ${imagePath}` }], isError: true };
        }

        const imageBuffer = fs.readFileSync(imagePath);
        const imageBase64 = imageBuffer.toString('base64');
        const ext = path.extname(imagePath).toLowerCase();
        const mimeMap: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
        const mimeType = mimeMap[ext] || 'image/png';

        const response = await ai.models.generateContent({
          model: 'gemini-2.5-flash-image',
          contents: [
            { text: prompt },
            {
              inlineData: {
                mimeType,
                data: imageBase64,
              },
            },
          ],
          config: {
            responseModalities: ['TEXT', 'IMAGE'],
            ...(aspectRatio && {
              imageConfig: { aspectRatio },
            }),
          },
        });

        const parts = response.candidates?.[0]?.content?.parts;
        if (!parts) {
          return { content: [{ type: 'text' as const, text: 'Erro: resposta vazia ao editar imagem.' }], isError: true };
        }

        const image = extractImage(
          parts as Array<{ inlineData?: { data: string; mimeType: string }; text?: string }>,
        );
        if (!image) {
          return { content: [{ type: 'text' as const, text: 'Nao foi possivel editar a imagem.' }], isError: true };
        }

        const outExt = image.mimeType.includes('png') ? 'png' : 'jpg';
        const tmpPath = path.join(os.tmpdir(), `lionclaw-nano-${crypto.randomUUID()}.${outExt}`);
        fs.writeFileSync(tmpPath, Buffer.from(image.base64, 'base64'));

        return {
          content: [{
            type: 'text' as const,
            text: `Imagem editada com sucesso.\nARQUIVO_IMAGEM: ${tmpPath}\nPrompt: ${prompt}`,
          }],
        };
      }

      default:
        return { content: [{ type: 'text' as const, text: `Tool desconhecida: ${name}` }], isError: true };
    }
  } catch (err) {
    const message = (err as Error).message;
    const isRateLimit = message.includes('429') || message.toLowerCase().includes('rate');
    return {
      content: [{
        type: 'text' as const,
        text: isRateLimit
          ? 'Limite de taxa atingido (2 imagens/minuto no free tier). Aguarde um momento e tente novamente.'
          : `Erro Nano Banana: ${message}`,
      }],
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
