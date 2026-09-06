
export type VertexModelStage =
  | 'Public preview'
  | 'Preview'
  | 'Current'
  | 'Current legacy';

export interface VertexModelEntry {
  id: string;
  displayName: string;
  stage: VertexModelStage;
  contextWindow: number;
  outputCap: number;
}

export const VERTEX_MODEL_CATALOG: VertexModelEntry[] = [
  {
    id: 'gemini-3.1-pro-preview',
    displayName: 'Gemini 3.1 Pro Preview',
    stage: 'Public preview',
    contextWindow: 1048576,
    outputCap: 65536,
  },
  {
    id: 'gemini-3.1-pro-preview-customtools',
    displayName: 'Gemini 3.1 Pro Custom Tools Preview',
    stage: 'Public preview',
    contextWindow: 1048576,
    outputCap: 65536,
  },
  {
    id: 'gemini-3-pro-preview',
    displayName: 'Gemini 3 Pro Preview',
    stage: 'Preview',
    contextWindow: 1048576,
    outputCap: 65536,
  },
  {
    id: 'gemini-3-flash-preview',
    displayName: 'Gemini 3 Flash Preview',
    stage: 'Preview',
    contextWindow: 1048576,
    outputCap: 65536,
  },
  {
    id: 'gemini-3.1-flash-lite',
    displayName: 'Gemini 3.1 Flash-Lite',
    stage: 'Current',
    contextWindow: 1048576,
    outputCap: 65535,
  },
  {
    id: 'gemini-2.5-pro',
    displayName: 'Gemini 2.5 Pro',
    stage: 'Current',
    contextWindow: 1048576,
    outputCap: 65535,
  },
  {
    id: 'gemini-2.5-flash',
    displayName: 'Gemini 2.5 Flash',
    stage: 'Current',
    contextWindow: 1048576,
    outputCap: 65535,
  },
  {
    id: 'gemini-2.5-flash-lite',
    displayName: 'Gemini 2.5 Flash-Lite',
    stage: 'Current',
    contextWindow: 1048576,
    outputCap: 65535,
  },
  {
    id: 'gemini-2.0-flash',
    displayName: 'Gemini 2.0 Flash',
    stage: 'Current legacy',
    contextWindow: 1048576,
    outputCap: 8192,
  },
  {
    id: 'gemini-2.0-flash-lite',
    displayName: 'Gemini 2.0 Flash-Lite',
    stage: 'Current legacy',
    contextWindow: 1048576,
    outputCap: 8192,
  },
];

export const VERTEX_DEFAULT_MODEL = 'gemini-3-flash-preview';

export function findVertexModel(id: string): VertexModelEntry | undefined {
  return VERTEX_MODEL_CATALOG.find(m => m.id === id);
}
