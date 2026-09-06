import { describe, it, expect } from 'vitest';
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import {
  PERM_BYPASS_NO_GUARD,
  PERM_DEFAULT_NO_BYPASS,
  PERM_DEFAULT_WITH_GUARD,
} from '../agent-runtime/permission-profiles';

describe('permission-profiles', () => {
  it('PERM_BYPASS_NO_GUARD has bypass mode and no guard', () => {
    expect(PERM_BYPASS_NO_GUARD.mode).toBe('bypassPermissions');
    expect(PERM_BYPASS_NO_GUARD.dangerouslySkipPermissions).toBe(true);
    expect(PERM_BYPASS_NO_GUARD.canUseTool).toBeUndefined();
  });

  it('PERM_DEFAULT_NO_BYPASS has default mode and no guard', () => {
    expect(PERM_DEFAULT_NO_BYPASS.mode).toBe('default');
    expect(PERM_DEFAULT_NO_BYPASS.dangerouslySkipPermissions).toBe(false);
    expect(PERM_DEFAULT_NO_BYPASS.canUseTool).toBeUndefined();
  });

  it('PERM_DEFAULT_WITH_GUARD wires the provided guard', () => {
    const mockGuard: CanUseTool = async () => ({
      behavior: 'allow',
      updatedInput: {},
    });
    const profile = PERM_DEFAULT_WITH_GUARD(mockGuard);
    expect(profile.mode).toBe('default');
    expect(profile.dangerouslySkipPermissions).toBe(false);
    expect(profile.canUseTool).toBe(mockGuard);
  });
});
