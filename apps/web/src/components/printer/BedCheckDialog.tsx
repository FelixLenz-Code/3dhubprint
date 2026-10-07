import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Camera, RefreshCw, ScanSearch, Trash2 } from 'lucide-react';
import clsx from 'clsx';
import {
  BED_CHECK_METHODS,
  BED_CHECK_MODES,
  MAX_BED_REFERENCES,
  type BedCheckInfo,
  type BedCheckMethod,
  type BedCheckMode,
  type BedCheckResult,
  type BedCheckSettings,
  type BedRegion,
  type PrinterSummary,
} from '@printhub/shared';
import { api } from '../../lib/api';
import { confirm, useAction } from '../../lib/feedback';
import { Modal } from '../Modal';
import { Alert, Button, Field, Spinner } from '../ui';

const MODE_HINTS: Record<BedCheckMode, string> = {
  off: 'Das Druckbett wird nach jedem Druck von Hand als frei bestätigt.',
  confirm: 'Sieht die Kamera ein leeres Bett, fragt PrintHub nach (Banner und Push), ob das stimmt. Erst nach deiner Bestätigung startet der nächste Auftrag.',
  auto: 'Sieht die Kamera zweimal hintereinander ein eindeutig leeres Bett, wird es ohne Rückfrage freigegeben und der nächste Auftrag startet. Bei unsicherem Ergebnis wird nie freigegeben.',
};

const METHOD_HINTS: Record<BedCheckMethod, string> = {
  ai: 'Ein lokales Bildmodell vergleicht Form und Struktur jedes kleinen Bildausschnitts mit den Bildern des leeren Betts. Unempfindlich gegen Helligkeit und unterschiedliche Platten, erkennt auch flache Reste. Läuft auf dem Server, ohne Cloud (ca. 1 s pro Prüfung).',
  classic: 'Vergleicht Farbe und Helligkeit des Bereichs mit den Bildern des leeren Betts. Sehr schnell, reagiert aber auf Spiegelungen und andere Druckplatten leichter mit „belegt“.',
};

export const VERDICT_LABELS: Record<BedCheckResult['verdict'], string> = {
  clear: 'Bett frei',
  occupied: 'Bett belegt',
  uncertain: 'Unsicher',
  error: 'Fehler',
};

export function BedCheckDialog({ printer, open, onClose }: { printer: PrinterSummary; open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title={`Bett-Erkennung: ${printer.name}`} wide>
      {open && <BedCheckForm printer={printer} onDone={onClose} />}
    </Modal>
  );
}

