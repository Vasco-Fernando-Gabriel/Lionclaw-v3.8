import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { captureToolResult, captureToolUse } from '../artifact-detector';

const createdDirs: string[] = [];

function writeTempImage(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lionclaw-artifact-'));
  createdDirs.push(dir);
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, Buffer.from('fake image bytes'));
  return filePath;
}

afterEach(() => {
  for (const dir of createdDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('artifact-detector image paths', () => {
  it('creates an image artifact from markdown local image paths', () => {
    const imagePath = writeTempImage('codex-feliz.png');

    const artifact = captureToolResult(
      'tool-1',
      `Funcionou:\n![Codex feliz](${imagePath})`,
      false,
    );

    expect(artifact?.type).toBe('image');
    expect(artifact?.title).toContain('Codex feliz');
    expect(artifact?.data.filePath).toBe(imagePath);
    expect(artifact?.data.mimeType).toBe('image/png');
    expect(artifact?.data.imageBase64).toBe(Buffer.from('fake image bytes').toString('base64'));
  });

  it('creates an image artifact from labelled file paths', () => {
    const imagePath = writeTempImage('saida.webp');

    const artifact = captureToolResult(
      'tool-2',
      `Arquivo: ${imagePath}\nPrompt: codex feliz`,
      false,
    );

    expect(artifact?.type).toBe('image');
    expect(artifact?.data.filePath).toBe(imagePath);
    expect(artifact?.data.mimeType).toBe('image/webp');
  });

  it('creates an image artifact from inline Codex image generation JSON', () => {
    const imageBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ';

    const artifact = captureToolResult(
      'tool-3',
      JSON.stringify({
        type: 'image_generation_result',
        imageBase64,
        mimeType: 'image/png',
        prompt: 'Codex feliz',
        toolName: 'codex.image_generation',
      }),
      false,
    );

    expect(artifact?.type).toBe('image');
    expect(artifact?.toolName).toBe('codex.image_generation');
    expect(artifact?.data.imageBase64).toBe(imageBase64);
    expect(artifact?.data.mimeType).toBe('image/png');
    expect(artifact?.data.prompt).toBe('Codex feliz');
  });
});

describe('artifact-detector MCP apps', () => {
  it('creates an Excalidraw mcp_app artifact from Lion-SDK mcp_call input', () => {
    const artifact = captureToolUse('tool-4', 'mcp_call', {
      server_id: 'excalidraw',
      tool: 'create_view',
      args: {
        title: 'Arquitetura',
        elements: [
          {
            type: 'rectangle',
            x: 10,
            y: 20,
            width: 120,
            height: 60,
          },
        ],
      },
    });

    expect(artifact?.type).toBe('mcp_app');
    expect(artifact?.title).toBe('Arquitetura');
    expect(artifact?.toolName).toBe('mcp:excalidraw.create_view');
    expect(typeof artifact?.data.viewId).toBe('string');
    expect(String(artifact?.data.excalidrawFile)).toContain('"type": "excalidraw"');
  });

  it('creates an Excalidraw mcp_app artifact when Lion-SDK emits renderer mcp label', () => {
    const artifact = captureToolUse('tool-5', 'mcp:excalidraw.create_view', {
      server_id: 'excalidraw',
      tool: 'create_view',
      args: {
        title: 'Fluxo',
        elements: [
          {
            type: 'rectangle',
            x: 0,
            y: 0,
            width: 140,
            height: 80,
          },
        ],
      },
    });

    expect(artifact?.type).toBe('mcp_app');
    expect(artifact?.title).toBe('Fluxo');
    expect(artifact?.toolName).toBe('mcp:excalidraw.create_view');
  });
});


function writeTempFile(name: string, content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lionclaw-artifact-'));
  createdDirs.push(dir);
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content);
  return filePath;
}

describe('artifact-detector ENVIAR_ARQUIVO (document)', () => {
  it('cria artifact document com path + metadata, SEM ler o arquivo para base64', () => {
    const filePath = writeTempFile('relatorio.pdf', 'conteudo pdf fake');

    const artifact = captureToolResult('tool-doc-1', `Gerei o relatorio.\nENVIAR_ARQUIVO: ${filePath}`, false);

    expect(artifact?.type).toBe('document');
    expect(artifact?.title).toBe('Arquivo: relatorio.pdf');
    expect(artifact?.data.filePath).toBe(filePath);
    expect(artifact?.data.fileName).toBe('relatorio.pdf');
    expect(artifact?.data.size).toBe(Buffer.byteLength('conteudo pdf fake'));
    expect(artifact?.data.mimeType).toBe('application/pdf');
    expect(artifact?.data.imageBase64).toBeUndefined();
    expect(artifact?.data.audioBase64).toBeUndefined();
  });

  it('marcador explicito VENCE a heuristica de extensao: .png via ENVIAR_ARQUIVO vai como documento', () => {
    const imagePath = writeTempImage('grafico.png');

    const artifact = captureToolResult('tool-doc-2', `Pronto!\nENVIAR_ARQUIVO: ${imagePath}`, false);

    expect(artifact?.type).toBe('document');
    expect(artifact?.data.fileName).toBe('grafico.png');
    expect(artifact?.data.mimeType).toBe('image/png');
    expect(artifact?.data.imageBase64).toBeUndefined();
  });

  it('marcador com arquivo inexistente cai nas heuristicas seguintes (imagem ainda detectavel)', () => {
    const imagePath = writeTempImage('valida.png');

    const artifact = captureToolResult(
      'tool-doc-3',
      `ENVIAR_ARQUIVO: /caminho/que/nao/existe.bin\n![ok](${imagePath})`,
      false,
    );

    expect(artifact?.type).toBe('image');
    expect(artifact?.data.filePath).toBe(imagePath);
  });

  it('extensao desconhecida recebe mime octet-stream', () => {
    const filePath = writeTempFile('dados.qualquer', 'x');

    const artifact = captureToolResult('tool-doc-4', `ENVIAR_ARQUIVO: ${filePath}`, false);

    expect(artifact?.type).toBe('document');
    expect(artifact?.data.mimeType).toBe('application/octet-stream');
  });

  it('vídeo gerado fora da Knowledge continua detectado como artifact MP4', () => {
    const filePath = writeTempFile('higgsfield-output.mp4', 'fake video bytes');

    const artifact = captureToolResult(
      'tool-video-1',
      `ENVIAR_ARQUIVO: ${filePath}`,
      false,
    );

    expect(artifact?.type).toBe('document');
    expect(artifact?.data.fileName).toBe('higgsfield-output.mp4');
    expect(artifact?.data.mimeType).toBe('video/mp4');
  });
});
