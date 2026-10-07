import { useMemo, useRef, useState, type DragEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, FileCode2, Folder, Play, Search, Trash2, Upload } from 'lucide-react';
import clsx from 'clsx';
import type { DirectoryListing, FileEntry, PrinterSummary } from '@printhub/shared';
import { api, uploadWithProgress } from '../../lib/api';
import { confirm, toast, useAction } from '../../lib/feedback';
import { confirmPrintStart } from '../../lib/printStart';
import { fileLabel, formatDuration, formatFilament, isActivePrint } from '../../lib/format';
import { formatBytes, formatDate, thumbUrl } from '../../lib/files';
import { Button, Card, Input, ProgressBar, Spinner } from '../ui';

export function FilesTab({ printer, editable }: { printer: PrinterSummary; editable: boolean }) {
  const [dir, setDir] = useState('');
  const [filter, setFilter] = useState('');
  const qc = useQueryClient();
  const queryKey = ['files', printer.id, dir];
  const files = useQuery({
    queryKey,
    queryFn: () => api<DirectoryListing>(`/printers/${printer.id}/files?path=${encodeURIComponent(dir)}`),
    enabled: printer.status.connection === 'connected' || printer.status.connection === 'klippy_not_ready',
  });
  const reload = () => qc.invalidateQueries({ queryKey: ['files', printer.id] });

  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return f ? files.data?.files.filter((x) => x.name.toLowerCase().includes(f)) : files.data?.files;
  }, [files.data, filter]);

  const crumbs = dir ? dir.split('/') : [];

  return (
    <div className="space-y-4">
      {editable && <UploadZone printer={printer} dir={dir} onDone={reload} />}

      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
          <nav className="flex min-w-0 flex-1 items-center gap-1 text-sm" aria-label="Ordner">
            <button onClick={() => setDir('')} className="rounded px-1.5 py-1 text-text-2 hover:bg-surface-2 hover:text-text">
              gcodes
            </button>
            {crumbs.map((c, i) => (
              <span key={i} className="flex min-w-0 items-center gap-1">
                <ChevronRight className="size-3.5 shrink-0 text-text-3" />
                <button
                  onClick={() => setDir(crumbs.slice(0, i + 1).join('/'))}
                  className="truncate rounded px-1.5 py-1 text-text-2 hover:bg-surface-2 hover:text-text"
                >
                  {c}
                </button>
              </span>
            ))}
          </nav>
          <div className="relative w-full sm:w-56">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-text-3" />
            <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Suchen…" className="pl-8" aria-label="Dateien durchsuchen" />
          </div>
        </div>

        {files.isLoading ? (
          <div className="flex justify-center p-8">
            <Spinner />
          </div>
        ) : files.error ? (
          <p className="p-5 text-sm text-critical">{(files.error as Error).message}</p>
        ) : (
          <ul className="divide-y divide-border">
            {files.data?.dirs.map((d) => (
              <li key={d.path}>
                <button onClick={() => setDir(d.path)} className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm hover:bg-surface-2">
                  <Folder className="size-5 text-text-3" />
                  <span className="font-medium">{d.name}</span>
                </button>
              </li>
            ))}
            {shown?.map((f) => <FileRow key={f.path} printer={printer} file={f} editable={editable} onChanged={reload} />)}
            {!files.data?.dirs.length && !shown?.length && <li className="p-5 text-sm text-text-3">Keine Dateien.</li>}
          </ul>
        )}
        {files.data?.diskFree !== undefined && (
          <div className="tabular border-t border-border px-4 py-2 text-xs text-text-3">
            {shown?.length ?? 0} Dateien · {formatBytes(files.data.diskFree)} frei von {formatBytes(files.data.diskTotal)}
          </div>
        )}
      </Card>
    </div>
  );
}

