import { describe, expect, it } from 'vitest';
import { gatewayToolArgsSchema } from '../src/tool-args';

describe('gatewayToolArgsSchema', () => {
  it('preserva objetos nativos', () => {
    expect(gatewayToolArgsSchema.parse({ query: 'lion', limit: 5 })).toEqual({
      query: 'lion',
      limit: 5,
    });
  });

  it('aceita objeto JSON serializado uma vez pelo transporte', () => {
    expect(gatewayToolArgsSchema.parse('{"query":"lion","limit":5}')).toEqual({
      query: 'lion',
      limit: 5,
    });
  });

  it('continua rejeitando string invalida, array e null', () => {
    expect(gatewayToolArgsSchema.safeParse('{invalido').success).toBe(false);
    expect(gatewayToolArgsSchema.safeParse('[]').success).toBe(false);
    expect(gatewayToolArgsSchema.safeParse(null).success).toBe(false);
  });
});
