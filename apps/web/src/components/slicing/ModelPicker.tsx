import { useRef, useState, type DragEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Box, Check, Minus, Plus, Trash2, Upload, X } from 'lucide-react';
import clsx from 'clsx';
import type { ModelInfo } from '@printhub/shared';
import { api, uploadWithProgress } from '../../lib/api';
import { confirm, toast, useAction } from '../../lib/feedback';
import { formatDims } from '../../lib/jobs';
import { formatBytes } from '../../lib/files';
import { Button, Input, ProgressBar, Spinner } from '../ui';

export interface PlateItem {
  modelId: number;
  copies: number;
}

const MODEL_EXT = /\.(stl|3mf|obj)$/i;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Several models with copies for one plate: upload (multiple files) or pick from the library. */
export function ModelPicker({
  value,
  onChange,
  library = 'open',
}: {
  value: PlateItem[];
  onChange: (v: PlateItem[]) => void;
  /** "collapsed": the library is behind a link (compact dialogs). */
  library?: 'open' | 'collapsed';
}) {
  const [libraryOpen, setLibraryOpen] = useState(library === 'open');
  const qc = useQueryClient();
  const models = useQuery({ queryKey: ['models'], queryFn: () => api<ModelInfo[]>('/models') });
  const byId = new Map(models.data?.map((m) => [m.id, m]));
  const selected = value.filter((v) => byId.has(v.modelId));

  const add = (ids: number[]) => {
    const next = [...value];
    for (const id of ids) if (!next.some((v) => v.modelId === id)) next.push({ modelId: id, copies: 1 });
    onChange(next);
  };
  const toggle = (id: number) =>
    value.some((v) => v.modelId === id) ? onChange(value.filter((v) => v.modelId !== id)) : add([id]);
  const setCopies = (id: number, copies: number) =>
    onChange(value.map((v) => (v.modelId === id ? { ...v, copies: Math.min(50, Math.max(1, copies)) } : v)));

  return (
    <div className="space-y-4">
      <UploadZone
        onUploaded={(list) => {
          qc.setQueryData<ModelInfo[]>(['models'], (old) => [...list, ...(old ?? []).filter((m) => !list.some((x) => x.id === m.id))]);
          add(list.map((m) => m.id));
        }}
      />

      {selected.length > 0 && (
        <div className="space-y-2">
          <div className="text-sm text-text-2">
            Auf dem Druckbett: {plural(selected.length, 'Modell', 'Modelle')}, {plural(selected.reduce((n, v) => n + v.copies, 0), 'Objekt', 'Objekte')}
          </div>
          <ul className="divide-y divide-border rounded-xl border border-border">
            {selected.map((v) => {
              const m = byId.get(v.modelId)!;
              return (
                <li key={v.modelId} className="flex items-center gap-3 px-3 py-2">
                  <img src={m.thumbnailUrl} alt="" className="size-10 shrink-0 rounded-md bg-surface-2 object-contain" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{m.name}</div>
                    <div className="tabular text-xs text-text-3">{formatDims(m.dimensions)}</div>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button variant="secondary" className="size-8 min-h-8 px-0" onClick={() => setCopies(v.modelId, v.copies - 1)} aria-label="Weniger">
                      <Minus className="size-3.5" />
                    </Button>
                    <span className="tabular w-8 text-center text-sm font-semibold" aria-label="Stückzahl">
                      {v.copies}
                    </span>
                    <Button variant="secondary" className="size-8 min-h-8 px-0" onClick={() => setCopies(v.modelId, v.copies + 1)} aria-label="Mehr">
                      <Plus className="size-3.5" />
                    </Button>
                  </div>
                  <Button variant="ghost" className="size-8 min-h-8 px-0" onClick={() => toggle(v.modelId)} aria-label={`${m.name} entfernen`}>
                    <X className="size-4" />
                  </Button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {!libraryOpen && (
        <button type="button" onClick={() => setLibraryOpen(true)} className="text-sm text-accent hover:underline">
          Aus der Bibliothek wählen…
        </button>
      )}

      {libraryOpen &&
        (models.isLoading ? (
          <Spinner />
        ) : (
          <Library
            models={models.data ?? []}
            selected={new Set(value.map((v) => v.modelId))}
            onToggle={toggle}
            onDeleted={(id) => {
              qc.setQueryData<ModelInfo[]>(['models'], (old) => old?.filter((m) => m.id !== id));
              onChange(value.filter((v) => v.modelId !== id));
            }}
          />
        ))}
    </div>
  );
}

function UploadZone({ onUploaded }: { onUploaded: (models: ModelInfo[]) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const [progress, setProgress] = useState<{ name: string; value: number; index: number; total: number } | null>(null);

  const upload = async (files: File[]) => {
    const valid = files.filter((f) => MODEL_EXT.test(f.name));
    if (valid.length < files.length) toast('Nur STL-, 3MF- oder OBJ-Dateien werden übernommen', 'critical');
    const done: ModelInfo[] = [];
    for (const [index, file] of valid.entries()) {
      const form = new FormData();
      form.append('file', file, file.name);
      setProgress({ name: file.name, value: 0, index, total: valid.length });
      try {
        done.push(await uploadWithProgress<ModelInfo>('/models', form, (v) => setProgress({ name: file.name, value: v, index, total: valid.length })));
      } catch (err) {
        toast(`${file.name}: ${(err as Error).message}`, 'critical');
      }
    }
    setProgress(null);
    if (done.length) onUploaded(done);
  };

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e: DragEvent) => {
        e.preventDefault();
        setDrag(false);
        void upload([...e.dataTransfer.files]);
      }}
      className={clsx('flex flex-wrap items-center gap-3 rounded-xl border-2 border-dashed px-4 py-4', drag ? 'border-accent bg-accent/5' : 'border-border')}
    >
      <input
        ref={input}
        type="file"
        multiple
        accept=".stl,.3mf,.obj"
        className="hidden"
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = '';
          void upload(files);
        }}
      />
      {progress ? (
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="tabular flex justify-between gap-2 text-sm">
            <span className="truncate">
              {progress.total > 1 && `${progress.index + 1}/${progress.total} · `}
              {progress.name}
            </span>
            <span className="shrink-0 text-text-2">{progress.value < 1 ? `${Math.round(progress.value * 100)} %` : 'wird analysiert…'}</span>
          </div>
          <ProgressBar value={progress.value} />
        </div>
      ) : (
        <>
          <Button onClick={() => input.current?.click()}>
            <Upload className="size-4" /> Modelle hochladen
          </Button>
          <span className="text-sm text-text-3">STL, 3MF oder OBJ, mehrere auf einmal möglich</span>
        </>
      )}
    </div>
  );
}

function Library({
  models,
  selected,
  onToggle,
  onDeleted,
}: {
  models: ModelInfo[];
  selected: Set<number>;
  onToggle: (id: number) => void;
  onDeleted: (id: number) => void;
}) {
  const [filter, setFilter] = useState('');
  const { run } = useAction();
  if (!models.length) return <p className="text-sm text-text-3">Die Modell-Bibliothek ist noch leer.</p>;
  const shown = filter ? models.filter((m) => m.name.toLowerCase().includes(filter.toLowerCase())) : models;

  const remove = async (m: ModelInfo) => {
    if (await confirm({ title: 'Modell löschen?', body: `„${m.name}“ wird aus der Bibliothek entfernt.`, confirmLabel: 'Löschen', danger: true })) {
      if (await run('del', () => api(`/models/${m.id}`, { method: 'DELETE' }))) onDeleted(m.id);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm text-text-2">Bibliothek ({models.length}): antippen zum Auswählen</span>
        {models.length > 6 && <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Suchen…" className="max-w-48" />}
      </div>
      <div className="grid max-h-[24rem] grid-cols-2 gap-2 overflow-y-auto sm:grid-cols-4 lg:grid-cols-5">
        {shown.map((m) => {
          const on = selected.has(m.id);
          return (
            <div key={m.id} className={clsx('group relative rounded-xl border p-2 transition-colors', on ? 'border-accent bg-accent/5' : 'border-border hover:border-text-3')}>
              <button onClick={() => onToggle(m.id)} className="block w-full text-left" aria-pressed={on}>
                <img src={m.thumbnailUrl} alt="" loading="lazy" className="aspect-square w-full rounded-lg bg-surface-2 object-contain" />
                <div className="mt-1.5 truncate text-sm font-medium" title={m.name}>
                  {m.name}
                </div>
                <div className="tabular truncate text-xs text-text-3">
                  {formatDims(m.dimensions)} · {formatBytes(m.size)}
                </div>
              </button>
              {on && <Check className="pointer-events-none absolute right-3 top-3 size-5 rounded-full bg-accent p-0.5 text-accent-ink" />}
              <button
                onClick={() => remove(m)}
                className="absolute left-3 top-3 rounded-md bg-surface/90 p-1 text-text-3 opacity-0 transition-opacity hover:text-critical focus:opacity-100 group-hover:opacity-100"
                aria-label={`${m.name} löschen`}
              >
                <Trash2 className="size-4" />
              </button>
            </div>
          );
        })}
        {!shown.length && (
          <div className="col-span-full flex items-center gap-2 text-sm text-text-3">
            <Box className="size-4" /> Keine Treffer
          </div>
        )}
      </div>
    </div>
  );
}
