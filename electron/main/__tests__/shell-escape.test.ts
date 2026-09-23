import { describe, expect, it } from 'vitest';
import { appleScriptEscape, cmdQuote, shellEscapePOSIX } from '../shell-escape';

describe('shell escaping', () => {
  it('protege argumento POSIX com espacos, aspas simples e metacaracteres', () => {
    expect(shellEscapePOSIX("/tmp/a b/'$(touch nope)'")).toBe("'/tmp/a b/'\\''$(touch nope)'\\'''");
  });

  it('escapa barras e aspas em string AppleScript', () => {
    expect(appleScriptEscape('C:\\Codex "Build"')).toBe('C:\\\\Codex \\"Build\\"');
  });

  it('duplica aspas para cmd.exe e rejeita caracteres de controle', () => {
    expect(cmdQuote('C:\\Program Files\\Codex "next".cmd')).toBe('"C:\\Program Files\\Codex ""next"".cmd"');
    expect(() => cmdQuote('codex\r\ncalc')).toThrow(/caracteres de controle/);
  });
});
