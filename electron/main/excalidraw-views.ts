
interface ExcalidrawViewData {
  elements: unknown[];
  appState: Record<string, unknown>;
  title: string;
  createdAt: number;
}

const views = new Map<string, ExcalidrawViewData>();

export function storeExcalidrawView(id: string, data: Omit<ExcalidrawViewData, 'createdAt'>): void {
  views.set(id, { ...data, createdAt: Date.now() });

  if (views.size > 30) {
    const sorted = [...views.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
    for (const [key] of sorted.slice(0, views.size - 30)) {
      views.delete(key);
    }
  }
}

export function getExcalidrawView(id: string): ExcalidrawViewData | undefined {
  return views.get(id);
}
