import { describe, it, expect } from 'vitest';
import { normalizeGoogleGenAiError } from '../google-genai-errors';

const SECRET_APIKEY = 'SECRET_APIKEY_AbCdEf_1234567890_xxxxxxxxx';
const SECRET_LOCATION = 'us-fake-region-9';
const SECRET_PROJECT = 'fake-google-project-abc123';
const SECRET_HEADER = 'Bearer Token-DO-NOT-LEAK';

function assertNoLeak(userMessage: string) {
  expect(userMessage).not.toContain(SECRET_APIKEY);
  expect(userMessage).not.toContain(SECRET_LOCATION);
  expect(userMessage).not.toContain(SECRET_PROJECT);
  expect(userMessage).not.toContain(SECRET_HEADER);
}

describe('normalizeGoogleGenAiError', () => {
  it('case 1: HTTP 401 -> API key rejected', () => {
    const r = normalizeGoogleGenAiError({ status: 401, message: `auth failed for ${SECRET_APIKEY}` });
    expect(r.userMessage).toBe('Google API key rejected. Check the key and API restrictions.');
    expect(r.status).toBe(401);
    assertNoLeak(r.userMessage);
  });

  it('case 1b: HTTP 403 -> API key rejected', () => {
    const r = normalizeGoogleGenAiError({ status: 403, message: 'forbidden' });
    expect(r.userMessage).toBe('Google API key rejected. Check the key and API restrictions.');
  });

  it('case 2: HTTP 404 -> model not available', () => {
    const r = normalizeGoogleGenAiError({
      status: 404,
      message: `model not found at ${SECRET_LOCATION}`,
    });
    expect(r.userMessage).toBe('This Gemini model is not available for this key, project, or location.');
    assertNoLeak(r.userMessage);
  });

  it('case 2b: "not found" textual hint without status -> model not available', () => {
    const r = normalizeGoogleGenAiError({ message: 'MODEL NOT FOUND' });
    expect(r.userMessage).toBe('This Gemini model is not available for this key, project, or location.');
  });

  it('case 3: HTTP 429 -> quota exceeded', () => {
    const r = normalizeGoogleGenAiError({
      status: 429,
      message: `quota exceeded for project ${SECRET_PROJECT}`,
    });
    expect(r.userMessage).toBe('Google quota exceeded for this project or key.');
    assertNoLeak(r.userMessage);
  });

  it('case 3b: RESOURCE_EXHAUSTED in message -> quota exceeded', () => {
    const r = normalizeGoogleGenAiError({ message: 'RESOURCE_EXHAUSTED please retry' });
    expect(r.userMessage).toBe('Google quota exceeded for this project or key.');
  });

  it('case 4: HTTP 400 + location hint -> region mismatch', () => {
    const r = normalizeGoogleGenAiError({
      status: 400,
      message: `Model gemini-3-flash-preview is not available in location ${SECRET_LOCATION}`,
    });
    expect(r.userMessage).toBe('Model is not available in this location. Try global.');
    assertNoLeak(r.userMessage);
  });

  it('case 5: HTTP 400 INVALID_ARGUMENT on tools -> schema rejected', () => {
    const r = normalizeGoogleGenAiError({
      status: 400,
      code: 'INVALID_ARGUMENT',
      message: `INVALID_ARGUMENT: bad tool schema parameters at projects/${SECRET_PROJECT}`,
    });
    expect(r.userMessage).toBe('Gemini rejected a tool schema. Check adapter schema conversion logs.');
    assertNoLeak(r.userMessage);
  });

  it('case 6a: finishReason SAFETY -> safety block', () => {
    const r = normalizeGoogleGenAiError({ finishReason: 'SAFETY', message: SECRET_APIKEY });
    expect(r.userMessage).toBe('Gemini blocked this response due to safety settings.');
    expect(r.code).toBe('SAFETY');
    assertNoLeak(r.userMessage);
  });

  it('case 6b: finishReason RECITATION -> policy block', () => {
    const r = normalizeGoogleGenAiError({ finishReason: 'RECITATION' });
    expect(r.userMessage).toBe('Gemini blocked this response due to policy settings.');
  });

  it('case 6b: finishReason PROHIBITED_CONTENT -> policy block', () => {
    const r = normalizeGoogleGenAiError({ finishReason: 'PROHIBITED_CONTENT' });
    expect(r.userMessage).toBe('Gemini blocked this response due to policy settings.');
  });

  it('case 6b: finishReason IMAGE_SAFETY -> policy block', () => {
    const r = normalizeGoogleGenAiError({ finishReason: 'IMAGE_SAFETY' });
    expect(r.userMessage).toBe('Gemini blocked this response due to policy settings.');
  });

  it('case 6c: finishReason MALFORMED_FUNCTION_CALL -> invalid tool call', () => {
    const r = normalizeGoogleGenAiError({ finishReason: 'MALFORMED_FUNCTION_CALL' });
    expect(r.userMessage).toBe('Gemini returned an invalid tool call.');
    expect(r.code).toBe('MALFORMED_FUNCTION_CALL');
  });

  it('case 6c: finishReason UNEXPECTED_TOOL_CALL -> invalid tool call', () => {
    const r = normalizeGoogleGenAiError({ finishReason: 'UNEXPECTED_TOOL_CALL' });
    expect(r.userMessage).toBe('Gemini returned an invalid tool call.');
  });

  it('promptFeedback.blockReason SAFETY -> safety block', () => {
    const r = normalizeGoogleGenAiError({ promptFeedback: { blockReason: 'SAFETY' } });
    expect(r.userMessage).toBe('Gemini blocked this response due to safety settings.');
  });

  it('case 7: default fallback shows shortened message, no key leakage', () => {
    const r = normalizeGoogleGenAiError({ message: 'something weird happened' });
    expect(r.userMessage).toBe('Vertex Gemini request failed: something weird happened');
  });

  it('case 7b: default fallback truncates long messages (rawMessage cap ~140 chars + prefix)', () => {
    const longMsg = 'a'.repeat(500);
    const r = normalizeGoogleGenAiError({ message: longMsg });
    expect(r.userMessage.length).toBeLessThanOrEqual(180);
    expect(r.userMessage.endsWith('...')).toBe(true);
  });

  it('case 7c: default fallback handles missing message', () => {
    const r = normalizeGoogleGenAiError({});
    expect(r.userMessage).toBe('Vertex Gemini request failed: unknown error');
  });

  it('case 7d: default fallback handles null and undefined', () => {
    expect(normalizeGoogleGenAiError(null).userMessage).toBe('Vertex Gemini request failed: unknown error');
    expect(normalizeGoogleGenAiError(undefined).userMessage).toBe('Vertex Gemini request failed: unknown error');
  });

  it('R4 deep audit: NEVER includes apiKey/location/projectId/headers in default fallback message', () => {
    const r = normalizeGoogleGenAiError({ message: `safe context here, no secret tokens` });
    expect(r.userMessage).toBe('Vertex Gemini request failed: safe context here, no secret tokens');
    assertNoLeak(r.userMessage);
  });

  it('nested { error: { code, status, message } } shape is parsed correctly', () => {
    const r = normalizeGoogleGenAiError({
      error: { code: 'INVALID_ARGUMENT', status: 400, message: 'bad tool schema' },
    });
    expect(r.userMessage).toBe('Gemini rejected a tool schema. Check adapter schema conversion logs.');
    expect(r.code).toBe('INVALID_ARGUMENT');
    expect(r.status).toBe(400);
  });

  it('response.candidates[0].finishReason is parsed correctly', () => {
    const r = normalizeGoogleGenAiError({
      response: { candidates: [{ finishReason: 'SAFETY' }] },
    });
    expect(r.userMessage).toBe('Gemini blocked this response due to safety settings.');
  });

  it('plain string error is shortened and passed through fallback', () => {
    const r = normalizeGoogleGenAiError('some plain error text');
    expect(r.userMessage).toBe('Vertex Gemini request failed: some plain error text');
  });
});
