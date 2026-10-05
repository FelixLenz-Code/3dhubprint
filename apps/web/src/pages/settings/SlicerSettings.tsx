import { useEffect, useRef, useState, type DragEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, FileJson, Trash2, Upload, XCircle } from 'lucide-react';
import clsx from 'clsx';
import type { PrinterProfileAssignment, PrinterSummary, ProfileImportResult, ProfileKind, SlicerProfileInfo, SlicerStatus } from '@printhub/shared';
import { api, uploadWithProgress } from '../../lib/api';
import { confirm, toast, useAction } from '../../lib/feedback';
import { useLive } from '../../lib/live';
import { Alert, Badge, Button, Card, Spinner } from '../../components/ui';
import { BedTypeSelect, describeFilament, describeProcess } from '../../components/slicing/ProfileSelect';
import { effectiveBedType, isCompatible } from '../../lib/profiles';

const KIND_LABEL: Record<ProfileKind, string> = { machine: 'Drucker', process: 'Prozesse', filament: 'Filamente' };

export function SlicerSettings() {
  const status = useQuery({ queryKey: ['slicer-status'], queryFn: () => api<SlicerStatus>('/slicer/status') });
  const profiles = useQuery({ queryKey: ['profiles'], queryFn: () => api<SlicerProfileInfo[]>('/slicer/profiles') });
  const printers = useLive((s) => s.printers);

  return (
    <div className="space-y-6">
      <Card className="p-5">
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <h2 className="font-semibold">OrcaSlicer</h2>
          {status.data && <Badge tone={status.data.available ? 'good' : 'warning'}>{status.data.available ? `Version ${status.data.orcaVersion}` : 'nicht verfügbar'}</Badge>}
        </div>
        {status.data && !status.data.available && <p className="text-sm text-text-2">{status.data.reason}</p>}
        {status.data?.available && (
          <p className="text-sm text-text-2">{status.data.systemProfiles.toLocaleString('de-DE')} System-Profile verfügbar, um eigene Presets aufzulösen.</p>
        )}
      </Card>

      <ImportCard />

      <Card className="p-5">
        <h2 className="mb-4 font-semibold">Zuordnung zu Druckern</h2>
        {profiles.data && printers.length ? (
          <div className="divide-y divide-border">
            {printers.map((p) => (
              <AssignmentEditor key={p.id} printer={p} profiles={profiles.data} />
            ))}
          </div>
        ) : (
          <p className="text-sm text-text-3">Keine Drucker angelegt.</p>
        )}
      </Card>

      <Card className="p-5">
        <h2 className="mb-4 font-semibold">Profile</h2>
        {profiles.isLoading ? <Spinner /> : <ProfileList profiles={profiles.data ?? []} />}
      </Card>
    </div>
  );
}

