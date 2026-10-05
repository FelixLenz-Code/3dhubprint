import { useEffect, useState } from 'react';
import { CameraOff } from 'lucide-react';
import clsx from 'clsx';
import type { Webcam as WebcamInfo } from '@printhub/shared';

/**
 * mode="stream": live MJPEG (detail view). mode="snapshot": refreshes a still image
 * every few seconds, much lighter for dashboards with several printers.
 */
export function Webcam({
  cam,
  mode,
  intervalMs = 5000,
  className,
}: {
  cam: WebcamInfo;
  mode: 'stream' | 'snapshot';
  intervalMs?: number;
  className?: string;
}) {
  const [tick, setTick] = useState(() => Date.now());
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (mode !== 'snapshot') return;
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') setTick(Date.now());
    }, intervalMs);
    return () => clearInterval(id);
  }, [mode, intervalMs]);

  // Retry a failed camera after a while instead of giving up permanently.
  useEffect(() => {
    if (!failed) return;
    const id = setTimeout(() => {
      setFailed(false);
      setTick(Date.now());
    }, 15000);
    return () => clearTimeout(id);
  }, [failed]);

  const transform = [
    cam.flipH && 'scaleX(-1)',
    cam.flipV && 'scaleY(-1)',
    cam.rotation && `rotate(${cam.rotation}deg)`,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={clsx('relative aspect-video overflow-hidden bg-black', className)}>
      {failed ? (
        <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-white/60">
          <CameraOff className="size-6" />
          Kamera nicht erreichbar
        </div>
      ) : (
        <img
          src={mode === 'stream' ? `${cam.streamUrl}?t=${tick}` : `${cam.snapshotUrl}?t=${tick}`}
          alt={`Webcam ${cam.name}`}
          className="h-full w-full object-contain"
          style={transform ? { transform } : undefined}
          onError={() => setFailed(true)}
        />
      )}
    </div>
  );
}
