import { describe, it, expect } from 'vitest';
import {
  CURSOR_SIDECAR_RPC_PREFIX,
  createSidecarLineDecoder,
  encodeSidecarLine,
  type CursorSidecarHostMessage,
} from '../agent-runtime/cursor-sidecar/protocol';

describe('cursor-sidecar protocol framing', () => {
  it('encode produz linha prefixada terminada em \\n', () => {
    const msg: CursorSidecarHostMessage = { type: 'ping', id: 'p1' };
    const line = encodeSidecarLine(msg);
    expect(line.startsWith(CURSOR_SIDECAR_RPC_PREFIX)).toBe(true);
    expect(line.endsWith('\n')).toBe(true);
    expect(JSON.parse(line.slice(CURSOR_SIDECAR_RPC_PREFIX.length))).toEqual(msg);
  });

  it('decoder remonta mensagens de chunks fragmentados', () => {
    const received: Array<Record<string, unknown>> = [];
    const feed = createSidecarLineDecoder((m) => received.push(m));
    const line = encodeSidecarLine({ type: 'ping', id: 'p2' });
    feed(line.slice(0, 5));
    feed(line.slice(5));
    expect(received).toEqual([{ type: 'ping', id: 'p2' }]);
  });

  it('decoder ignora poluicao sem prefixo e reporta em onGarbage', () => {
    const received: Array<Record<string, unknown>> = [];
    const garbage: string[] = [];
    const feed = createSidecarLineDecoder(
      (m) => received.push(m),
      (l) => garbage.push(l),
    );
    feed('log qualquer do sdk\n');
    feed(encodeSidecarLine({ type: 'ping', id: 'p3' }));
    feed('\n');
    expect(received).toEqual([{ type: 'ping', id: 'p3' }]);
    expect(garbage).toEqual(['log qualquer do sdk']);
  });

  it('decoder tolera CRLF e JSON invalido apos o prefixo', () => {
    const received: Array<Record<string, unknown>> = [];
    const garbage: string[] = [];
    const feed = createSidecarLineDecoder(
      (m) => received.push(m),
      (l) => garbage.push(l),
    );
    feed(`${CURSOR_SIDECAR_RPC_PREFIX}{"type":"pong","id":"x"}\r\n`);
    feed(`${CURSOR_SIDECAR_RPC_PREFIX}{nao-e-json\n`);
    expect(received).toEqual([{ type: 'pong', id: 'x' }]);
    expect(garbage).toHaveLength(1);
    expect(garbage[0]).toContain('parse-error');
  });

  it('decoder rejeita payload nao-objeto (array/primitivo) como garbage', () => {
    const received: Array<Record<string, unknown>> = [];
    const garbage: string[] = [];
    const feed = createSidecarLineDecoder(
      (m) => received.push(m),
      (l) => garbage.push(l),
    );
    feed(`${CURSOR_SIDECAR_RPC_PREFIX}[1,2]\n`);
    feed(`${CURSOR_SIDECAR_RPC_PREFIX}"texto"\n`);
    expect(received).toEqual([]);
    expect(garbage).toHaveLength(2);
  });
});
