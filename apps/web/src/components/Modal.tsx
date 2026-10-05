import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

/** Native <dialog> modal: full screen on phones, centered card on larger screens. */
export function Modal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className="m-0 h-dvh max-h-none w-full max-w-none bg-surface p-0 text-text backdrop:bg-black/60 sm:m-auto sm:h-fit sm:max-h-[90dvh] sm:w-[min(44rem,calc(100vw-2rem))] sm:rounded-2xl sm:border sm:border-border sm:shadow-2xl"
    >
      {open && (
        <div className="flex h-full max-h-[inherit] flex-col sm:h-auto sm:max-h-[90dvh]">
          <header className="flex items-center gap-3 border-b border-border px-5 py-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
            <h2 className="min-w-0 flex-1 truncate text-lg font-semibold">{title}</h2>
            <button onClick={onClose} className="rounded-lg p-2 text-text-2 hover:bg-surface-2 hover:text-text" aria-label="Schließen">
              <X className="size-5" />
            </button>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">{children}</div>
        </div>
      )}
    </dialog>
  );
}
