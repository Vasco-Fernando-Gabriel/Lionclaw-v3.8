import type { GraphData } from '@/types';

export async function fetchGraphData(): Promise<GraphData> {
  return window.lionclaw.mgraph.graph();
}
