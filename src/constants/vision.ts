export const VISION_TRANSCRIPTION_MARKER = '[Imagem transcrita pelo vision]:';

export interface SplitVisionTranscription {
  text: string;
  transcription: string | null;
}

export function splitVisionTranscription(content: string): SplitVisionTranscription {
  const idx = content.indexOf(VISION_TRANSCRIPTION_MARKER);
  if (idx === -1) return { text: content, transcription: null };
  const text = content.slice(0, idx).replace(/\s+$/, '');
  const transcription = content.slice(idx + VISION_TRANSCRIPTION_MARKER.length).replace(/^\s+/, '');
  return { text, transcription };
}
