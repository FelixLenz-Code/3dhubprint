import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import clsx from 'clsx';
import { AlertTriangle, Eye, Footprints, Minus, Plus, RotateCcw, RotateCw, Scan, Undo2 } from 'lucide-react';
import type { BufferGeometry } from 'three';
import type { ModelInfo, ModelTransform } from '@printhub/shared';
import { ApiError } from '../../lib/api';
import { findOverhangs } from '../../lib/overhang';
import { IDENTITY, axisAngle, cleanQuat, faceDown, layout, mulQuat, orient, rotatedSize, type Bed, type OrientedMesh, type PlateReport, OVERHANG_WARN_MM2 } from '../../lib/plate';
import { Alert, Button, Input, Spinner } from '../ui';
import type { PlateItem } from './ModelPicker';
import { PlateScene, buildGeometry, type SceneObject } from './plateScene';


const UNITS = [
  { label: 'mm', factor: 1 },
  { label: 'cm', factor: 10 },
  { label: 'Zoll', factor: 25.4 },
  { label: 'm', factor: 1000 },
] as const;

async function fetchMesh(id: number): Promise<Float32Array> {
  const res = await fetch(`/api/models/${id}/mesh`, { credentials: 'same-origin' });
  if (!res.ok) throw new ApiError(res.status, 'mesh', 'Modell konnte nicht geladen werden');
  return new Float32Array(await res.arrayBuffer());
}

const transformOf = (i: PlateItem): ModelTransform => i.transform ?? { rotation: IDENTITY, scale: 1 };

/**
 * 3D plate: shows the parts on the printer's bed, lets the user turn them (90° steps or
 * "this face down"), scale them (e.g. models drawn in inches) and, with automatic arranging
 * off, drag every copy to its place. Marks overhangs that probably need supports.
 */
