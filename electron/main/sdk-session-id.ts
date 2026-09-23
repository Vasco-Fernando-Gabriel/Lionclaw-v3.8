import crypto from 'crypto';

function uuidFromHex(hex: string): string {
  const bytes = Buffer.from(hex.slice(0, 32), 'hex');
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const uuidHex = bytes.toString('hex');
  return [
    uuidHex.slice(0, 8),
    uuidHex.slice(8, 12),
    uuidHex.slice(12, 16),
    uuidHex.slice(16, 20),
    uuidHex.slice(20, 32),
  ].join('-');
}

export function makeScopedSdkSessionId(scope: string, sessionId: string): string {
  const hash = crypto.createHash('sha256').update(`${scope}:${sessionId}`).digest('hex');
  return uuidFromHex(hash);
}
