import { useEffect, useRef } from 'react';
import Graph from 'graphology';
import Sigma from 'sigma';
import FA2Layout from 'graphology-layout-forceatlas2/worker';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import type { GraphNode, GraphEdge } from '@/types';
import { NODE_COLORS, EDGE_COLOR, EDGE_HIGHLIGHT_COLOR, BG_COLOR, LABEL_STYLE } from './graph-styles';

interface GraphCanvasProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  onNodeClick: (nodeId: string, nodeType: string) => void;
  activeNodeIds: Set<string> | null;
  zoomIn?: number;
  zoomOut?: number;
}

const DIM_NODE_COLOR = '#242424';
const DIM_EDGE_COLOR = '#161616';

function nodeSize(connections: number): number {
  return Math.max(2.5, Math.min(12, 2 + Math.sqrt(Math.max(0, connections)) * 1.3));
}

export function GraphCanvas({ nodes, edges, onNodeClick, activeNodeIds, zoomIn, zoomOut }: GraphCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sigmaRef = useRef<Sigma | null>(null);
  const graphRef = useRef<Graph | null>(null);

  const onNodeClickRef = useRef(onNodeClick);
  const activeNodeIdsRef = useRef(activeNodeIds);
  const hoveredNodeRef = useRef<string | null>(null);
  const hoveredNeighborsRef = useRef<Set<string> | null>(null);

  const prevZoomIn = useRef(zoomIn);
  const prevZoomOut = useRef(zoomOut);

  useEffect(() => { onNodeClickRef.current = onNodeClick; }, [onNodeClick]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || nodes.length === 0) return;

    const graph = new Graph();
    for (const n of nodes) {
      if (graph.hasNode(n.id)) continue;
      graph.addNode(n.id, {
        x: Math.random() * 1000,
        y: Math.random() * 1000,
        size: nodeSize(n.connections),
        label: n.title,
        color: NODE_COLORS[n.type] || '#888888',
        ntype: n.type,
      });
    }
    for (const e of edges) {
      if (!graph.hasNode(e.source) || !graph.hasNode(e.target)) continue;
      if (graph.hasEdge(e.source, e.target)) continue;
      graph.addEdge(e.source, e.target, { size: 0.6, color: EDGE_COLOR });
    }
    graphRef.current = graph;

    const renderer = new Sigma(graph, container, {
      renderLabels: true,
      labelColor: { color: LABEL_STYLE.fill },
      labelFont: LABEL_STYLE.fontFamily,
      labelSize: 11,
      labelWeight: '600',
      labelRenderedSizeThreshold: 9,
      labelDensity: 0.6,
      labelGridCellSize: 160,
      defaultEdgeColor: EDGE_COLOR,
      zIndex: true,
      defaultDrawNodeHover: (context, data, settings) => {
        const size = settings.labelSize;
        context.font = `${settings.labelWeight} ${size}px ${settings.labelFont}`;
        context.fillStyle = '#18181b';
        const PADDING = 3;
        if (typeof data.label === 'string' && data.label) {
          const textWidth = context.measureText(data.label).width;
          const boxWidth = Math.round(textWidth + 7);
          const boxHeight = Math.round(size + 2 * PADDING);
          const radius = Math.max(data.size, size / 2) + PADDING;
          const angle = Math.asin(boxHeight / 2 / radius);
          const dx = Math.sqrt(Math.abs(radius ** 2 - (boxHeight / 2) ** 2));
          context.beginPath();
          context.moveTo(data.x + dx, data.y + boxHeight / 2);
          context.lineTo(data.x + radius + boxWidth, data.y + boxHeight / 2);
          context.lineTo(data.x + radius + boxWidth, data.y - boxHeight / 2);
          context.lineTo(data.x + dx, data.y - boxHeight / 2);
          context.arc(data.x, data.y, radius, angle, -angle);
          context.closePath();
          context.fill();
        } else {
          context.beginPath();
          context.arc(data.x, data.y, data.size + PADDING, 0, Math.PI * 2);
          context.closePath();
          context.fill();
        }
        settings.defaultDrawNodeLabel(context, data, settings);
      },
      nodeReducer: (node, data) => {
        const active = activeNodeIdsRef.current;
        const hov = hoveredNodeRef.current;
        const neigh = hoveredNeighborsRef.current;
        let dim = false;
        if (active && !active.has(node)) dim = true;
        if (hov && node !== hov && !(neigh && neigh.has(node))) dim = true;
        if (dim) return { ...data, color: DIM_NODE_COLOR, label: '', zIndex: 0 };
        if (hov && (node === hov || (neigh && neigh.has(node)))) return { ...data, zIndex: 1 };
        return data;
      },
      edgeReducer: (edge, data) => {
        const g = graphRef.current;
        if (!g) return data;
        const active = activeNodeIdsRef.current;
        const hov = hoveredNodeRef.current;
        const [s, t] = g.extremities(edge);
        if (hov) {
          if (s === hov || t === hov) return { ...data, color: EDGE_HIGHLIGHT_COLOR, size: 2, zIndex: 1 };
          return { ...data, color: DIM_EDGE_COLOR };
        }
        if (active && !(active.has(s) && active.has(t))) return { ...data, color: DIM_EDGE_COLOR };
        return data;
      },
    });
    sigmaRef.current = renderer;

    renderer.on('clickNode', ({ node }) => {
      const ntype = graph.getNodeAttribute(node, 'ntype') as string;
      onNodeClickRef.current(node, ntype || '');
    });

    renderer.on('enterNode', ({ node }) => {
      hoveredNodeRef.current = node;
      hoveredNeighborsRef.current = new Set(graph.neighbors(node));
      renderer.refresh({ skipIndexation: true });
    });
    renderer.on('leaveNode', () => {
      hoveredNodeRef.current = null;
      hoveredNeighborsRef.current = null;
      renderer.refresh({ skipIndexation: true });
    });

    let draggedNode: string | null = null;
    let isDragging = false;
    const mouseCaptor = renderer.getMouseCaptor();

    renderer.on('downNode', (e) => {
      isDragging = true;
      draggedNode = e.node;
      graph.setNodeAttribute(draggedNode, 'highlighted', true);
    });
    const onMoveBody = (e: { x: number; y: number; preventSigmaDefault: () => void; original: Event }) => {
      if (!isDragging || !draggedNode) return;
      const pos = renderer.viewportToGraph(e);
      graph.setNodeAttribute(draggedNode, 'x', pos.x);
      graph.setNodeAttribute(draggedNode, 'y', pos.y);
      e.preventSigmaDefault();
      e.original.preventDefault();
      e.original.stopPropagation();
    };
    const onUp = () => {
      if (draggedNode) graph.removeNodeAttribute(draggedNode, 'highlighted');
      isDragging = false;
      draggedNode = null;
    };
    const onDown = () => {
      if (!renderer.getCustomBBox()) renderer.setCustomBBox(renderer.getBBox());
    };
    mouseCaptor.on('mousemovebody', onMoveBody);
    mouseCaptor.on('mouseup', onUp);
    mouseCaptor.on('mousedown', onDown);

    const settings = { ...forceAtlas2.inferSettings(graph), scalingRatio: 18, gravity: 0.4, barnesHutOptimize: true };
    const layout = new FA2Layout(graph, { settings });
    layout.start();
    const settleMs = Math.min(20000, 3000 + graph.order * 8);
    const stopTimer = window.setTimeout(() => {
      try { layout.stop(); } catch { /* worker ja morto */ }
    }, settleMs);

    return () => {
      window.clearTimeout(stopTimer);
      try { layout.kill(); } catch { /* */ }
      mouseCaptor.removeListener('mousemovebody', onMoveBody);
      mouseCaptor.removeListener('mouseup', onUp);
      mouseCaptor.removeListener('mousedown', onDown);
      renderer.kill();
      sigmaRef.current = null;
      graphRef.current = null;
      hoveredNodeRef.current = null;
      hoveredNeighborsRef.current = null;
    };
  }, [nodes, edges]);

  useEffect(() => {
    activeNodeIdsRef.current = activeNodeIds;
    sigmaRef.current?.refresh({ skipIndexation: true });
  }, [activeNodeIds]);

  useEffect(() => {
    if (zoomIn === undefined || zoomIn === prevZoomIn.current) return;
    prevZoomIn.current = zoomIn;
    sigmaRef.current?.getCamera().animatedZoom({ factor: 1.3, duration: 250 });
  }, [zoomIn]);

  useEffect(() => {
    if (zoomOut === undefined || zoomOut === prevZoomOut.current) return;
    prevZoomOut.current = zoomOut;
    sigmaRef.current?.getCamera().animatedUnzoom({ factor: 1.3, duration: 250 });
  }, [zoomOut]);

  return <div ref={containerRef} className="w-full h-full" style={{ background: BG_COLOR }} />;
}
