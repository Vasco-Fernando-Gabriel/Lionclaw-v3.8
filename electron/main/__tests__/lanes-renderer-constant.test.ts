import { describe, expect, it } from 'vitest';
import { MAX_DESKTOP_LANES } from '../lanes';
import { MAX_DESKTOP_LANES as RENDERER_MAX_DESKTOP_LANES } from '../../../src/lib/lanes';

describe('RM9: teto de lanes do renderer acompanha o main', () => {
  it('src/lib/lanes.ts e electron/main/lanes.ts declaram o mesmo MAX_DESKTOP_LANES', () => {
    expect(RENDERER_MAX_DESKTOP_LANES).toBe(MAX_DESKTOP_LANES);
  });
});
