import { z } from 'zod';

export function parseGatewayToolArgsTransport(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export const gatewayToolArgsSchema = z.preprocess(
  parseGatewayToolArgsTransport,
  z.record(z.string(), z.unknown()),
);