function BedCheckForm({ printer, onDone }: { printer: PrinterSummary; onDone: () => void }) {
  const qc = useQueryClient();
  const key = ['bed-check', printer.id];
  const info = useQuery({ queryKey: key, queryFn: () => api<BedCheckInfo>(`/printers/${printer.id}/bed-check`) });
  const [draft, setDraft] = useState<BedCheckSettings>();
  const [result, setResult] = useState<BedCheckResult>();
  const [tick, setTick] = useState(() => Date.now());
  const { busy, run } = useAction();

  useEffect(() => {
    if (info.data && !draft) setDraft(info.data.settings);
  }, [info.data, draft]);

  if (info.error) return <Alert>{(info.error as Error).message}</Alert>;
  if (!info.data || !draft) return <Spinner />;
  if (printer.webcams.length === 0) {
    return <Alert tone="warning">Für diesen Drucker ist in Moonraker keine Kamera eingerichtet. Die Bett-Erkennung braucht ein Kamerabild, das das Druckbett zeigt.</Alert>;
  }

  const refs = info.data.references;
  const saved = info.data.settings;
  const dirty = JSON.stringify(saved) !== JSON.stringify(draft);
  const cam = printer.webcams[draft.webcam] ?? printer.webcams[0]!;
  const connected = printer.status.connection === 'connected';

  const save = () =>
    run(
      'save',
      async () => {
        qc.setQueryData(key, await api<BedCheckInfo>(`/printers/${printer.id}/bed-check`, { method: 'PUT', body: draft }));
        onDone();
      },
      'Bett-Erkennung gespeichert',
    );

  // References and tests use the saved settings, so save changes first.
  const saveQuietly = async () => {
    if (dirty) qc.setQueryData(key, await api<BedCheckInfo>(`/printers/${printer.id}/bed-check`, { method: 'PUT', body: draft }));
  };

  const addReference = async () => {
    if (
      !(await confirm({
        title: 'Leeres Druckbett speichern?',
        body: 'Das Bett muss jetzt ganz leer sein und so stehen wie nach einem Druck (z. B. nach vorne gefahren). Dieses Bild dient als Vergleich.',
        confirmLabel: 'Bild speichern',
      }))
    )
      return;
    await run(
      'ref',
      async () => {
        await saveQuietly();
        await api(`/printers/${printer.id}/bed-check/references`, { body: {} });
        await qc.invalidateQueries({ queryKey: key });
        setTick(Date.now());
      },
      'Bild des leeren Betts gespeichert',
    );
  };

  const removeReference = (id: number) =>
    run(`del-${id}`, async () => {
      await api(`/printers/${printer.id}/bed-check/references/${id}`, { method: 'DELETE' });
      await qc.invalidateQueries({ queryKey: key });
    });

  const test = () =>
    run('test', async () => {
      await saveQuietly();
      setResult(await api<BedCheckResult>(`/printers/${printer.id}/bed-check/run`, { body: {} }));
    });

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <div role="radiogroup" aria-label="Modus" className="inline-flex rounded-lg border border-border bg-surface p-0.5">
          {(Object.keys(BED_CHECK_MODES) as BedCheckMode[]).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={draft.mode === m}
              onClick={() => setDraft({ ...draft, mode: m })}
              className={clsx('min-h-9 rounded-md px-3 text-sm', draft.mode === m ? 'bg-surface-2 font-medium text-text' : 'text-text-2 hover:text-text')}
            >
              {BED_CHECK_MODES[m]}
            </button>
          ))}
        </div>
        <p className="text-sm text-text-2">{MODE_HINTS[draft.mode]}</p>
        {draft.mode === 'auto' && (
          <Alert tone="warning">
            Flache, kleine oder bettfarbene Reste kann die Kamera übersehen. Startet ein Druck auf einem belegten Bett, kann das Teil oder der Druckkopf Schaden nehmen. „Nachfragen“ ist die sichere Wahl.
          </Alert>
        )}
      </section>

      {draft.mode !== 'off' && (
        <>
          {printer.webcams.length > 1 && (
            <Field label="Kamera">
              <select
                value={draft.webcam}
                onChange={(e) => setDraft({ ...draft, webcam: Number(e.target.value) })}
                className="min-h-10 w-full rounded-lg border border-border bg-surface px-3 text-sm"
              >
                {printer.webcams.map((w, i) => (
                  <option key={i} value={i}>
                    {w.name}
                  </option>
                ))}
              </select>
            </Field>
          )}

          <section className="space-y-2">
            <div className="flex items-center gap-2">
              <h3 className="font-medium">1. Bereich des Druckbetts</h3>
              <Button variant="ghost" className="ml-auto min-h-8 px-2 text-xs" onClick={() => setTick(Date.now())} disabled={!connected}>
                <RefreshCw className="size-3.5" /> Neues Bild
              </Button>
            </div>
            <p className="text-sm text-text-2">Im Kamerabild einen Rahmen um die Druckfläche ziehen. Nur dieser Bereich wird verglichen; Druckkopf und Hintergrund möglichst weglassen.</p>
            {connected ? (
              <RegionEditor src={`${cam.snapshotUrl}?t=${tick}`} region={draft.region} onChange={(region) => setDraft({ ...draft, region })} />
            ) : (
              <Alert tone="warning">Drucker nicht verbunden, kein Kamerabild.</Alert>
            )}
          </section>

          <section className="space-y-2">
            <h3 className="font-medium">2. Bilder vom leeren Bett</h3>
            <p className="text-sm text-text-2">
              Mindestens ein Bild des leeren Betts, am besten in der Position nach einem Druck. Wechselst du zwischen Druckplatten, speichere für jede Platte ein eigenes Bild; verglichen wird mit den Bildern, die am besten passen. Jedes Mal, wenn jemand „Bett ist frei“ bestätigt (auch über „Trotzdem frei“), merkt sich PrintHub ein weiteres Bild (bis zu {MAX_BED_REFERENCES}); so wird die Erkennung mit der Zeit sicherer.
            </p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {refs.map((r) => (
                <figure key={r.id} className="group relative overflow-hidden rounded-lg border border-border">
                  <img src={`/api/printers/${printer.id}/bed-check/references/${r.id}`} alt="" className="aspect-video w-full bg-black object-cover" />
                  <figcaption className="px-2 py-1 text-xs text-text-3">
                    {new Date(r.createdAt).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} ·{' '}
                    {r.source === 'manual' ? 'gespeichert' : 'bestätigt'}
                  </figcaption>
                  <Button
                    variant="secondary"
                    className="absolute right-1 top-1 size-8 px-0"
                    onClick={() => removeReference(r.id)}
                    loading={busy === `del-${r.id}`}
                    aria-label="Bild löschen"
                    title="Bild löschen"
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </figure>
              ))}
            </div>
            <Button variant="secondary" onClick={addReference} loading={busy === 'ref'} disabled={!connected || !draft.region}>
              <Camera className="size-4" /> Leeres Bett jetzt speichern
            </Button>
            {!draft.region && <p className="text-xs text-text-3">Zuerst den Bereich markieren.</p>}
          </section>

          <section className="space-y-2">
            <h3 className="font-medium">3. Erkennung</h3>
            <div role="radiogroup" aria-label="Methode" className="inline-flex rounded-lg border border-border bg-surface p-0.5">
              {(Object.keys(BED_CHECK_METHODS) as BedCheckMethod[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={draft.method === m}
                  onClick={() => setDraft({ ...draft, method: m })}
                  className={clsx('min-h-9 rounded-md px-3 text-sm', draft.method === m ? 'bg-surface-2 font-medium text-text' : 'text-text-2 hover:text-text')}
                >
                  {BED_CHECK_METHODS[m]}
                </button>
              ))}
            </div>
            <p className="text-sm text-text-2">{METHOD_HINTS[draft.method]}</p>
            {draft.method === 'ai' && !info.data.aiAvailable && (
              <Alert tone="warning">Das KI-Modell ist auf dem Server nicht installiert; bis dahin läuft der Bildvergleich.</Alert>
            )}
          </section>

          <section className="space-y-2">
            <h3 className="font-medium">4. Empfindlichkeit und Test</h3>
            <label className="flex items-center gap-3">
              <span className="w-20 shrink-0 text-sm text-text-2">Grob</span>
              <input
                type="range"
                min={1}
                max={5}
                step={1}
                value={draft.sensitivity}
                onChange={(e) => setDraft({ ...draft, sensitivity: Number(e.target.value) })}
                className="min-w-0 flex-1 accent-[var(--accent)]"
                aria-label="Empfindlichkeit"
              />
              <span className="w-20 shrink-0 text-right text-sm text-text-2">Fein</span>
            </label>
            <p className="text-xs text-text-3">Fein erkennt auch kleine Teile, meldet aber öfter „belegt“, etwa bei Schatten oder Spiegelungen.</p>
            <Button variant="secondary" onClick={test} loading={busy === 'test'} disabled={!connected || !draft.region || refs.length === 0}>
              <ScanSearch className="size-4" /> Jetzt prüfen
            </Button>
            {result && <CheckResult printerId={printer.id} result={result} />}
          </section>
        </>
      )}

      <div className="flex justify-end gap-3 border-t border-border pt-4">
        <Button variant="ghost" onClick={onDone}>
          Abbrechen
        </Button>
        <Button onClick={save} loading={busy === 'save'} disabled={draft.mode !== 'off' && !draft.region}>
          Speichern
        </Button>
      </div>
    </div>
  );
}

