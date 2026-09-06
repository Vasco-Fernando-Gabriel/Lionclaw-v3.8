const UPSTREAM_PRODUCT_NAME = 'Open Design';
const LIONDESIGN_PRODUCT_NAME = 'LionDesign';

export function brandLionDesignText(value: string): string {
  return value.includes(UPSTREAM_PRODUCT_NAME)
    ? value.replaceAll(UPSTREAM_PRODUCT_NAME, LIONDESIGN_PRODUCT_NAME)
    : value;
}

export function brandLionDesignPayload(value: unknown): unknown {
  if (typeof value === 'string') return brandLionDesignText(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const source = value as Record<string, unknown>;
  const output = { ...source };
  for (const key of ['content', 'message', 'name', 'phaseName', 'stageName', 'description']) {
    if (typeof source[key] === 'string') output[key] = brandLionDesignText(source[key]);
  }
  return output;
}
