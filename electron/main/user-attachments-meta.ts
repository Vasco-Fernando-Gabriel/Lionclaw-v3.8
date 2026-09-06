
import { insertMessage } from './db';
import type { ChatAttachmentMeta } from '../../src/types';

interface AttachmentLike {
  id: string;
  type: string;
  filename: string;
  mimeType: string;
  preview?: string;
}

const MAX_PREVIEW_LENGTH = 300_000;

export function buildUserAttachmentsMeta(
  attachments?: AttachmentLike[],
): ChatAttachmentMeta[] | undefined {
  const metas: ChatAttachmentMeta[] = [];
  for (const att of attachments ?? []) {
    if (att.type !== 'image') continue;
    const preview = att.preview;
    if (typeof preview !== 'string' || preview.length === 0) continue;
    if (preview.length > MAX_PREVIEW_LENGTH) continue;
    metas.push({
      id: att.id,
      type: 'image',
      filename: att.filename,
      mimeType: att.mimeType,
      preview,
    });
  }
  return metas.length > 0 ? metas : undefined;
}

export function persistUserChatMessage(
  sessionId: string,
  content: string,
  attachmentsMeta?: ChatAttachmentMeta[],
): number {
  if (!attachmentsMeta || attachmentsMeta.length === 0) {
    return insertMessage(sessionId, 'user', content);
  }
  return insertMessage(
    sessionId,
    'user',
    content,
    undefined,
    JSON.stringify({ attachmentsMeta }),
  );
}
