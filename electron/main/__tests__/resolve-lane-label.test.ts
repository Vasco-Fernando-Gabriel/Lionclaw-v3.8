import { describe, expect, it } from 'vitest';

import { LANE_TITLE_MAX_CHARS, resolveLaneLabel, type LaneLabelSessionRow, type ResolveLaneLabelDeps } from '../lanes';

function makeDeps(lanes: Record<string, LaneLabelSessionRow>, sessions: string[] = []): ResolveLaneLabelDeps {
  return {
    getOpenLaneSessionById: (sessionId) => lanes[sessionId] ?? null,
    getSession: (sessionId) => (lanes[sessionId] || sessions.includes(sessionId) ? { id: sessionId } : undefined),
  };
}

describe('resolveLaneLabel (RM3/RM6)', () => {
  it('lane aberta: Lane <badge>: "<titulo>"', () => {
    const deps = makeDeps({ sess_1: { laneBadge: 1, title: 'Refatorar o boot' } });

    expect(resolveLaneLabel('sess_1', deps)).toBe('Lane 1: "Refatorar o boot"');
  });

  it('lane aberta sem titulo cai em "Nova conversa"', () => {
    const deps = makeDeps({ sess_1: { laneBadge: 2, title: '   ' } });

    expect(resolveLaneLabel('sess_1', deps)).toBe('Lane 2: "Nova conversa"');
  });

  it('sessao existente que nao e lane aberta: uma conversa encerrada', () => {
    const deps = makeDeps({}, ['sess_velha']);

    expect(resolveLaneLabel('sess_velha', deps)).toBe('uma conversa encerrada');
  });

  it('id inexistente: conversa desconhecida', () => {
    const deps = makeDeps({}, []);

    expect(resolveLaneLabel('sess_fantasma', deps)).toBe('conversa desconhecida');
  });

  it('lane aberta sem badge (impossivel na pratica) cai em conversa desconhecida', () => {
    const deps = makeDeps({ sess_1: { laneBadge: null, title: 'Sem badge' } });

    expect(resolveLaneLabel('sess_1', deps)).toBe('conversa desconhecida');
  });

  it('titulo maior que o teto e truncado com reticencias; exatamente no teto fica intacto', () => {
    expect(LANE_TITLE_MAX_CHARS).toBe(40);
    const exact = 'a'.repeat(LANE_TITLE_MAX_CHARS);
    const long = `${'b'.repeat(LANE_TITLE_MAX_CHARS)}CORTADO`;

    expect(resolveLaneLabel('sess_exact', makeDeps({ sess_exact: { laneBadge: 1, title: exact } }))).toBe(
      `Lane 1: "${exact}"`,
    );
    expect(resolveLaneLabel('sess_long', makeDeps({ sess_long: { laneBadge: 1, title: long } }))).toBe(
      `Lane 1: "${'b'.repeat(LANE_TITLE_MAX_CHARS)}..."`,
    );
  });
});
