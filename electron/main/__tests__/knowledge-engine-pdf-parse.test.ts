import { describe, expect, it, vi } from 'vitest';
import { extractPdfText } from '../knowledge-engine';

describe('extractPdfText', () => {
  it('mantem compatibilidade com o export callable do pdf-parse 1.x', async () => {
    const legacy = vi.fn(async (buffer: Buffer) => ({ text: `legacy:${buffer.toString()}` }));

    await expect(extractPdfText(Buffer.from('pdf'), legacy)).resolves.toEqual({
      text: 'legacy:pdf',
    });
    expect(legacy).toHaveBeenCalledOnce();
  });

  it('usa PDFParse e sempre libera os recursos no pdf-parse 2.x', async () => {
    const destroy = vi.fn(async () => undefined);
    const getText = vi.fn(async () => ({ text: 'modern' }));
    const PDFParse = vi.fn(function PdfParse(this: { getText: typeof getText; destroy: typeof destroy }) {
      this.getText = getText;
      this.destroy = destroy;
    });

    await expect(extractPdfText(Buffer.from('pdf'), { PDFParse })).resolves.toEqual({
      text: 'modern',
    });
    expect(PDFParse).toHaveBeenCalledWith({ data: Buffer.from('pdf') });
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('chama destroy mesmo quando getText falha', async () => {
    const destroy = vi.fn(async () => undefined);
    class PDFParse {
      async getText(): Promise<{ text: string }> {
        throw new Error('broken pdf');
      }

      async destroy(): Promise<void> {
        await destroy();
      }
    }

    await expect(extractPdfText(Buffer.from('pdf'), { PDFParse })).rejects.toThrow('broken pdf');
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('rejeita um shape desconhecido com erro explicito', async () => {
    await expect(extractPdfText(Buffer.from('pdf'), {})).rejects.toThrow('pdf-parse export is not supported');
  });
});

describe('extractPdfText com o pdf-parse instalado (smoke real)', () => {
  it('extrai texto de um PDF minimo com o export real do pacote', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const realModule: unknown = require('pdf-parse');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('node:path') as typeof import('node:path');
    const buffer = fs.readFileSync(path.join(__dirname, 'fixtures', 'hello-lionclaw.pdf'));

    const result = await extractPdfText(buffer, realModule);
    expect(result.text).toContain('Hello LionClaw');
  });
});
