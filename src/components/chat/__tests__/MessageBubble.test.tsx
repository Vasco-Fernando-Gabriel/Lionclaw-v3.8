// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MessageBubble, collectImageThumbs } from '../MessageBubble';
import {
  VISION_TRANSCRIPTION_MARKER,
  splitVisionTranscription,
} from '@/constants/vision';
import type { ChatAttachment, ChatAttachmentMeta } from '@/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(el: React.ReactElement) {
  act(() => {
    root.render(el);
  });
}

function click(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

const TRANSCRIPTION = 'Print de tela com um grafico de vendas e o titulo Q4.';
const CONTENT_WITH_BLOCK = `qual o resumo?\n\n${VISION_TRANSCRIPTION_MARKER}\n${TRANSCRIPTION}`;

const LIVE_IMG: ChatAttachment = {
  id: 'img-live',
  type: 'image',
  filename: 'print.png',
  mimeType: 'image/png',
  data: 'QUFBQQ==',
  size: 4,
  preview: 'data:image/png;base64,LIVETHUMB',
};

const META_IMG: ChatAttachmentMeta = {
  id: 'img-meta',
  type: 'image',
  filename: 'foto.jpg',
  mimeType: 'image/jpeg',
  preview: 'data:image/jpeg;base64,METATHUMB',
};

function findChip(): HTMLButtonElement | null {
  const buttons = Array.from(container.querySelectorAll('button'));
  return (
    (buttons.find((b) =>
      (b.textContent || '').includes('Imagem transcrita pelo vision'),
    ) as HTMLButtonElement | undefined) ?? null
  );
}

describe('splitVisionTranscription', () => {
  it('separa texto original e transcricao no marcador', () => {
    const parts = splitVisionTranscription(CONTENT_WITH_BLOCK);
    expect(parts.text).toBe('qual o resumo?');
    expect(parts.transcription).toBe(TRANSCRIPTION);
  });

  it('sem marcador: conteudo intacto e transcription null', () => {
    const parts = splitVisionTranscription('mensagem normal');
    expect(parts.text).toBe('mensagem normal');
    expect(parts.transcription).toBeNull();
  });

  it('mensagem que e SO o bloco: text vazio', () => {
    const parts = splitVisionTranscription(`${VISION_TRANSCRIPTION_MARKER}\nso ocr`);
    expect(parts.text).toBe('');
    expect(parts.transcription).toBe('so ocr');
  });
});

describe('MessageBubble - transcricao do vision colapsada', () => {
  it('mostra o texto original e NAO vaza a transcricao (colapsada por padrao)', () => {
    render(<MessageBubble role="user" content={CONTENT_WITH_BLOCK} />);

    expect(container.textContent).toContain('qual o resumo?');
    expect(container.textContent).not.toContain(TRANSCRIPTION);
    expect(container.textContent).not.toContain(VISION_TRANSCRIPTION_MARKER);

    const chip = findChip();
    expect(chip).not.toBeNull();
    expect(chip!.getAttribute('aria-expanded')).toBe('false');
    expect(chip!.textContent).toContain('expandir');
  });

  it('expande no clique e recolhe no segundo clique', () => {
    render(<MessageBubble role="user" content={CONTENT_WITH_BLOCK} />);
    const chip = findChip()!;

    click(chip);
    expect(container.textContent).toContain(TRANSCRIPTION);
    expect(chip.getAttribute('aria-expanded')).toBe('true');
    expect(chip.textContent).toContain('recolher');

    click(chip);
    expect(container.textContent).not.toContain(TRANSCRIPTION);
    expect(chip.getAttribute('aria-expanded')).toBe('false');
  });

  it('mensagem SEM marcador: render normal, sem chip', () => {
    render(<MessageBubble role="user" content="mensagem comum" />);
    expect(container.textContent).toContain('mensagem comum');
    expect(findChip()).toBeNull();
  });

  it('mensagem que e SO o bloco: chip presente, sem paragrafo vazio', () => {
    render(
      <MessageBubble
        role="user"
        content={`${VISION_TRANSCRIPTION_MARKER}\n${TRANSCRIPTION}`}
      />,
    );
    expect(findChip()).not.toBeNull();
    expect(container.querySelector('p.whitespace-pre-wrap.selectable')).toBeNull();
    expect(container.textContent).not.toContain(TRANSCRIPTION);
  });

  it('assistant message: sem chip, conteudo renderizado via markdown', () => {
    render(<MessageBubble role="assistant" content="resposta *ok*" />);
    expect(findChip()).toBeNull();
    expect(container.textContent).toContain('resposta');
  });
});

describe('MessageBubble - miniatura da imagem', () => {
  it('attachments vivos: miniatura presente com o preview', () => {
    render(
      <MessageBubble role="user" content="olha" attachments={[LIVE_IMG]} />,
    );
    const img = container.querySelector('img[alt="print.png"]') as HTMLImageElement | null;
    expect(img).not.toBeNull();
    expect(img!.getAttribute('src')).toBe('data:image/png;base64,LIVETHUMB');
  });

  it('attachmentsMeta persistida (rehidratacao): miniatura volta a aparecer', () => {
    render(
      <MessageBubble
        role="user"
        content={CONTENT_WITH_BLOCK}
        attachmentsMeta={[META_IMG]}
      />,
    );
    const img = container.querySelector('img[alt="foto.jpg"]') as HTMLImageElement | null;
    expect(img).not.toBeNull();
    expect(img!.getAttribute('src')).toBe('data:image/jpeg;base64,METATHUMB');
    expect(container.textContent).not.toContain(TRANSCRIPTION);
  });

  it('dedupe por id quando o anexo vivo e a metadata coexistem', () => {
    const thumbs = collectImageThumbs(
      [LIVE_IMG],
      [{ ...META_IMG, id: LIVE_IMG.id }, META_IMG],
    );
    expect(thumbs).toHaveLength(2);
    expect(thumbs.map((t) => t.id)).toEqual(['img-live', 'img-meta']);
    expect(thumbs[0].src).toBe('data:image/png;base64,LIVETHUMB');
  });

  it('anexo de imagem sem preview (vivo) cai no data URI completo', () => {
    const { preview: _omitted, ...rest } = LIVE_IMG;
    const thumbs = collectImageThumbs([{ ...rest }]);
    expect(thumbs[0].src).toBe('data:image/png;base64,QUFBQQ==');
  });
});
