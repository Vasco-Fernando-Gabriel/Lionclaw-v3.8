import { describe, expect, it } from 'vitest';
import { validateLionPassword } from '@/utils/auth-password';

describe('validateLionPassword', () => {
  it('espelha os limites de code points e bytes do servidor', () => {
    expect(validateLionPassword('123456789')).not.toBeNull();
    expect(validateLionPassword('1234567890')).toBeNull();
    expect(validateLionPassword('🔒'.repeat(128))).toBeNull();
    expect(validateLionPassword('🔒'.repeat(129))).not.toBeNull();
    expect(validateLionPassword('a'.repeat(128))).toBeNull();
    expect(validateLionPassword('a'.repeat(129))).not.toBeNull();
  });
});
