export function shellEscapePOSIX(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function appleScriptEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function cmdQuote(value: string): string {
  if (/[\x00-\x1f]/.test(value)) {
    throw new Error('binary path contem caracteres de controle');
  }
  return `"${value.replace(/"/g, '""')}"`;
}
