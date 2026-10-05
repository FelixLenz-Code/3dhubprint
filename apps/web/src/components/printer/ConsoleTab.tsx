import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Send } from 'lucide-react';
import clsx from 'clsx';
import type { ConsoleLine, PrinterSummary } from '@printhub/shared';
import { api } from '../../lib/api';
import { live, useLive } from '../../lib/live';
import { useAction } from '../../lib/feedback';
import { Button, Card, Input } from '../ui';

const EMPTY: ConsoleLine[] = [];
const HINTS = ['G28', 'M114', 'QUERY_ENDSTOPS', 'BED_MESH_CALIBRATE', 'STATUS', 'HELP'];

export function ConsoleTab({ printer, editable }: { printer: PrinterSummary; editable: boolean }) {
  const lines = useLive((s) => s.consoles[printer.id] ?? EMPTY);
  const [cmd, setCmd] = useState('');
  const [hist, setHist] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState(-1);
  const { busy, run } = useAction();
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    api<ConsoleLine[]>(`/printers/${printer.id}/console`)
      .then((l) => live.seedConsole(printer.id, l))
      .catch(() => {});
  }, [printer.id]);

  // Auto-scroll only while the user is at the bottom.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    const script = cmd.trim();
    if (!script) return;
    const ok = await run('send', () => api(`/printers/${printer.id}/gcode`, { body: { script } }));
    if (ok) {
      setHist((h) => [script, ...h.filter((x) => x !== script)].slice(0, 50));
      setHistIdx(-1);
      setCmd('');
    }
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowUp' && hist.length) {
      e.preventDefault();
      const i = Math.min(histIdx + 1, hist.length - 1);
      setHistIdx(i);
      setCmd(hist[i]!);
    } else if (e.key === 'ArrowDown' && histIdx >= 0) {
      e.preventDefault();
      const i = histIdx - 1;
      setHistIdx(i);
      setCmd(i >= 0 ? hist[i]! : '');
    }
  };

  return (
    <Card className="flex h-[min(70dvh,640px)] flex-col overflow-hidden">
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        className="min-h-0 flex-1 overflow-y-auto bg-surface-2/50 p-3 font-mono text-xs leading-relaxed"
        role="log"
        aria-label="Konsole"
      >
        {lines.length === 0 && <div className="text-text-3">Noch keine Ausgaben.</div>}
        {lines.map((l, i) => (
          <div key={i} className={clsx('whitespace-pre-wrap break-words', l.kind === 'command' ? 'text-accent' : l.text.startsWith('!!') ? 'text-critical' : 'text-text-2')}>
            <span className="mr-2 select-none text-text-3">{new Date(l.t).toLocaleTimeString('de-DE')}</span>
            {l.kind === 'command' && '> '}
            {l.text}
          </div>
        ))}
      </div>
      {editable && (
        <form onSubmit={send} className="space-y-2 border-t border-border p-3">
          <div className="flex gap-2">
            <Input
              value={cmd}
              onChange={(e) => setCmd(e.target.value)}
              onKeyDown={onKey}
              placeholder="G-Code oder Makro eingeben…"
              className="font-mono"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              aria-label="G-Code-Befehl"
              disabled={printer.status.connection !== 'connected'}
            />
            <Button type="submit" loading={busy === 'send'} disabled={!cmd.trim()} aria-label="Senden">
              <Send className="size-4" />
            </Button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {HINTS.map((h) => (
              <button key={h} type="button" onClick={() => setCmd(h)} className="rounded-md bg-surface-2 px-2 py-1 font-mono text-xs text-text-2 hover:text-text">
                {h}
              </button>
            ))}
          </div>
        </form>
      )}
    </Card>
  );
}
