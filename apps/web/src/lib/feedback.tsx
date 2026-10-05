import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, X } from 'lucide-react';
import clsx from 'clsx';
import { Button } from '../components/ui';

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

interface Toast {
  id: number;
  tone: 'good' | 'critical';
  text: string;
}

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function toast(text: string, tone: Toast['tone'] = 'good') {
  const t = { id: nextId++, tone, text };
  toasts = [...toasts, t].slice(-4);
  emit();
  setTimeout(() => dismiss(t.id), tone === 'critical' ? 7000 : 3000);
}

function dismiss(id: number) {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

export function Toaster() {
  const list = useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => toasts,
  );
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-20 z-50 flex flex-col items-center gap-2 px-4 md:bottom-6" aria-live="polite">
      {list.map((t) => (
        <div
          key={t.id}
          className={clsx(
            'pointer-events-auto flex max-w-md items-start gap-2 rounded-xl border bg-surface px-4 py-3 text-sm shadow-lg',
            t.tone === 'critical' ? 'border-critical/40' : 'border-border',
          )}
        >
          {t.tone === 'critical' ? (
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-critical" />
          ) : (
            <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-good" />
          )}
          <span className="min-w-0 flex-1">{t.text}</span>
          <button onClick={() => dismiss(t.id)} className="text-text-3 hover:text-text" aria-label="Schließen">
            <X className="size-4" />
          </button>
        </div>
      ))}
    </div>
  );
}

/** Wraps an async action: tracks busy state, shows errors (and optionally success) as toasts. */
export function useAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (key: string, fn: () => Promise<unknown>, success?: string) => {
    setBusy(key);
    try {
      await fn();
      if (success) toast(success);
      return true;
    } catch (err) {
      toast((err as Error).message, 'critical');
      return false;
    } finally {
      setBusy(null);
    }
  };
  return { busy, run };
}

// ---------------------------------------------------------------------------
// Confirm dialog
// ---------------------------------------------------------------------------

interface ConfirmRequest {
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  resolve: (ok: boolean) => void;
}

let pending: ConfirmRequest | null = null;
const confirmListeners = new Set<() => void>();

export function confirm(opts: Omit<ConfirmRequest, 'resolve'>): Promise<boolean> {
  return new Promise((resolve) => {
    pending?.resolve(false);
    pending = { ...opts, resolve };
    confirmListeners.forEach((l) => l());
  });
}

export function ConfirmHost() {
  const req = useSyncExternalStore(
    (l) => (confirmListeners.add(l), () => confirmListeners.delete(l)),
    () => pending,
  );
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (req && !d.open) d.showModal();
    if (!req && d.open) d.close();
  }, [req]);

  const close = (ok: boolean) => {
    const r = pending;
    pending = null;
    confirmListeners.forEach((l) => l());
    r?.resolve(ok);
  };

  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        close(false);
      }}
      className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-2xl border border-border bg-surface p-0 text-text shadow-2xl backdrop:bg-black/50"
    >
      {req && (
        <div className="space-y-4 p-5">
          <h2 className="text-lg font-semibold">{req.title}</h2>
          {req.body && <div className="text-sm text-text-2">{req.body}</div>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => close(false)}>
              Abbrechen
            </Button>
            <Button variant={req.danger ? 'danger' : 'primary'} onClick={() => close(true)} autoFocus>
              {req.confirmLabel ?? 'Bestätigen'}
            </Button>
          </div>
        </div>
      )}
    </dialog>
  );
}
