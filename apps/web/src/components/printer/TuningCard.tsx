import { useEffect, useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import type { PrinterSummary } from '@printhub/shared';
import { api } from '../../lib/api';
import { useAction } from '../../lib/feedback';
import { Button } from '../ui';

/** Speed and flow multipliers: adjustable during a print. */
export function TuningControls({ printer }: { printer: PrinterSummary }) {
  const s = printer.status;
  const { run } = useAction();
  const speed = Math.round((s.speedFactor ?? 1) * 100);
  const flow = Math.round((s.extrudeFactor ?? 1) * 100);

  return (
    <div className="space-y-3">
      <Stepper
        label="Geschwindigkeit"
        value={speed}
        min={10}
        max={300}
        step={5}
        onChange={(v) => run('speed', () => api(`/printers/${printer.id}/speed-factor`, { body: { percent: v } }))}
      />
      <Stepper
        label="Fluss"
        value={flow}
        min={50}
        max={150}
        step={1}
        onChange={(v) => run('flow', () => api(`/printers/${printer.id}/flow-factor`, { body: { percent: v } }))}
      />
    </div>
  );
}

function Stepper({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  return (
    <div className="flex items-center gap-2">
      <span className="w-32 text-sm text-text-2">{label}</span>
      <Button variant="secondary" className="size-9 px-0" onClick={() => onChange(clamp(value - step))} aria-label={`${label} verringern`}>
        <Minus className="size-4" />
      </Button>
      <span className="tabular w-14 text-center text-sm font-semibold">{value} %</span>
      <Button variant="secondary" className="size-9 px-0" onClick={() => onChange(clamp(value + step))} aria-label={`${label} erhöhen`}>
        <Plus className="size-4" />
      </Button>
      {value !== 100 && (
        <Button variant="ghost" className="min-h-9 px-2 text-xs" onClick={() => onChange(100)}>
          100 %
        </Button>
      )}
    </div>
  );
}

export function FanSlider({ label, value, onCommit }: { label: string; value: number; onCommit: (v: number) => void }) {
  // Local value while dragging; only the released position is sent to the printer.
  const [local, setLocal] = useState(value);
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    if (!dragging) setLocal(value);
  }, [value, dragging]);

  const commit = () => {
    setDragging(false);
    if (local !== value) onCommit(local);
  };

  return (
    <label className="flex items-center gap-2">
      <span className="w-32 shrink-0 truncate text-sm text-text-2" title={label}>
        {label}
      </span>
      <input
        type="range"
        min={0}
        max={100}
        step={5}
        value={local}
        onChange={(e) => {
          setDragging(true);
          setLocal(Number(e.target.value));
        }}
        onPointerUp={commit}
        onKeyUp={commit}
        className="min-w-0 flex-1 accent-[var(--accent)]"
      />
      <span className="tabular w-12 text-right text-sm font-semibold">{local} %</span>
    </label>
  );
}
