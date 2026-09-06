
import { describe, expect, it } from 'vitest';
import { normalizeBaseUrl } from '../adapters/base-url';

describe('adapter baseUrl normalization', () => {
  it('strips trailing /v1', () => {
    expect(normalizeBaseUrl('http://localhost:1234/v1')).toBe('http://localhost:1234');
  });
  it('strips trailing /v1/', () => {
    expect(normalizeBaseUrl('http://localhost:1234/v1/')).toBe('http://localhost:1234');
  });
  it('strips trailing slash without /v1', () => {
    expect(normalizeBaseUrl('http://localhost:11434/')).toBe('http://localhost:11434');
  });
  it('keeps the path otherwise', () => {
    expect(normalizeBaseUrl('http://localhost:1234')).toBe('http://localhost:1234');
  });
  it('handles empty / undefined', () => {
    expect(normalizeBaseUrl(undefined)).toBe('');
    expect(normalizeBaseUrl('')).toBe('');
    expect(normalizeBaseUrl('   ')).toBe('');
  });
  it('produces the same endpoint regardless of /v1 input', () => {
    const a = `${normalizeBaseUrl('http://x/v1')}/v1/chat/completions`;
    const b = `${normalizeBaseUrl('http://x')}/v1/chat/completions`;
    expect(a).toBe(b);
  });
});
