import { useEffect, useMemo, useState } from 'react';
import type { DemoBox, DemoViewer } from './demo';
import { hexToRgb } from './viewer';

const COS = Math.cos(Math.PI / 6);
const SIN = Math.sin(Math.PI / 6);
const SCALE = 16;
const project = (x: number, y: number, z: number) => `${((x - y) * COS * SCALE).toFixed(1)},${(((x + y) * SIN - z) * SCALE).toFixed(1)}`;

function shade(hex: string, factor: number) {
  const { r, g, b } = hexToRgb(hex);
  return `rgb(${Math.round(r * factor)},${Math.round(g * factor)},${Math.round(b * factor)})`;
}

function faces(b: DemoBox) {
  const x1 = b.x + b.w, y1 = b.y + b.d, z1 = b.z + b.h;
  return {
    top: [project(b.x, b.y, z1), project(x1, b.y, z1), project(x1, y1, z1), project(b.x, y1, z1)].join(' '),
    right: [project(x1, b.y, b.z), project(x1, y1, b.z), project(x1, y1, z1), project(x1, b.y, z1)].join(' '),
    left: [project(b.x, y1, b.z), project(x1, y1, b.z), project(x1, y1, z1), project(b.x, y1, z1)].join(' '),
  };
}

/** Isometric stand-in for the Trimble Connect 3D viewer, shown only in demo mode. */
export default function DemoScene({ viewer }: { viewer: DemoViewer }) {
  const [, bump] = useState(0);
  useEffect(() => viewer.subscribe(() => bump((n) => n + 1)), [viewer]);

  // Painter's order: lower objects first, then back to front.
  const ordered = useMemo(
    () => [...viewer.boxes].sort((a, b) => a.z - b.z || (a.x + a.w + a.y + a.d) - (b.x + b.w + b.y + b.d)).map((box) => ({ box, f: faces(box) })),
    [viewer],
  );

  return (
    <svg className="demo-scene" viewBox="-420 -330 860 660" role="img" aria-label="Demomodell">
      {ordered.map(({ box, f }) => {
        const look = viewer.looks.get(box.id);
        if (look && !look.visible) return null;
        const color = look?.color || box.color;
        const selected = viewer.selected.has(box.id);
        return (
          <g key={box.id} opacity={look?.alpha ?? 1} className={selected ? 'demo-box selected' : 'demo-box'} onClick={(e) => viewer.toggle(box.id, e.shiftKey || e.ctrlKey || e.metaKey)}>
            <polygon points={f.left} fill={shade(color, 0.72)} />
            <polygon points={f.right} fill={shade(color, 0.86)} />
            <polygon points={f.top} fill={color} />
          </g>
        );
      })}
    </svg>
  );
}
