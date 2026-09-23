import { describe, it, expect } from 'vitest';
import { buildDynamicWorkflowSection } from '../prompt-builder';

describe('E5: prompt do orquestrador reflete driver unico + modo automatico', () => {
  const section = buildDynamicWorkflowSection();

  it('REMOVE a descricao do Maestro per-run "no loop"', () => {
    expect(section).not.toContain('PRESENTE no loop do run');
    expect(section).not.toMatch(/um Maestro \(agente autor\+controlador/);
  });

  it('descreve o orquestrador como driver unico controlando pelo chat principal', () => {
    expect(section).toContain('unico driver');
    expect(section).toContain('chat principal');
    expect(section).toMatch(/nao ha um segundo agente de chat dentro da RunView/);
  });

  it('REMOVE a generalizacao de que entrega/merge SEMPRE exigem aval humano', () => {
    expect(section).not.toMatch(/Gates HUMANOS \(entrega\/merge\) voce aprova QUANDO o humano/);
    expect(section).not.toContain('igual ao Claude Code agindo do go-ahead; nao manda clicar botao');
  });

  it('descreve entrega/merge LOCAL reversivel aprovada pelo orquestrador sozinho', () => {
    expect(section).toContain('merge LOCAL e reversivel');
    expect(section).toMatch(/sem nunca esperar aval humano/);
    expect(section).toMatch(/voce conduz TODOS os gates do run sozinho \(boundary: e cc-delivery\)/);
  });

  it('reafirma "nunca da push"', () => {
    expect(section).toContain('nunca da push');
  });

  it('PRESERVA a escalada de negocio (go-ahead humano p/ bloqueio real de negocio ou a pedido)', () => {
    expect(section).toMatch(/ESCALE ao humano/);
    expect(section).toMatch(/bloqueio real de NEGOCIO ou quando ele pedir/);
  });

  it('cita o modo unico full-automatico conduzindo os gates tecnicos (boundary: e cc-delivery) sozinho', () => {
    expect(section).toContain('MODO UNICO full-automatico');
    expect(section).toContain('cc-delivery');
    expect(section).toContain('boundary:');
    expect(section).toMatch(
      /voce conduz TODOS os gates do run sozinho \(boundary: e cc-delivery\) sem nunca esperar aval humano/,
    );
  });

  it('NAO menciona mais os modos semi/full/auto-drive nem set-autonomy', () => {
    expect(section).not.toMatch(/em full voce decide a entrega mas o plan-review fica com o humano/);
    expect(section).not.toMatch(/em semi ambos ficam com o humano e voce escala/);
    expect(section).not.toContain('auto-drive');
    expect(section).not.toContain('set-autonomy');
  });

  it('o freio humano do modo automatico e pausar pelo chat ({ type: "pause" })', () => {
    expect(section).toMatch(/\{ type: "pause" \}/);
    expect(section).toMatch(/o unico freio do modo automatico/);
  });
});