/** Verdict with the camera image: bed region outlined, changed areas in red. */
export function CheckResult({ printerId, result }: { printerId: number; result: BedCheckResult }) {
  const tone = result.verdict === 'clear' ? 'text-good' : result.verdict === 'error' ? 'text-critical' : 'text-warning';
  return (
    <div className="space-y-2">
      <p className={clsx('text-sm font-medium', tone)}>
        {VERDICT_LABELS[result.verdict]}
        {result.error && `: ${result.error}`}
        {!!result.changed && (
          <span className="font-normal text-text-3">
            {' '}
            · {result.changed} {result.changed === 1 ? 'Bereich weicht' : 'Bereiche weichen'} vom leeren Bett ab (rot markiert)
          </span>
        )}
        {result.verdict === 'uncertain' && !result.changed && <span className="font-normal text-text-3"> · knapp an der Grenze</span>}
        {result.method && <span className="font-normal text-text-3"> · {BED_CHECK_METHODS[result.method]}</span>}
      </p>
      {result.verdict !== 'error' && (
        <img src={`/api/printers/${printerId}/bed-check/overlay?t=${result.at}`} alt="Kamerabild mit markierten Abweichungen" className="w-full max-w-xl rounded-lg bg-black" />
      )}
    </div>
  );
}

/** Camera image on which a rectangle is dragged; coordinates are fractions of the image. */
function RegionEditor({ src, region, onChange }: { src: string; region: BedRegion | null; onChange: (r: BedRegion | null) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const start = useRef<[number, number] | null>(null);
  const [live, setLive] = useState<BedRegion | null>(null);
  const [loaded, setLoaded] = useState(false);
  const shown = live ?? region;

  const pos = (e: ReactPointerEvent): [number, number] => {
    const r = box.current!.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
  };
  const rect = (a: [number, number], b: [number, number]): BedRegion => ({
    x0: Math.min(a[0], b[0]),
    y0: Math.min(a[1], b[1]),
    x1: Math.max(a[0], b[0]),
    y1: Math.max(a[1], b[1]),
  });

  return (
    <div
      ref={box}
      className="relative w-full max-w-xl cursor-crosshair touch-none select-none overflow-hidden rounded-lg bg-black"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = pos(e);
        setLive(null);
      }}
      onPointerMove={(e) => {
        if (start.current) setLive(rect(start.current, pos(e)));
      }}
      onPointerUp={(e) => {
        if (!start.current) return;
        const r = rect(start.current, pos(e));
        start.current = null;
        setLive(null);
        // A click without dragging keeps the old region.
        if (r.x1 - r.x0 >= 0.05 && r.y1 - r.y0 >= 0.05) onChange(r);
      }}
    >
      <img src={src} alt="Kamerabild" draggable={false} onLoad={() => setLoaded(true)} className="block w-full" />
      {!loaded && <Spinner className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2" />}
      {shown && (
        <div
          className="pointer-events-none absolute border-2 border-good bg-good/15"
          style={{ left: `${shown.x0 * 100}%`, top: `${shown.y0 * 100}%`, width: `${(shown.x1 - shown.x0) * 100}%`, height: `${(shown.y1 - shown.y0) * 100}%` }}
        />
      )}
      {!shown && loaded && (
        <div className="pointer-events-none absolute inset-x-0 bottom-2 text-center text-xs text-white/80">Rahmen um das Druckbett ziehen</div>
      )}
    </div>
  );
}
