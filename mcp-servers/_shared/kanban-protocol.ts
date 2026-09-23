export const KANBAN_PROTOCOL_VERSION = 1;

export const KANBAN_EXTERNAL_CLIENT_IDS = ['lioncode'] as const;

export type KanbanExternalClientId = (typeof KANBAN_EXTERNAL_CLIENT_IDS)[number];

export function isKanbanExternalClientId(value: string): value is KanbanExternalClientId {
  return (KANBAN_EXTERNAL_CLIENT_IDS as readonly string[]).includes(value);
}
