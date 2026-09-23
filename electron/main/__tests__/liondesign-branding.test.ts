import { describe, expect, it } from 'vitest';
import { brandLionDesignPayload, brandLionDesignText } from '../liondesign-branding';

describe('branding LionDesign', () => {
  it('troca apenas o nome visível e preserva ids, paths e canais internos', () => {
    expect(brandLionDesignText('Configure o Open Design')).toBe('Configure o LionDesign');
    expect(
      brandLionDesignPayload({
        content: 'Fase Open Design Studio',
        agentId: 'open-design-studio',
        path: '/run/open-design/artifact.html',
        channel: 'open-design:status',
      }),
    ).toEqual({
      content: 'Fase LionDesign Studio',
      agentId: 'open-design-studio',
      path: '/run/open-design/artifact.html',
      channel: 'open-design:status',
    });
  });
});
