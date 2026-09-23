const PASSWORD_MIN_CODE_POINTS = 10;
const PASSWORD_MAX_CODE_POINTS = 128;
const PASSWORD_MAX_BYTES = 512;

export function validateLionPassword(password: string): string | null {
  const codePoints = Array.from(password).length;
  const bytes = new TextEncoder().encode(password).byteLength;
  if (codePoints < PASSWORD_MIN_CODE_POINTS || codePoints > PASSWORD_MAX_CODE_POINTS || bytes > PASSWORD_MAX_BYTES) {
    return 'A senha precisa ter entre 10 e 128 caracteres.';
  }
  return null;
}
