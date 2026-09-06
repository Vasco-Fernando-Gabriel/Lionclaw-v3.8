export const NODE_COLORS: Record<string, string> = {
  entity: '#CC5500',
  meeting: '#A0A0A0',
  decision: '#FF6B00',
  project: '#FFFFFF',
  reference: '#555555',
};

export const BG_COLOR = '#0A0A0A';
export const EDGE_COLOR = '#333333';
export const EDGE_HIGHLIGHT_COLOR = '#FF6B00';

export const LABEL_STYLE = {
  fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
  fontSize: 10,
  fill: '#FFFFFF',
};

export function nodeRadius(connections: number): number {
  return Math.max(6, Math.min(24, 6 + connections * 2));
}
