import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  insertMessage: vi.fn(() => 42),
}));

import { insertMessage } from '../db';
import { buildUserAttachmentsMeta, persistUserChatMessage } from '../user-attachments-meta';

const mockedInsertMessage = vi.mocked(insertMessage);

const IMG = {
  id: 'img-1',
  type: 'image',
  filename: 'foto.jpg',
  mimeType: 'image/jpeg',
  preview: 'data:image/jpeg;base64,THUMB',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('buildUserAttachmentsMeta', () => {
  it('retorna undefined sem anexos (turno so-texto segue byte-identico)', () => {
    expect(buildUserAttachmentsMeta(undefined)).toBeUndefined();
    expect(buildUserAttachmentsMeta([])).toBeUndefined();
  });

  it('mapeia imagem COM preview para o descritor leve (sem data/size)', () => {
    const metas = buildUserAttachmentsMeta([IMG]);
    expect(metas).toEqual([
      {
        id: 'img-1',
        type: 'image',
        filename: 'foto.jpg',
        mimeType: 'image/jpeg',
        preview: 'data:image/jpeg;base64,THUMB',
      },
    ]);
  });

  it('ignora anexo de audio e imagem SEM preview (ex.: Telegram)', () => {
    expect(
      buildUserAttachmentsMeta([
        { id: 'a1', type: 'audio', filename: 'voz.webm', mimeType: 'audio/webm', preview: 'x' },
        { id: 'img-2', type: 'image', filename: 'tg.jpg', mimeType: 'image/jpeg' },
        { id: 'img-3', type: 'image', filename: 'vazio.png', mimeType: 'image/png', preview: '' },
      ]),
    ).toBeUndefined();
  });

  it('descarta preview anomalo acima do teto de tamanho', () => {
    const huge = { ...IMG, id: 'img-huge', preview: 'x'.repeat(300_001) };
    expect(buildUserAttachmentsMeta([huge])).toBeUndefined();
    const metas = buildUserAttachmentsMeta([huge, IMG]);
    expect(metas).toHaveLength(1);
    expect(metas?.[0].id).toBe('img-1');
  });
});

describe('persistUserChatMessage', () => {
  it('sem metadata: chamada IDENTICA a atual (3 argumentos)', () => {
    const id = persistUserChatMessage('sess-1', 'ola');
    expect(id).toBe(42);
    expect(mockedInsertMessage).toHaveBeenCalledTimes(1);
    expect(mockedInsertMessage).toHaveBeenCalledWith('sess-1', 'user', 'ola');
  });

  it('com metadata: persiste attachmentsMeta como JSON no campo metadata', () => {
    const metas = buildUserAttachmentsMeta([IMG])!;
    const id = persistUserChatMessage('sess-1', 'olha essa foto', metas);
    expect(id).toBe(42);
    expect(mockedInsertMessage).toHaveBeenCalledWith(
      'sess-1',
      'user',
      'olha essa foto',
      undefined,
      JSON.stringify({ attachmentsMeta: metas }),
    );
    const [, , content] = mockedInsertMessage.mock.calls[0];
    expect(content).toBe('olha essa foto');
  });

  it('lista vazia se comporta como sem metadata', () => {
    persistUserChatMessage('sess-1', 'oi', []);
    expect(mockedInsertMessage).toHaveBeenCalledWith('sess-1', 'user', 'oi');
  });
});
