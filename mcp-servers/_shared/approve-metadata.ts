
export type NormalizedMetadata =
  | { ok: true; metadata: Record<string, unknown> | undefined }
  | { ok: false; error: string };

const METADATA_FORMAT_HINT =
  'metadata deve ser um objeto JSON (ou a string JSON equivalente). ' +
  'Exemplos: { "action": "lock-and-continue" } para o Design Lock do development-v2; ' +
  '{ "selectedCandidateId": "C1" } para a Triagem do architecture-review.';

export function normalizeApproveMetadata(
  metadata: Record<string, unknown> | string | undefined,
): NormalizedMetadata {
  if (metadata === undefined) return { ok: true, metadata: undefined };
  if (typeof metadata !== 'string') return { ok: true, metadata };

  const trimmed = metadata.trim();
  if (trimmed.length === 0) return { ok: true, metadata: undefined };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error:
        `metadata chegou como string mas nao e JSON valido (${msg}). ` +
        METADATA_FORMAT_HINT,
    };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      error:
        'metadata chegou como string JSON mas nao representa um objeto ' +
        `(recebi ${Array.isArray(parsed) ? 'array' : typeof parsed}). ` +
        METADATA_FORMAT_HINT,
    };
  }
  return { ok: true, metadata: parsed as Record<string, unknown> };
}
