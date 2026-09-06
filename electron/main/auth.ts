import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { toDataURL } from 'qrcode';
import { getAuthRow, updateAuthSession, clearAuthSession, setTotpSecret } from './db';
import { createLogger } from './logger';

const logger = createLogger('auth');
const SALT_ROUNDS = 12;
const SESSION_DURATION_MS = 60 * 60 * 1000; // 1 hour default
const TOTP_PERIOD = 30; // seconds
const TOTP_DIGITS = 6;
const TOTP_WINDOW = 1; // allow +/- 1 step for clock skew


const BASE32_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_CHARS[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_CHARS[(value << (5 - bits)) & 31];
  }
  return output;
}

function base32Decode(encoded: string): Buffer {
  const cleaned = encoded.replace(/[=\s]/g, '').toUpperCase();
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of cleaned) {
    const idx = BASE32_CHARS.indexOf(char);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}


function generateTOTPCode(secret: string, timeStep: number): string {
  const key = base32Decode(secret);
  const timeBuffer = Buffer.alloc(8);
  timeBuffer.writeUInt32BE(0, 0);
  timeBuffer.writeUInt32BE(timeStep, 4);

  const hmac = crypto.createHmac('sha1', key);
  hmac.update(timeBuffer);
  const hash = hmac.digest();

  const offset = hash[hash.length - 1] & 0x0f;
  const code =
    ((hash[offset] & 0x7f) << 24) |
    ((hash[offset + 1] & 0xff) << 16) |
    ((hash[offset + 2] & 0xff) << 8) |
    (hash[offset + 3] & 0xff);

  return String(code % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

function verifyTOTPCode(secret: string, token: string): boolean {
  const now = Math.floor(Date.now() / 1000);
  const currentStep = Math.floor(now / TOTP_PERIOD);

  for (let i = -TOTP_WINDOW; i <= TOTP_WINDOW; i++) {
    const expected = generateTOTPCode(secret, currentStep + i);
    if (timingSafeEqual(token, expected)) {
      return true;
    }
  }
  return false;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}


export async function setupPassword(password: string): Promise<string> {
  const hash = await bcrypt.hash(password, SALT_ROUNDS);
  logger.info('Password hashed (caller will persist)');
  return hash;
}

export async function login(password: string, totpCode?: string): Promise<{ token: string }> {
  const auth = getAuthRow();
  if (!auth) throw new Error('Nenhuma conta configurada. Faca o setup primeiro.');

  const valid = await bcrypt.compare(password, auth.password_hash);
  if (!valid) throw new Error('Senha incorreta');

  if (auth.totp_secret) {
    if (!totpCode) {
      throw new Error('Codigo TOTP necessario. Por favor, insira o codigo do seu autenticador.');
    }
    if (!verifyTOTPCode(auth.totp_secret, totpCode)) {
      logger.warn('TOTP verification failed');
      throw new Error('Codigo TOTP invalido ou expirado.');
    }
    logger.info('TOTP verification successful');
  }

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS).toISOString();
  updateAuthSession(token, expiresAt);

  logger.info('Login successful');
  return { token };
}

export function logout(): void {
  clearAuthSession();
  logger.info('Logged out');
}

export function isAuthenticated(): boolean {
  const auth = getAuthRow();
  if (!auth?.session_token || !auth?.session_expires_at) return false;
  return new Date(auth.session_expires_at) > new Date();
}

export function isFirstRun(): boolean {
  const auth = getAuthRow();
  return !auth;
}

export async function enableTOTP(): Promise<{ secret: string; qrCode: string }> {
  const secretBytes = crypto.randomBytes(20);
  const secret = base32Encode(secretBytes);
  const otpauthUrl = `otpauth://totp/LionClaw:user?secret=${secret}&issuer=LionClaw&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD}`;
  const qrCode = await toDataURL(otpauthUrl);
  setTotpSecret(secret);
  logger.info('TOTP enabled and secret stored');
  return { secret, qrCode };
}

export function verifyTOTP(code: string): boolean {
  const auth = getAuthRow();
  if (!auth?.totp_secret) {
    logger.warn('TOTP verification attempted but no secret configured');
    return false;
  }
  const valid = verifyTOTPCode(auth.totp_secret, code);
  if (!valid) {
    logger.warn('TOTP code verification failed');
  }
  return valid;
}