function ImportCard() {
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ProfileImportResult>();

  const upload = async (files: FileList | File[]) => {
    const list = [...files];
    if (!list.length) return;
    const form = new FormData();
    for (const f of list) form.append('files', f, f.name);
    setBusy(true);
    try {
      setResult(await uploadWithProgress<ProfileImportResult>('/slicer/profiles/import', form, () => {}));
      await qc.invalidateQueries({ queryKey: ['profiles'] });
    } catch (err) {
      toast((err as Error).message, 'critical');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="space-y-4 p-5">
      <div>
        <h2 className="font-semibold">Profile importieren</h2>
        <p className="mt-1 text-sm text-text-2">
          In OrcaSlicer: <i>Datei → Exportieren → Preset-Bundle exportieren</i> (.orca_printer / .orca_filament), oder die JSON-Dateien aus dem
          Benutzer-Ordner (<code className="text-xs">OrcaSlicer/user/default/…</code>). Erneut importierte, geänderte Profile erhalten eine neue Version.
          Drucker-Adressen und API-Keys werden dabei entfernt.
        </p>
      </div>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e: DragEvent) => {
          e.preventDefault();
          setDrag(false);
          void upload(e.dataTransfer.files);
        }}
        className={clsx('flex flex-wrap items-center gap-3 rounded-xl border-2 border-dashed px-4 py-4', drag ? 'border-accent bg-accent/5' : 'border-border')}
      >
        <input
          ref={input}
          type="file"
          multiple
          accept=".json,.orca_printer,.orca_filament,.zip"
          className="hidden"
          onChange={(e) => {
            if (e.target.files) void upload(e.target.files);
            e.target.value = '';
          }}
        />
        <Button onClick={() => input.current?.click()} loading={busy}>
          <Upload className="size-4" /> Dateien wählen
        </Button>
        <span className="hidden text-sm text-text-3 sm:inline">oder hierher ziehen (mehrere Dateien möglich)</span>
      </div>
      {result && (
        <div className="space-y-1 text-sm">
          {result.imported.map((i) => (
            <div key={`${i.kind}:${i.name}`} className="flex items-center gap-2">
              <CheckCircle2 className="size-4 shrink-0 text-good" />
              <span className="truncate">
                {i.name} <span className="text-text-3">({KIND_LABEL[i.kind]}, v{i.version}{!i.updated && i.version > 1 ? ', unverändert' : i.updated ? ', aktualisiert' : ''})</span>
              </span>
            </div>
          ))}
          {result.skipped.map((s, i) => (
            <div key={i} className="flex items-start gap-2">
              <XCircle className="mt-0.5 size-4 shrink-0 text-critical" />
              <span className="min-w-0 break-words">
                <span className="font-medium">{s.file}</span>: {s.reason}
              </span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function ProfileList({ profiles }: { profiles: SlicerProfileInfo[] }) {
  const qc = useQueryClient();
  const { run } = useAction();
  if (!profiles.length) return <p className="text-sm text-text-3">Noch keine Profile importiert.</p>;

  const remove = async (p: SlicerProfileInfo) => {
    if (
      await confirm({
        title: 'Profil entfernen?',
        body: `„${p.name}“ wird nicht mehr angeboten und aus den Druckerzuordnungen entfernt. Bestehende Aufträge bleiben erhalten.`,
        confirmLabel: 'Entfernen',
        danger: true,
      })
    ) {
      if (await run('del', () => api(`/slicer/profiles/${p.kind}/${encodeURIComponent(p.name)}`, { method: 'DELETE' }))) {
        await qc.invalidateQueries({ queryKey: ['profiles'] });
        await qc.invalidateQueries({ queryKey: ['assignment'] });
      }
    }
  };

  return (
    <div className="space-y-5">
      {(['machine', 'process', 'filament'] as const).map((kind) => {
        const list = profiles.filter((p) => p.kind === kind);
        if (!list.length) return null;
        return (
          <div key={kind}>
            <h3 className="mb-2 text-sm font-medium text-text-2">{KIND_LABEL[kind]}</h3>
            <ul className="divide-y divide-border rounded-xl border border-border">
              {list.map((p) => (
                <li key={p.id} className="flex items-center gap-3 px-3 py-2">
                  <FileJson className="size-4 shrink-0 text-text-3" />
                  <div className="min-w-0 flex-1">
                    <div className="break-words text-sm font-medium">
                      {p.name} <span className="whitespace-nowrap font-normal text-text-3">v{p.version}</span>
                    </div>
                    <div className="text-xs leading-relaxed text-text-3">
                      {kind === 'machine'
                        ? `${String(p.summary.bedX)} × ${String(p.summary.bedY)} × ${String(p.summary.height)} mm · Düse ${String(p.summary.nozzle)} mm · Basis: ${p.systemPrinter}`
                        : kind === 'process'
                          ? describeProcess(p)
                          : describeFilament(p)}
                    </div>
                  </div>
                  <Button variant="ghost" onClick={() => remove(p)} aria-label={`${p.name} entfernen`}>
                    <Trash2 className="size-4" />
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function AssignmentEditor({ printer, profiles }: { printer: PrinterSummary; profiles: SlicerProfileInfo[] }) {
  const qc = useQueryClient();
  const current = useQuery({
    queryKey: ['assignment', printer.id],
    queryFn: () => api<PrinterProfileAssignment>(`/printers/${printer.id}/profiles`),
  });
  const [draft, setDraft] = useState<PrinterProfileAssignment>();
  const { busy, run } = useAction();
  useEffect(() => {
    if (current.data) setDraft(current.data);
  }, [current.data]);
  if (!draft) return <Spinner />;

  const machines = profiles.filter((p) => p.kind === 'machine');
  const machine = machines.find((m) => m.name === draft.machine);
  const toggle = (kind: 'process' | 'filament', name: string) =>
    setDraft({ ...draft, [kind]: draft[kind].includes(name) ? draft[kind].filter((n) => n !== name) : [...draft[kind], name] });
  const dirty = JSON.stringify(draft) !== JSON.stringify(current.data);

  const save = () =>
    run(
      'save',
      async () => {
        const res = await api<PrinterProfileAssignment>(`/printers/${printer.id}/profiles`, {
          method: 'PUT',
          body: { machine: draft.machine, process: draft.process, filament: draft.filament, bedType: draft.bedType },
        });
        qc.setQueryData(['assignment', printer.id], res);
        await qc.invalidateQueries({ queryKey: ['assignments'] });
      },
      'Zuordnung gespeichert',
    );

  return (
    <div className="space-y-3 py-4 first:pt-0 last:pb-0">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <span className="font-medium sm:w-40 sm:shrink-0 sm:truncate">{printer.name}</span>
        <select
          value={draft.machine ?? ''}
          onChange={(e) => setDraft({ ...draft, machine: e.target.value || null })}
          className="min-h-10 w-full min-w-0 rounded-lg border border-border bg-surface px-3 text-sm text-text sm:flex-1"
          aria-label={`Druckerprofil für ${printer.name}`}
        >
          <option value="">– kein Druckerprofil –</option>
          {machines.map((m) => (
            <option key={m.id} value={m.name}>
              {m.name}
            </option>
          ))}
        </select>
      </div>
      {draft.machine && (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <span className="text-sm text-text-2 sm:w-40 sm:shrink-0">Druckplatte</span>
          <BedTypeSelect
            value={effectiveBedType(draft, machine)}
            onChange={(bedType) => setDraft({ ...draft, bedType })}
            label={`Druckplatte für ${printer.name}`}
            className="sm:flex-1"
          />
        </div>
      )}
      {draft.machine && (
        <div className="grid gap-4 sm:grid-cols-2">
          {(['process', 'filament'] as const).map((kind) => {
            const list = profiles.filter((p) => p.kind === kind);
            return (
              <fieldset key={kind}>
                <legend className="mb-1 text-xs text-text-3">
                  {KIND_LABEL[kind]} {draft[kind].length === 0 && '(keine Auswahl = alle passenden)'}
                </legend>
                <div className="max-h-56 overflow-y-auto">
                  {list.map((p) => (
                    <label key={p.id} className="flex min-w-0 items-start gap-2 py-0.5 text-sm">
                      <input
                        type="checkbox"
                        checked={draft[kind].includes(p.name)}
                        onChange={() => toggle(kind, p.name)}
                        className="mt-1 shrink-0 accent-[var(--accent)]"
                      />
                      <span className={clsx('min-w-0 flex-1 break-words', !isCompatible(p, machine) && 'text-text-3')}>{p.name}</span>
                      {isCompatible(p, machine) ? (
                        <span className="shrink-0 text-xs text-good">passt</span>
                      ) : (
                        <span className="shrink-0 text-xs text-text-3">anderer Drucker</span>
                      )}
                    </label>
                  ))}
                  {!list.length && <span className="text-sm text-text-3">keine</span>}
                </div>
              </fieldset>
            );
          })}
        </div>
      )}
      {dirty && (
        <div className="flex gap-2">
          <Button onClick={save} loading={busy === 'save'}>
            Speichern
          </Button>
          <Button variant="ghost" onClick={() => setDraft(current.data)}>
            Verwerfen
          </Button>
        </div>
      )}
      {current.data?.machine && !dirty && <Alert tone="good">Bereit zum Slicen mit „{current.data.machine}“.</Alert>}
    </div>
  );
}
