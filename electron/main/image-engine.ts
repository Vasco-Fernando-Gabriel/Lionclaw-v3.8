import { GoogleGenAI } from '@google/genai';
import { createLogger } from './logger';
import { getSecret } from './secrets-vault';

const logger = createLogger('image-engine');

export interface GenerateImageResult {
  base64: string;
  mimeType: string;
  prompt: string;
}

export interface GenerateImageOptions {
  aspectRatio?: '1:1' | '3:4' | '4:3' | '9:16' | '16:9';
}

async function getClient(): Promise<GoogleGenAI> {
  const apiKey = await getSecret('GOOGLE_GEMINI_API_KEY');
  if (!apiKey) {
    throw new Error('GOOGLE_GEMINI_API_KEY nao configurada. Configure no Vault.');
  }
  return new GoogleGenAI({ apiKey });
}

function extractImageFromParts(parts: Array<{ inlineData?: { data: string; mimeType: string }; text?: string }>): {
  imageData: { base64: string; mimeType: string } | null;
  textResponse: string;
} {
  let imageData: { base64: string; mimeType: string } | null = null;
  let textResponse = '';

  for (const part of parts) {
    if (part.inlineData) {
      imageData = {
        base64: part.inlineData.data,
        mimeType: part.inlineData.mimeType || 'image/png',
      };
    }
    if (part.text) {
      textResponse = part.text;
    }
  }

  return { imageData, textResponse };
}

export async function generateImage(prompt: string, options?: GenerateImageOptions): Promise<GenerateImageResult> {
  const ai = await getClient();

  logger.info({ prompt: prompt.substring(0, 80) }, 'Generating image with Nano Banana');

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash-image', // gate-allow: gerador de imagem Nano Banana, feature nao-LLM fora do escopo
    contents: [{ text: prompt }],
    config: {
      responseModalities: ['TEXT', 'IMAGE'],
      ...(options?.aspectRatio && {
        imageConfig: { aspectRatio: options.aspectRatio },
      }),
    },
  });

  const parts = response.candidates?.[0]?.content?.parts;
  if (!parts) {
    throw new Error('Nano Banana: resposta vazia, nenhuma imagem gerada.');
  }

  const { imageData, textResponse } = extractImageFromParts(
    parts as Array<{ inlineData?: { data: string; mimeType: string }; text?: string }>,
  );

  if (!imageData) {
    throw new Error(
      `Nano Banana: nenhuma imagem na resposta.${textResponse ? ` Modelo respondeu: ${textResponse}` : ''}`,
    );
  }

  logger.info({ mimeType: imageData.mimeType, hasText: !!textResponse }, 'Image generated successfully');

  return {
    base64: imageData.base64,
    mimeType: imageData.mimeType,
    prompt,
  };
}

export async function editImage(
  prompt: string,
  imageBase64: string,
  imageMimeType: string,
  options?: GenerateImageOptions,
): Promise<GenerateImageResult> {
  const ai = await getClient();

  logger.info({ prompt: prompt.substring(0, 80) }, 'Editing image with Nano Banana');

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash-image', // gate-allow: gerador de imagem Nano Banana, feature nao-LLM fora do escopo
    contents: [
      { text: prompt },
      {
        inlineData: {
          mimeType: imageMimeType,
          data: imageBase64,
        },
      },
    ],
    config: {
      responseModalities: ['TEXT', 'IMAGE'],
      ...(options?.aspectRatio && {
        imageConfig: { aspectRatio: options.aspectRatio },
      }),
    },
  });

  const parts = response.candidates?.[0]?.content?.parts;
  if (!parts) {
    throw new Error('Nano Banana: resposta vazia ao editar imagem.');
  }

  const { imageData } = extractImageFromParts(
    parts as Array<{ inlineData?: { data: string; mimeType: string }; text?: string }>,
  );

  if (!imageData) {
    throw new Error('Nano Banana: nenhuma imagem editada na resposta.');
  }

  logger.info({ mimeType: imageData.mimeType }, 'Image edited successfully');

  return {
    base64: imageData.base64,
    mimeType: imageData.mimeType,
    prompt,
  };
}
