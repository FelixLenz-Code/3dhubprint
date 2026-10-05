import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Eye, Scan } from 'lucide-react';
import { ApiError } from '../../lib/api';
import { Button, Spinner } from '../ui';

interface Toolpaths {
  count: number;
  /** First segment of each layer. */
  layers: Uint32Array;
  positions: Float32Array;
  colors: Uint8Array;
  bounds: THREE.Box3;
  zOfLayer: number[];
}

/** Decodes the server's compact format (see encodeToolpaths in gcodePreview.ts). */
function decode(buf: ArrayBuffer): Toolpaths {
  const v = new DataView(buf);
  const count = v.getUint32(0, true);
  const nLayers = v.getUint32(4, true);
  const unit = v.getFloat32(8, true);
  const k = v.getUint32(12, true);
  const palette = new Uint8Array(buf, 16, k * 4);
  const layers = new Uint32Array(buf.slice(16 + k * 4, 16 + k * 4 + nLayers * 4));
  const head = 16 + k * 4 + nLayers * 4;
  const coords = new Int16Array(buf.slice(head, head + count * 12));
  const feats = new Uint8Array(buf, head + count * 12, count);
  const positions = new Float32Array(count * 6);
  for (let i = 0; i < positions.length; i++) positions[i] = coords[i]! * unit;
  const colors = new Uint8Array(count * 6);
  for (let s = 0; s < count; s++) {
    const p = Math.min(feats[s]!, k - 1) * 4;
    for (let e = 0; e < 2; e++) colors.set([palette[p]!, palette[p + 1]!, palette[p + 2]!], s * 6 + e * 3);
  }
  const bounds = new THREE.Box3().setFromArray(positions);
  const zOfLayer = [...layers].map((start) => positions[start * 6 + 2] ?? 0);
  return { count, layers, positions, colors, bounds, zOfLayer };
}

/** The sliced plate as real toolpaths: orbit, zoom and step through the layers. */
export default function ToolpathViewer({ url }: { url: string }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<{ setLayer: (n: number) => void; reset: (top?: boolean) => void } | null>(null);
  const data = useQuery({
    queryKey: ['toolpaths', url],
    queryFn: async () => {
      const res = await fetch(url, { credentials: 'same-origin' });
      if (!res.ok) throw new ApiError(res.status, 'paths', 'Druckbahnen konnten nicht geladen werden');
      return decode(await res.arrayBuffer());
    },
    staleTime: Infinity,
  });
  const paths = data.data;
  const [layer, setLayer] = useState(0);

  useEffect(() => {
    if (!paths || !host.current) return;
    const el = host.current;
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x1a1a19);
    el.appendChild(renderer.domElement);
    renderer.domElement.style.display = 'block';
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(35, 1, 1, 10000);
    camera.up.set(0, 0, 1);
    const controls = new OrbitControls(camera, renderer.domElement);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(paths.positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(paths.colors, 3, true));
    const lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true }));
    scene.add(lines);

    // Grid under the parts, a bit larger than their footprint.
    const b = paths.bounds;
    const size = b.getSize(new THREE.Vector3());
    const center = b.getCenter(new THREE.Vector3());
    const span = Math.max(size.x, size.y) + 40;
    const grid = new THREE.GridHelper(Math.ceil(span / 10) * 10, Math.ceil(span / 10), 0x3d3d3a, 0x2c2c2a);
    grid.rotation.x = Math.PI / 2;
    grid.position.set(center.x, center.y, -0.05);
    scene.add(grid);

    let frame = 0;
    const render = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => renderer.render(scene, camera));
    };
    controls.addEventListener('change', render);
    const reset = (top = false) => {
      const radius = Math.max(size.length() / 2, 10);
      const dist = (radius / Math.sin((camera.fov * Math.PI) / 360)) * 1.05;
      controls.target.set(center.x, center.y, top ? 0 : size.z / 3);
      const dir = top ? new THREE.Vector3(0, -0.001, 1) : new THREE.Vector3(-0.6, -1, 0.8);
      dir.normalize().multiplyScalar(dist);
      camera.position.copy(controls.target).add(dir);
      controls.update();
      render();
    };
    const fit = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      renderer.domElement.style.width = '100%';
      renderer.domElement.style.height = '100%';
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      render();
    };
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    fit();
    reset();
    view.current = {
      setLayer: (n) => {
        const end = n >= paths.layers.length ? paths.count : paths.layers[n]!;
        geo.setDrawRange(0, end * 2);
        render();
      },
      reset,
    };
    setLayer(paths.layers.length);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      controls.dispose();
      geo.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      view.current = null;
    };
  }, [paths]);

  useEffect(() => view.current?.setLayer(layer), [layer]);

  if (data.isError) return <p className="p-4 text-sm text-text-3">{(data.error as Error).message}</p>;
  const total = paths?.layers.length ?? 0;
  return (
    <div className="space-y-2">
      <div className="relative aspect-square w-full overflow-hidden rounded-xl bg-[#1a1a19] sm:aspect-[4/3]">
        <div ref={host} className="absolute inset-0" />
        {!paths && (
          <div className="absolute inset-0 flex items-center justify-center">
            <Spinner />
          </div>
        )}
        {paths && (
          <div className="absolute left-2 top-2 flex gap-1">
            <Button variant="secondary" className="size-8 min-h-8 px-0" onClick={() => view.current?.reset()} aria-label="Ansicht zurücksetzen" title="Ansicht zurücksetzen">
              <Scan className="size-4" />
            </Button>
            <Button variant="secondary" className="size-8 min-h-8 px-0" onClick={() => view.current?.reset(true)} aria-label="Von oben" title="Von oben">
              <Eye className="size-4" />
            </Button>
          </div>
        )}
      </div>
      {total > 1 && (
        <label className="flex items-center gap-3 text-sm text-text-2">
          <span className="shrink-0">Schicht</span>
          <input
            type="range"
            min={1}
            max={total}
            value={Math.max(1, layer)}
            onChange={(e) => setLayer(Number(e.target.value))}
            className="min-w-0 flex-1 accent-[var(--accent)]"
          />
          <span className="tabular w-32 shrink-0 text-right">
            {Math.max(1, layer)}/{total} · {(paths!.zOfLayer[Math.max(1, layer) - 1] ?? 0).toFixed(2).replace('.', ',')} mm
          </span>
        </label>
      )}
      <p className="text-xs text-text-3">Drehen: ziehen · Zoomen: Mausrad oder zwei Finger · Verschieben: rechte Maustaste oder zwei Finger</p>
    </div>
  );
}