function FileRow({ printer, file, editable, onChanged }: { printer: PrinterSummary; file: FileEntry; editable: boolean; onChanged: () => void }) {
  const { busy, run } = useAction();
  const thumb = thumbUrl(printer.id, file.thumbnailPath);
  const blocked = isActivePrint(printer.status) || printer.status.connection !== 'connected';

  const print = async () => {
    if (
      await confirmPrintStart(printer, {
        title: 'Druck starten?',
        body: (
          <>
            „{fileLabel(file.name)}“ auf <b>{printer.name}</b> drucken. Ist das Druckbett frei und sauber?
          </>
        ),
      })
    )
      void run('print', () => api(`/printers/${printer.id}/files/print`, { body: { path: file.path } }), 'Druck gestartet');
  };

  const remove = async () => {
    if (await confirm({ title: 'Datei löschen?', body: `„${file.name}“ wird vom Drucker gelöscht.`, confirmLabel: 'Löschen', danger: true })) {
      const ok = await run('delete', () => api(`/printers/${printer.id}/files?path=${encodeURIComponent(file.path)}`, { method: 'DELETE' }));
      if (ok) onChanged();
    }
  };

  return (
    <li className="flex items-center gap-3 px-4 py-2.5">
      {thumb ? (
        <img src={thumb} alt="" loading="lazy" className="size-12 shrink-0 rounded-lg bg-surface-2 object-contain" />
      ) : (
        <div className="flex size-12 shrink-0 items-center justify-center rounded-lg bg-surface-2">
          <FileCode2 className="size-5 text-text-3" />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium" title={file.name}>
          {fileLabel(file.name)}
        </div>
        <div className="tabular truncate text-xs text-text-3">
          {formatDate(file.modified)} · {formatBytes(file.size)}
          {file.estimatedTime !== undefined && ` · ${formatDuration(file.estimatedTime)}`}
          {file.filamentTotal !== undefined && ` · ${formatFilament(file.filamentTotal)}`}
        </div>
      </div>
      {editable && (
        <div className="flex shrink-0 gap-1">
          <Button variant="secondary" onClick={print} disabled={blocked} loading={busy === 'print'} aria-label={`${file.name} drucken`} title={blocked ? 'Drucker ist beschäftigt oder nicht bereit' : 'Drucken'}>
            <Play className="size-4" /> <span className="hidden sm:inline">Drucken</span>
          </Button>
          <Button variant="ghost" onClick={remove} loading={busy === 'delete'} aria-label={`${file.name} löschen`}>
            <Trash2 className="size-4" />
          </Button>
        </div>
      )}
    </li>
  );
}

function UploadZone({ printer, dir, onDone }: { printer: PrinterSummary; dir: string; onDone: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const [progress, setProgress] = useState<{ name: string; value: number } | null>(null);
  const [printAfter, setPrintAfter] = useState(false);

  const upload = async (file: File) => {
    if (!/\.(gcode|gco|g|bgcode)$/i.test(file.name)) {
      toast('Nur G-Code-Dateien (.gcode) können hochgeladen werden. STL-Slicing folgt in Phase 3.', 'critical');
      return;
    }
    if (printAfter && isActivePrint(printer.status)) {
      toast('Es läuft bereits ein Druck; Datei wird nur hochgeladen.', 'critical');
    }
    const print =
      printAfter &&
      !isActivePrint(printer.status) &&
      (await confirmPrintStart(printer, {
        title: 'Nach dem Hochladen drucken?',
        body: <>„{fileLabel(file.name)}“ wird nach dem Hochladen gedruckt. Abbrechen lädt die Datei nur hoch.</>,
        onlyWithCamera: true,
      }));
    const form = new FormData();
    if (dir) form.append('path', dir);
    if (print) form.append('print', 'true');
    form.append('file', file, file.name);
    setProgress({ name: file.name, value: 0 });
    try {
      const res = await uploadWithProgress<{ printStarted: boolean }>(`/printers/${printer.id}/files/upload`, form, (v) =>
        setProgress({ name: file.name, value: v }),
      );
      toast(res.printStarted ? `${file.name} hochgeladen, Druck gestartet` : `${file.name} hochgeladen`);
      onDone();
    } catch (err) {
      toast((err as Error).message, 'critical');
    } finally {
      setProgress(null);
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    const f = e.dataTransfer.files[0];
    if (f) void upload(f);
  };

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={onDrop}
      className={clsx(
        'flex flex-wrap items-center gap-3 rounded-2xl border-2 border-dashed px-4 py-4 transition-colors',
        drag ? 'border-accent bg-accent/5' : 'border-border',
      )}
    >
      <input
        ref={input}
        type="file"
        accept=".gcode,.gco,.g,.bgcode"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void upload(f);
        }}
      />
      {progress ? (
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="tabular flex justify-between gap-2 text-sm">
            <span className="truncate">{progress.name}</span>
            <span className="text-text-2">{Math.round(progress.value * 100)} %</span>
          </div>
          <ProgressBar value={progress.value} />
        </div>
      ) : (
        <>
          <Button onClick={() => input.current?.click()}>
            <Upload className="size-4" /> G-Code hochladen
          </Button>
          <span className="hidden text-sm text-text-3 sm:inline">oder Datei hierher ziehen</span>
          <label className="ml-auto flex items-center gap-2 text-sm text-text-2">
            <input type="checkbox" checked={printAfter} onChange={(e) => setPrintAfter(e.target.checked)} className="accent-[var(--accent)]" />
            Danach drucken
          </label>
        </>
      )}
    </div>
  );
}
