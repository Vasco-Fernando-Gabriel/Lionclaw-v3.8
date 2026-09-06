import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rotateLogFileIfNeededForBoot, rotateLogFileInSessionIfNeeded } from '../logger';

function tmpFile(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-logrot-'));
  return path.join(dir, name);
}

describe('rotateLogFileIfNeededForBoot', () => {
  it('acima do limite: move para .1 e libera o caminho original', () => {
    const file = tmpFile('lionclaw.log');
    fs.writeFileSync(file, 'x'.repeat(2048));
    expect(rotateLogFileIfNeededForBoot(file, 1024)).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.readFileSync(`${file}.1`, 'utf8')).toHaveLength(2048);
  });

  it('substitui a geracao .1 anterior (pior caso em disco ~2x o limite)', () => {
    const file = tmpFile('lionclaw.log');
    fs.writeFileSync(`${file}.1`, 'geracao-antiga');
    fs.writeFileSync(file, 'y'.repeat(2048));
    expect(rotateLogFileIfNeededForBoot(file, 1024)).toBe(true);
    expect(fs.readFileSync(`${file}.1`, 'utf8')).toBe('y'.repeat(2048));
  });

  it('no limite ou abaixo: nao mexe no arquivo', () => {
    const file = tmpFile('lionclaw.log');
    fs.writeFileSync(file, 'z'.repeat(1024));
    expect(rotateLogFileIfNeededForBoot(file, 1024)).toBe(false);
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.existsSync(`${file}.1`)).toBe(false);
  });

  it('arquivo inexistente: no-op sem lancar', () => {
    const file = tmpFile('nao-existe.log');
    expect(rotateLogFileIfNeededForBoot(file, 1024)).toBe(false);
  });
});

describe('rotateLogFileInSessionIfNeeded', () => {
  it('acima do limite: copia para .1 e trunca o arquivo vivo (sem rename)', async () => {
    const file = tmpFile('lionclaw.log');
    fs.writeFileSync(file, 'x'.repeat(2048));
    await expect(rotateLogFileInSessionIfNeeded(file, 1024)).resolves.toBe(true);
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.statSync(file).size).toBe(0);
    expect(fs.readFileSync(`${file}.1`, 'utf8')).toHaveLength(2048);
  });

  it('rotaciona mesmo com o arquivo aberto por outro handle (cenario EPERM do rename no Windows)', async () => {
    const file = tmpFile('lionclaw.log');
    fs.writeFileSync(file, 'w'.repeat(2048));
    const fd = fs.openSync(file, 'a');
    try {
      await expect(rotateLogFileInSessionIfNeeded(file, 1024)).resolves.toBe(true);
      fs.writeSync(fd, 'depois');
      expect(fs.readFileSync(file, 'utf8')).toBe('depois');
      expect(fs.readFileSync(`${file}.1`, 'utf8')).toHaveLength(2048);
    } finally {
      fs.closeSync(fd);
    }
  });

  it('substitui a geracao .1 anterior', async () => {
    const file = tmpFile('lionclaw.log');
    fs.writeFileSync(`${file}.1`, 'geracao-antiga');
    fs.writeFileSync(file, 'y'.repeat(2048));
    await expect(rotateLogFileInSessionIfNeeded(file, 1024)).resolves.toBe(true);
    expect(fs.readFileSync(`${file}.1`, 'utf8')).toBe('y'.repeat(2048));
  });

  it('no limite ou abaixo: nao mexe no arquivo', async () => {
    const file = tmpFile('lionclaw.log');
    fs.writeFileSync(file, 'z'.repeat(1024));
    await expect(rotateLogFileInSessionIfNeeded(file, 1024)).resolves.toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe('z'.repeat(1024));
    expect(fs.existsSync(`${file}.1`)).toBe(false);
  });

  it('arquivo inexistente: no-op sem lancar', async () => {
    const file = tmpFile('nao-existe.log');
    await expect(rotateLogFileInSessionIfNeeded(file, 1024)).resolves.toBe(false);
  });
});
