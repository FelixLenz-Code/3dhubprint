import { useEffect, useState } from 'react';
import { CameraOff } from 'lucide-react';
import clsx from 'clsx';
import type { Webcam as WebcamInfo } from '@printhub/shared';

/** A snapshot that takes longer than this is abandoned, so the image never stays stuck. */
const SNAPSHOT_TIMEOUT_MS = 10_000;

function useVisible() {
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible');
  useEffect(() => {
    const on = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  return visible;
}

/**
 * mode="stream": live MJPEG, paused while the tab is hidden. mode="snapshot": a still image
 * reloaded every few seconds, much lighter when many cameras are shown at once.
 */
export function Webcam({
  cam,
  mode,
  intervalMs = 3000,
  className,
}: {
  cam: WebcamInfo;
  mode: 'stream' | 'snapshot';
  intervalMs?: number;
  className?: string;
}) {
  const visible = useVisible();
  const [src, setSrc] = useState<string>();
  const [failed, setFailed] = useState(false);

  // Live stream: a fresh connection whenever the tab becomes visible again.
  useEffect(() => {
    if (mode !== 'stream' || failed) return;
    setSrc(visible ? `${cam.streamUrl}?t=${Date.now()}` : undefined);
  }, [mode, visible, failed, cam.streamUrl]);

  // Snapshots: load the next frame off-screen and swap it in when complete. The next request
  // starts only after the previous one finished or timed out, so slow cameras can't pile up.
  useEffect(() => {
    if (mode !== 'snapshot' || failed || !visible) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let errors = 0;
    const load = () => {
      const img = new Image();
      const timeout = setTimeout(() => done(false), SNAPSHOT_TIMEOUT_MS);
      const done = (ok: boolean) => {
        clearTimeout(timeout);
        img.onload = img.onerror = null;
        if (!ok) img.src = '';
        if (stopped) return;
        if (ok) {
          errors = 0;
          setSrc(img.src);
        } else if (++errors >= 3) {
          return setFailed(true);
        }
        timer = setTimeout(load, intervalMs);
      };
      img.onload = () => done(true);
      img.onerror = () => done(false);
      img.src = `${cam.snapshotUrl}?t=${Date.now()}`;
    };
    load();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [mode, failed, visible, intervalMs, cam.snapshotUrl]);

  // Retry a failed camera after a while instead of giving up permanently.
  useEffect(() => {
    if (!failed) return;
    const id = setTimeout(() => setFailed(false), 15000);
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
        src && (
          <img
            src={src}
            alt={`Webcam ${cam.name}`}
            className="h-full w-full object-contain"
            style={transform ? { transform } : undefined}
            onError={mode === 'stream' ? () => setFailed(true) : undefined}
          />
        )
      )}
    </div>
  );
}
