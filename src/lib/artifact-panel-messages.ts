export const ARTIFACT_DECISIONS_TEXT_MAX_BYTES = 64 * 1024;
export const ARTIFACT_STATE_MAX_BYTES = 256 * 1024;
export const ARTIFACT_PANEL_MIN_WIDTH = 420;
export const ARTIFACT_CHAT_MIN_WIDTH = 480;
export const ARTIFACT_FORCED_FULL_BELOW = ARTIFACT_PANEL_MIN_WIDTH + ARTIFACT_CHAT_MIN_WIDTH;

export type ArtifactPanelMode = 'side' | 'full' | 'minimized';

export type InboundArtifactMessage =
  | { type: 'ready'; storageKey: string }
  | { type: 'decisions'; text: string }
  | { type: 'state:set'; storageKey: string; state: Record<string, unknown> };

export function sanitizeArtifactStorageKey(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const key = raw.toLowerCase().replace(/[^a-z0-9-]/g, '');
  return key.length > 0 && key.length <= 120 ? key : null;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

export function parseArtifactMessage(data: unknown): InboundArtifactMessage | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  switch (record.type) {
    case 'lionclaw:ready': {
      const storageKey = sanitizeArtifactStorageKey(record.storageKey);
      return storageKey ? { type: 'ready', storageKey } : null;
    }
    case 'lionclaw:decisions': {
      const text = record.text;
      if (typeof text !== 'string' || text.length === 0) return null;
      if (utf8Bytes(text) > ARTIFACT_DECISIONS_TEXT_MAX_BYTES) return null;
      return { type: 'decisions', text };
    }
    case 'lionclaw:state:set': {
      const storageKey = sanitizeArtifactStorageKey(record.storageKey);
      const state = record.state;
      if (!storageKey || !state || typeof state !== 'object' || Array.isArray(state)) return null;
      let json: string;
      try {
        json = JSON.stringify(state);
      } catch {
        return null;
      }
      if (utf8Bytes(json) > ARTIFACT_STATE_MAX_BYTES) return null;
      return { type: 'state:set', storageKey, state: state as Record<string, unknown> };
    }
    default:
      return null;
  }
}

export function htmlArtifactUrl(filePath: string): string {
  return `lionclaw-asset://host/html-artifact/${encodeURIComponent(filePath)}`;
}

export function effectiveArtifactMode(mode: ArtifactPanelMode, containerWidth: number | null): ArtifactPanelMode {
  if (mode === 'side' && containerWidth !== null && containerWidth < ARTIFACT_FORCED_FULL_BELOW) return 'full';
  return mode;
}
