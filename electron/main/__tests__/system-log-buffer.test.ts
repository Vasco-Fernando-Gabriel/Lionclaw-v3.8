import { describe, it, expect } from 'vitest';
import { systemLogStream, getSystemLogEntries, getSystemLogModules, subscribeSystemLog } from '../system-log-buffer';

function line(fields: Record<string, unknown>): string {
  return `${JSON.stringify(fields)}\n`;
}

describe('system-log-buffer', () => {
  it('parseia NDJSON do pino em SystemLogEntry (level label, module, msg, extra)', () => {
    systemLogStream.write(
      line({
        level: 40,
        time: 1700000000000,
        module: 't1-mcp',
        msg: 'servidor caiu',
        attempt: 2,
        pid: 1,
        hostname: 'x',
      }),
    );
    const [entry] = getSystemLogEntries({ module: 't1-mcp' });
    expect(entry.level).toBe(40);
    expect(entry.levelLabel).toBe('warn');
    expect(entry.time).toBe(1700000000000);
    expect(entry.msg).toBe('servidor caiu');
    expect(JSON.parse(entry.extra!)).toEqual({ attempt: 2 });
  });

  it('chunk com multiplas linhas gera multiplas entries, mais recentes primeiro', () => {
    systemLogStream.write(
      line({ level: 30, time: 1, module: 't2-boot', msg: 'primeiro' }) +
        line({ level: 30, time: 2, module: 't2-boot', msg: 'segundo' }),
    );
    const entries = getSystemLogEntries({ module: 't2-boot' });
    expect(entries.map((e) => e.msg)).toEqual(['segundo', 'primeiro']);
  });

  it('linha nao-JSON nao lanca e vira entry info com a linha crua', () => {
    expect(() => systemLogStream.write('linha quebrada sem json\n')).not.toThrow();
    const found = getSystemLogEntries({ search: 'linha quebrada sem json' });
    expect(found).toHaveLength(1);
    expect(found[0].levelLabel).toBe('info');
  });

  it('filtra por minLevel e search', () => {
    systemLogStream.write(
      line({ level: 20, time: 1, module: 't4-sched', msg: 'tick debug' }) +
        line({ level: 50, time: 2, module: 't4-sched', msg: 'cron falhou' }),
    );
    const errorsOnly = getSystemLogEntries({ module: 't4-sched', minLevel: 40 });
    expect(errorsOnly).toHaveLength(1);
    expect(errorsOnly[0].msg).toBe('cron falhou');
    expect(getSystemLogEntries({ module: 't4-sched', search: 'TICK' })).toHaveLength(1);
  });

  it('lista modulos distintos ordenados', () => {
    systemLogStream.write(
      line({ level: 30, time: 1, module: 't5-b', msg: 'x' }) +
        line({ level: 30, time: 2, module: 't5-a', msg: 'y' }) +
        line({ level: 30, time: 3, module: 't5-a', msg: 'z' }),
    );
    const modules = getSystemLogModules().filter((m) => m.startsWith('t5-'));
    expect(modules).toEqual(['t5-a', 't5-b']);
  });

  it('notifica subscribers e o unsubscribe para de notificar', () => {
    const seen: string[] = [];
    const unsub = subscribeSystemLog((e) => {
      if (e.module === 't6-sub') seen.push(e.msg ?? '');
    });
    systemLogStream.write(line({ level: 30, time: 1, module: 't6-sub', msg: 'um' }));
    unsub();
    systemLogStream.write(line({ level: 30, time: 2, module: 't6-sub', msg: 'dois' }));
    expect(seen).toEqual(['um']);
  });

  it('subscriber que lanca nao derruba o sink nem os demais subscribers', () => {
    const seen: string[] = [];
    const unsubBad = subscribeSystemLog(() => {
      throw new Error('subscriber quebrado');
    });
    const unsubGood = subscribeSystemLog((e) => {
      if (e.module === 't7-safe') seen.push(e.msg ?? '');
    });
    expect(() => systemLogStream.write(line({ level: 30, time: 1, module: 't7-safe', msg: 'ok' }))).not.toThrow();
    expect(seen).toEqual(['ok']);
    unsubBad();
    unsubGood();
  });

  it('trunca msg gigante e respeita o teto do ring buffer', () => {
    systemLogStream.write(line({ level: 30, time: 1, module: 't8-big', msg: 'a'.repeat(5000) }));
    const [entry] = getSystemLogEntries({ module: 't8-big' });
    expect(entry.msg!.length).toBeLessThan(2100);
    expect(entry.msg!.endsWith('[truncado]')).toBe(true);

    let chunk = '';
    for (let i = 0; i < 2100; i++) chunk += line({ level: 30, time: i, module: 't8-flood', msg: `m${i}` });
    systemLogStream.write(chunk);
    const flood = getSystemLogEntries({ module: 't8-flood', limit: 5000 });
    expect(flood.length).toBeLessThanOrEqual(2000);
    expect(flood[0].msg).toBe('m2099');
  });
});
