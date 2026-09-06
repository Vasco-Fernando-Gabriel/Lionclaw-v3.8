
import crypto from 'crypto';

export interface TextProbe {
  sha256: string;
  bytes: number;
}

export function textProbe(text: string): TextProbe {
  const buf = Buffer.from(text, 'utf8');
  return {
    sha256: crypto.createHash('sha256').update(buf).digest('hex'),
    bytes: buf.length,
  };
}