export default function PlateEditor({
  items,
  onChange,
  models,
  bed,
  arrange,
  onArrangeChange,
  autoOrient,
  supportAngle,
  supportOn,
  onEnableSupport,
  onReport,
}: {
  items: PlateItem[];
  onChange: (items: PlateItem[]) => void;
  models: Map<number, ModelInfo>;
  bed: Bed;
  arrange: boolean;
  onArrangeChange: (arrange: boolean) => void;
  autoOrient: boolean;
  /** Slope (° from horizontal) below which Orca adds supports. */
  supportAngle: number;
  /** Supports enabled by the profile or the job's overrides. */
  supportOn: boolean;
  onEnableSupport: () => void;
  onReport: (r: PlateReport) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const scene = useRef<PlateScene | null>(null);
  // The first part starts selected so its tools are visible right away.
  const [selected, setSelected] = useState<number | null>(items.length ? 0 : null);
  const [tool, setTool] = useState<'move' | 'face'>('move');
  const [showOverhangs, setShowOverhangs] = useState(true);
  const latest = useRef({ items, onChange });
  latest.current = { items, onChange };

  const meshes = useQueries({
    queries: items.map((i) => ({ queryKey: ['mesh', i.modelId], queryFn: () => fetchMesh(i.modelId), staleTime: Infinity, gcTime: 5 * 60_000 })),
  });
  const loading = meshes.some((m) => m.isLoading);
  const failed = meshes.some((m) => m.isError);

  // Oriented geometry per item (copies share it).
  const oriented = useMemo(
    () =>
      items.map((it, idx): OrientedMesh | null => {
        const src = meshes[idx]?.data;
        const t = transformOf(it);
        return src ? orient(src, t.rotation, t.scale) : null;
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items.map((i) => `${i.modelId}:${JSON.stringify(transformOf(i).rotation)}:${transformOf(i).scale}`).join('|'), meshes.map((m) => m.dataUpdatedAt).join()],
  );

  const overhangs = useMemo(() => (autoOrient ? null : oriented.map((o) => (o ? findOverhangs(o.tris, supportAngle) : null))), [oriented, supportAngle, autoOrient]);


  const geometries = useMemo(() => {
    const list = oriented.map((o, idx) => (o ? buildGeometry(o.tris, showOverhangs ? (overhangs?.[idx]?.faces ?? null) : null) : null));
    return list;
  }, [oriented, overhangs, showOverhangs]);
  useEffect(() => () => geometries.forEach((g) => g?.dispose()), [geometries]);

  // Footprint per item: exact once the mesh is loaded, else from the stored dimensions.
  const sizes = items.map((it, idx) => {
    const o = oriented[idx];
    if (o) return o.size;
    const t = transformOf(it);
    return rotatedSize(models.get(it.modelId)?.dimensions ?? [10, 10, 10], t.rotation, t.scale);
  });

  // Positions: Orca's arrangement is unknown up front, so show a simple layout as a preview.
  const autoPositions = useMemo(() => {
    const fp = items.flatMap((it, idx) => Array.from({ length: it.copies }, () => [sizes[idx]![0], sizes[idx]![1]] as [number, number]));
    return layout(fp, bed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(sizes), items.map((i) => i.copies).join(), bed]);

  // Manual placement needs a position per copy: fill in missing ones from the layout.
  useEffect(() => {
    if (arrange) return;
    let k = 0;
    let changed = false;
    const next = items.map((it) => {
      const start = k;
      k += it.copies;
      const t = transformOf(it);
      const pos = (t.positions ?? []).slice(0, it.copies);
      if (pos.length === it.copies && t.positions?.length === it.copies) return it;
      changed = true;
      for (let c = pos.length; c < it.copies; c++) pos.push(autoPositions[start + c]!);
      return { ...it, transform: { ...t, positions: pos } };
    });
    if (changed) onChange(next);
  }, [arrange, items, autoPositions, onChange]);

  const placed = useMemo(() => {
    let k = 0;
    return items.flatMap((it, idx) =>
      Array.from({ length: it.copies }, (_, c) => {
        const pos = (!arrange && it.transform?.positions?.[c]) || autoPositions[k];
        k++;
        const [w, d, h] = sizes[idx]!;
        const [x, y] = pos ?? [bed.x0 + bed.width / 2, bed.y0 + bed.depth / 2];
        return { item: idx, copy: c, x, y, w, d, h };
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, arrange, autoPositions, JSON.stringify(sizes)]);

  const outside = placed.filter(
    (p) => p.x - p.w / 2 < bed.x0 - 0.01 || p.x + p.w / 2 > bed.x0 + bed.width + 0.01 || p.y - p.d / 2 < bed.y0 - 0.01 || p.y + p.d / 2 > bed.y0 + bed.depth + 0.01,
  );
  const tooTall = items.filter((_, idx) => sizes[idx]![2] > bed.height + 0.01);
  const overlapping = arrange
    ? []
    : placed.filter((a, i) => placed.some((b, j) => i !== j && Math.abs(a.x - b.x) < (a.w + b.w) / 2 && Math.abs(a.y - b.y) < (a.d + b.d) / 2));

  const blocking =
    tooTall.length > 0
      ? 'Ein Teil ist höher als der Bauraum'
      : !arrange && outside.length > 0
        ? 'Ein Teil liegt außerhalb des Druckbetts'
        : overlapping.length > 0
          ? 'Teile überlappen sich'
        : !arrange && items.some((i) => (i.transform?.positions?.length ?? 0) < i.copies)
          ? 'Teile werden noch platziert…'
          : null;
  const overhangKey = overhangs?.map((o) => (o ? Math.round(o.area) : 'x')).join() ?? 'auto';
  useEffect(() => {
    onReport({
      blocking,
      overhangs: overhangs && overhangs.every(Boolean) ? new Map(items.map((it, idx) => [it.modelId, overhangs[idx]!.area])) : null,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocking, overhangKey]);

  // --- scene lifecycle ------------------------------------------------------
  useEffect(() => {
    const s = new PlateScene(host.current!, {
      onSelect: setSelected,
      onMove: (item, copy, x, y) => {
        const { items: cur, onChange: change } = latest.current;
        change(
          cur.map((it, idx) => {
            if (idx !== item) return it;
            const t = transformOf(it);
            const positions = [...(t.positions ?? [])];
            positions[copy] = [x, y];
            return { ...it, transform: { ...t, positions } };
          }),
        );
      },
      onFacePick: (item, normal) => {
        const { items: cur, onChange: change } = latest.current;
        change(cur.map((it, idx) => (idx === item ? withRotation(it, cleanQuat(mulQuat(faceDown(normal), transformOf(it).rotation))) : it)));
        setTool('move');
        setSelected(item);
      },
    });
    scene.current = s;
    return () => {
      s.dispose();
      scene.current = null;
    };
  }, []);

  useEffect(() => {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark' || (!document.documentElement.getAttribute('data-theme') && matchMedia('(prefers-color-scheme: dark)').matches);
    scene.current?.setBed(bed, dark);
  }, [bed]);

  useEffect(() => {
    if (scene.current) scene.current.mode = tool === 'face' ? 'face' : arrange ? 'none' : 'move';
  }, [tool, arrange]);

  useEffect(() => {
    if (selected !== null && selected >= items.length) setSelected(null);
  }, [items.length, selected]);

  useEffect(() => {
    const bad = new Set(outside.map((p) => `${p.item}:${p.copy}`));
    const objs: SceneObject[] = placed
      .filter((p) => geometries[p.item])
      .map((p) => ({
        key: `${items[p.item]!.modelId}:${p.copy}`,
        item: p.item,
        copy: p.copy,
        geometry: geometries[p.item] as BufferGeometry,
        x: p.x,
        y: p.y,
        selected: p.item === selected,
        invalid: bad.has(`${p.item}:${p.copy}`) || sizes[p.item]![2] > bed.height,
      }));
    scene.current?.setObjects(objs);
  });

  // --- editing --------------------------------------------------------------
  /** Manual mode: put every copy back to the simple layout (e.g. after scaling). */
  const relayout = () => {
    let k = 0;
    onChange(
      items.map((it) => {
        const positions = autoPositions.slice(k, k + it.copies);
        k += it.copies;
        return { ...it, transform: { ...transformOf(it), positions } };
      }),
    );
  };

  const updateItem = (idx: number, patch: Partial<ModelTransform>) =>
    onChange(items.map((it, i) => (i === idx ? { ...it, transform: { ...transformOf(it), ...patch } } : it)));
  const setCopies = (idx: number, copies: number) =>
    onChange(items.map((it, i) => (i === idx ? { ...it, copies: Math.min(50, Math.max(1, copies)) } : it)));
  const rotate = (idx: number, axis: 'x' | 'y' | 'z', deg: number) =>
    updateItem(idx, { rotation: cleanQuat(mulQuat(axisAngle(axis, deg), transformOf(items[idx]!).rotation)) });

  const overhanging = items
    .map((it, idx) => ({ it, area: overhangs?.[idx]?.area ?? 0 }))
    .filter((o) => o.area >= OVERHANG_WARN_MM2);

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-3 lg:flex-row">
        <div className="min-w-0 flex-1 space-y-2">
          <div className="relative h-[22rem] overflow-hidden rounded-xl border border-border bg-surface-2 sm:h-[32rem]">
            <div ref={host} className="absolute inset-0" />
            {(loading || failed) && (
              <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-text-2">
                {failed ? 'Modell konnte nicht geladen werden' : <Spinner />}
              </div>
            )}
            <div className="absolute right-2 top-2 flex gap-1">
              <Button variant="secondary" className="size-8 min-h-8 px-0" onClick={() => scene.current?.resetView()} aria-label="Ansicht zurücksetzen" title="Ansicht zurücksetzen">
                <Scan className="size-4" />
              </Button>
              <Button variant="secondary" className="size-8 min-h-8 px-0" onClick={() => scene.current?.resetView(true)} aria-label="Von oben" title="Von oben">
                <Eye className="size-4" />
              </Button>
            </div>
            {tool === 'face' && (
              <div className="absolute inset-x-2 bottom-2 rounded-lg bg-surface/95 px-3 py-2 text-sm shadow">
                Tippe auf die Fläche, die auf dem Druckbett liegen soll.{' '}
                <button className="text-accent underline" onClick={() => setTool('move')}>
                  Abbrechen
                </button>
              </div>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-text-2">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={arrange} onChange={(e) => onArrangeChange(e.target.checked)} className="accent-[var(--accent)]" />
              Automatisch anordnen (OrcaSlicer)
            </label>
            {!arrange && (
              <button type="button" onClick={relayout} className="text-accent hover:underline">
                Neu anordnen
              </button>
            )}
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={showOverhangs} onChange={(e) => setShowOverhangs(e.target.checked)} className="accent-[var(--accent)]" />
              Überhänge rot markieren
            </label>
          </div>
          <p className="text-xs text-text-3">
            {arrange
              ? 'Die Anordnung ist eine Vorschau, OrcaSlicer verteilt die Teile beim Slicen. Zum freien Verschieben „Automatisch anordnen“ ausschalten.'
              : 'Teile mit Finger oder Maus verschieben. Ansicht drehen: auf freie Fläche ziehen, zoomen: Mausrad oder zwei Finger.'}
          </p>
        </div>

        <div className="space-y-2 lg:w-80 lg:shrink-0">
          <div className="text-sm font-medium">Teile</div>
          {items.map((it, idx) => {
            const m = models.get(it.modelId);
            const t = transformOf(it);
            const open = selected === idx;
            const unit = UNITS.find((u) => Math.abs(t.scale - u.factor) < 1e-9);
            const area = overhangs?.[idx]?.area;
            const tiny = m && Math.max(...m.dimensions) * t.scale < 5;
            return (
              <div
                key={it.modelId}
                className={clsx('rounded-xl border p-2.5 transition-colors', open ? 'border-accent bg-accent/5' : 'border-border')}
              >
                <button type="button" onClick={() => setSelected(open ? null : idx)} className="flex w-full items-center gap-2.5 text-left" aria-expanded={open}>
                  {m && <img src={m.thumbnailUrl} alt="" className="size-10 shrink-0 rounded-md bg-surface-2 object-contain" />}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{m?.name ?? 'Modell'}</div>
                    <div className="tabular text-xs text-text-3">{sizes[idx]!.map((v) => v.toFixed(1)).join(' × ')} mm</div>
                  </div>
                </button>

                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
                  <div className="flex items-center gap-1">
                    <Button variant="secondary" className="size-7 min-h-7 px-0" onClick={() => setCopies(idx, it.copies - 1)} aria-label="Weniger">
                      <Minus className="size-3" />
                    </Button>
                    <span className="tabular w-7 text-center font-semibold" aria-label="Stückzahl">
                      ×{it.copies}
                    </span>
                    <Button variant="secondary" className="size-7 min-h-7 px-0" onClick={() => setCopies(idx, it.copies + 1)} aria-label="Mehr">
                      <Plus className="size-3" />
                    </Button>
                  </div>
                  <label className="flex items-center gap-1 text-text-2">
                    Einheit
                    <select
                      value={unit?.label ?? 'custom'}
                      onChange={(e) => {
                        const u = UNITS.find((x) => x.label === e.target.value);
                        if (u) updateItem(idx, { scale: u.factor });
                      }}
                      className="min-h-7 rounded-md border border-border bg-surface px-1.5 text-xs text-text"
                      aria-label={`Einheit von ${m?.name ?? 'Modell'}`}
                    >
                      {UNITS.map((u) => (
                        <option key={u.label} value={u.label}>
                          {u.label}
                        </option>
                      ))}
                      {!unit && <option value="custom">{Math.round(t.scale * 1000) / 10} %</option>}
                    </select>
                  </label>
                </div>

                <div className="mt-1.5 text-xs">
                  {autoOrient ? null : area === undefined ? (
                    <span className="text-text-3">Überhänge werden geprüft…</span>
                  ) : area >= OVERHANG_WARN_MM2 ? (
                    <span className="font-medium text-critical">Überhang ≈ {Math.max(1, Math.round(area / 100))} cm², braucht Stützen</span>
                  ) : (
                    <span className="text-good">Keine kritischen Überhänge</span>
                  )}
                </div>
                {tiny && (
                  <div className="mt-1 text-xs text-warning">Sehr klein: vermutlich in Zoll oder cm gezeichnet. Einheit oben umstellen.</div>
                )}

                {open && (
                  <div className="mt-3 space-y-2 border-t border-border pt-3">
                    {autoOrient ? (
                      <p className="text-xs text-text-3">„Automatisch ausrichten“ ist an: OrcaSlicer wählt die Lage selbst.</p>
                    ) : (
                      <>
                        <Button variant={tool === 'face' ? 'primary' : 'secondary'} className="w-full" onClick={() => setTool(tool === 'face' ? 'move' : 'face')}>
                          <Footprints className="size-4" /> Fläche aufs Bett legen
                        </Button>
                        <div className="grid grid-cols-3 gap-1">
                          {(['x', 'y', 'z'] as const).map((axis) => (
                            <div key={axis} className="flex items-center justify-center gap-0.5 rounded-lg border border-border py-0.5">
                              <Button variant="ghost" className="size-8 min-h-8 px-0" onClick={() => rotate(idx, axis, -90)} aria-label={`${axis.toUpperCase()} −90°`} title="−90°">
                                <RotateCcw className="size-4" />
                              </Button>
                              <span className="w-3 text-center text-xs font-semibold uppercase text-text-2">{axis}</span>
                              <Button variant="ghost" className="size-8 min-h-8 px-0" onClick={() => rotate(idx, axis, 90)} aria-label={`${axis.toUpperCase()} +90°`} title="+90°">
                                <RotateCw className="size-4" />
                              </Button>
                            </div>
                          ))}
                        </div>
                        <div className="flex gap-1">
                          <Button variant="ghost" className="h-8 min-h-8 flex-1 px-1.5 text-xs" onClick={() => rotate(idx, 'z', -15)}>
                            Z −15°
                          </Button>
                          <Button variant="ghost" className="h-8 min-h-8 flex-1 px-1.5 text-xs" onClick={() => rotate(idx, 'z', 15)}>
                            Z +15°
                          </Button>
                          <Button
                            variant="ghost"
                            className="h-8 min-h-8 flex-1 px-1.5 text-xs"
                            onClick={() => updateItem(idx, { rotation: IDENTITY })}
                            disabled={t.rotation.join() === IDENTITY.join()}
                          >
                            <Undo2 className="size-3.5" /> Lage
                          </Button>
                        </div>
                      </>
                    )}
                    <label className="flex items-center gap-2 text-xs text-text-2">
                      Größe
                      <Input
                        type="number"
                        min={1}
                        max={100000}
                        step={1}
                        value={Math.round(t.scale * 1000) / 10}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          if (v > 0) updateItem(idx, { scale: v / 100 });
                        }}
                        className="h-8 min-h-8 w-24"
                        aria-label="Skalierung in Prozent"
                      />
                      %
                    </label>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {overhanging.length > 0 && !supportOn && (
        <Alert tone="warning">
          <div className="flex flex-wrap items-center gap-3">
            <span className="min-w-0 flex-1">
              <AlertTriangle className="mr-1 inline size-4" />
              {overhanging.map((o) => models.get(o.it.modelId)?.name).join(', ')}: Überhänge würden ohne Stützen in die Luft gedruckt (rot markiert, oft auf der
              Unterseite). Anders hinlegen oder Stützen aktivieren.
            </span>
            <Button variant="secondary" onClick={onEnableSupport}>
              Stützen aktivieren
            </Button>
          </div>
        </Alert>
      )}
      {overhanging.length > 0 && supportOn && (
        <Alert tone="good">Stützen sind aktiviert, die rot markierten Überhänge werden gestützt.</Alert>
      )}
      {outside.length > 0 && (
        <Alert tone="critical">
          <AlertTriangle className="mr-1 inline size-4" />
          {[...new Set(outside.map((p) => models.get(items[p.item]!.modelId)?.name))].join(', ')} {arrange ? 'passt nicht aufs Druckbett.' : 'liegt nicht vollständig auf dem Druckbett.'}
        </Alert>
      )}
      {tooTall.length > 0 && (
        <Alert tone="critical">
          {tooTall.map((it) => models.get(it.modelId)?.name).join(', ')} ist höher als der Bauraum ({bed.height} mm).
        </Alert>
      )}
      {overlapping.length > 0 && (
        <Alert tone="critical">
          <div className="flex flex-wrap items-center gap-3">
            <span className="min-w-0 flex-1">Teile überlappen sich auf dem Druckbett. Auseinanderschieben oder neu anordnen lassen.</span>
            <Button variant="secondary" onClick={relayout}>
              Neu anordnen
            </Button>
          </div>
        </Alert>
      )}
    </div>
  );
}

function withRotation(it: PlateItem, rotation: ModelTransform['rotation']): PlateItem {
  return { ...it, transform: { ...transformOf(it), rotation } };
}
