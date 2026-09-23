import { useMemo } from 'react';

interface ExcalidrawViewerProps {
  data: Record<string, unknown>;
}

interface Element {
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  strokeColor?: string;
  backgroundColor?: string;
  fillStyle?: string;
  strokeWidth?: number;
  text?: string;
  fontSize?: number;
  roundness?: { type: number };
  points?: Array<[number, number]>;
  containerId?: string | null;
  endArrowhead?: string | null;
  startArrowhead?: string | null;
  [key: string]: unknown;
}

export default function ExcalidrawViewer({ data }: ExcalidrawViewerProps) {
  const elements = (data.elements || []) as Element[];

  const { svgContent, viewBox } = useMemo(() => {
    const drawableElements = elements.filter((el) => el.type !== 'text' || !el.containerId);
    if (drawableElements.length === 0) {
      return { svgContent: '', viewBox: '0 0 400 200' };
    }

    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const el of elements) {
      if (el.type === 'text' && el.containerId) continue;
      const x1 = el.x ?? 0;
      const y1 = el.y ?? 0;
      const x2 = x1 + (el.width ?? 0);
      const y2 = y1 + (el.height ?? 0);

      if (el.points && Array.isArray(el.points)) {
        for (const [px, py] of el.points) {
          minX = Math.min(minX, x1 + px);
          minY = Math.min(minY, y1 + py);
          maxX = Math.max(maxX, x1 + px);
          maxY = Math.max(maxY, y1 + py);
        }
      }

      minX = Math.min(minX, x1);
      minY = Math.min(minY, y1);
      maxX = Math.max(maxX, x2);
      maxY = Math.max(maxY, y2);
    }

    const padding = 40;
    minX -= padding;
    minY -= padding;
    maxX += padding;
    maxY += padding;

    const width = maxX - minX;
    const height = maxY - minY;

    const boundTexts = new Map<string, Element>();
    for (const el of elements) {
      if (el.type === 'text' && el.containerId) {
        boundTexts.set(el.containerId, el);
      }
    }

    const svgParts: string[] = [];
    for (const el of drawableElements) {
      const stroke = el.strokeColor || '#e4e4e7';
      const fill = el.backgroundColor && el.backgroundColor !== 'transparent' ? el.backgroundColor : 'none';
      const sw = el.strokeWidth ?? 2;
      const x = el.x ?? 0;
      const y = el.y ?? 0;
      const w = el.width ?? 0;
      const h = el.height ?? 0;
      const id = (el.id as string) || '';

      switch (el.type) {
        case 'rectangle': {
          const rx = el.roundness?.type === 3 ? Math.min(12, w * 0.1, h * 0.1) : 0;
          svgParts.push(
            `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" ` +
              `stroke="${stroke}" fill="${fill}" stroke-width="${sw}" />`,
          );
          const boundText = boundTexts.get(id);
          if (boundText) {
            const fs = boundText.fontSize || 16;
            svgParts.push(
              `<text x="${x + w / 2}" y="${y + h / 2}" ` +
                `font-size="${fs}" fill="${stroke}" text-anchor="middle" dominant-baseline="central" ` +
                `font-family="'Segoe UI', system-ui, sans-serif">${escapeXml(boundText.text || '')}</text>`,
            );
          }
          break;
        }

        case 'ellipse': {
          const cx = x + w / 2;
          const cy = y + h / 2;
          svgParts.push(
            `<ellipse cx="${cx}" cy="${cy}" rx="${w / 2}" ry="${h / 2}" ` +
              `stroke="${stroke}" fill="${fill}" stroke-width="${sw}" />`,
          );
          const boundText = boundTexts.get(id);
          if (boundText) {
            const fs = boundText.fontSize || 16;
            svgParts.push(
              `<text x="${cx}" y="${cy}" ` +
                `font-size="${fs}" fill="${stroke}" text-anchor="middle" dominant-baseline="central" ` +
                `font-family="'Segoe UI', system-ui, sans-serif">${escapeXml(boundText.text || '')}</text>`,
            );
          }
          break;
        }

        case 'diamond': {
          const cx = x + w / 2;
          const cy = y + h / 2;
          const points = `${cx},${y} ${x + w},${cy} ${cx},${y + h} ${x},${cy}`;
          svgParts.push(`<polygon points="${points}" stroke="${stroke}" fill="${fill}" stroke-width="${sw}" />`);
          const boundText = boundTexts.get(id);
          if (boundText) {
            const fs = boundText.fontSize || 16;
            svgParts.push(
              `<text x="${cx}" y="${cy}" ` +
                `font-size="${fs}" fill="${stroke}" text-anchor="middle" dominant-baseline="central" ` +
                `font-family="'Segoe UI', system-ui, sans-serif">${escapeXml(boundText.text || '')}</text>`,
            );
          }
          break;
        }

        case 'text': {
          const fs = el.fontSize || 20;
          const textLines = (el.text || '').split('\n');
          if (textLines.length === 1) {
            svgParts.push(
              `<text x="${x}" y="${y + fs}" font-size="${fs}" fill="${stroke}" ` +
                `font-family="'Segoe UI', system-ui, sans-serif">${escapeXml(el.text || '')}</text>`,
            );
          } else {
            const lineHeight = fs * 1.3;
            svgParts.push(
              `<text x="${x}" y="${y + fs}" font-size="${fs}" fill="${stroke}" font-family="'Segoe UI', system-ui, sans-serif">`,
            );
            for (let i = 0; i < textLines.length; i++) {
              svgParts.push(`<tspan x="${x}" dy="${i === 0 ? 0 : lineHeight}">${escapeXml(textLines[i])}</tspan>`);
            }
            svgParts.push('</text>');
          }
          break;
        }

        case 'arrow':
        case 'line': {
          if (el.points && el.points.length >= 2) {
            const pathParts = el.points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x + p[0]} ${y + p[1]}`);
            const markerId = el.type === 'arrow' && el.endArrowhead !== 'none' ? `url(#arrowhead-${id})` : '';
            svgParts.push(
              `<path d="${pathParts.join(' ')}" stroke="${stroke}" fill="none" stroke-width="${sw}" ` +
                `${markerId ? `marker-end="${markerId}"` : ''} />`,
            );
            if (markerId) {
              const lastPt = el.points[el.points.length - 1];
              const prevPt = el.points[el.points.length - 2];
              if (lastPt && prevPt) {
                svgParts.push(
                  `<defs><marker id="arrowhead-${id}" markerWidth="10" markerHeight="7" ` +
                    `refX="9" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="${stroke}" /></marker></defs>`,
                );
              }
            }
          }
          break;
        }

        case 'freedraw': {
          if (el.points && el.points.length >= 2) {
            const pathParts = el.points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x + p[0]} ${y + p[1]}`);
            svgParts.push(
              `<path d="${pathParts.join(' ')}" stroke="${stroke}" fill="none" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" />`,
            );
          }
          break;
        }
      }
    }

    return {
      svgContent: svgParts.join('\n'),
      viewBox: `${minX} ${minY} ${width} ${height}`,
    };
  }, [elements]);

  if (!svgContent) {
    return (
      <div className="flex items-center justify-center h-32 text-zinc-500 text-sm">Nenhum elemento para exibir</div>
    );
  }

  return (
    <div
      className="w-full bg-white flex items-center justify-center p-4 rounded-b-xl"
      style={{ minHeight: '200px', maxHeight: '500px' }}
    >
      <svg
        viewBox={viewBox}
        className="w-full h-full"
        style={{ maxHeight: '460px' }}
        xmlns="http://www.w3.org/2000/svg"
        dangerouslySetInnerHTML={{ __html: svgContent }}
      />
    </div>
  );
}

function escapeXml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
