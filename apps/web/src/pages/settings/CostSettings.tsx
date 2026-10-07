import { useEffect, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { estimateCost, type CostSettings } from '@printhub/shared';
import { api } from '../../lib/api';
import { useAction } from '../../lib/feedback';
import { useLive } from '../../lib/live';
import { formatMoney, useCostSettings } from '../../lib/stats';
import { Button, Card, Field, Input } from '../../components/ui';

type Draft = { electricityPrice: string; filamentPrice: string; defaultPowerW: string; printers: Record<string, { powerW: string; hourlyCost: string }> };

const str = (n: number | null | undefined) => (n === null || n === undefined ? '' : String(n).replace('.', ','));
const parse = (s: string) => (s.trim() === '' ? null : Number(s.replace(',', '.')));

export function CostSettingsPage() {
  const qc = useQueryClient();
  const printers = useLive((s) => s.printers);
  const settings = useCostSettings();
  const [draft, setDraft] = useState<Draft>();
  const { busy, run } = useAction();

  useEffect(() => {
    if (!settings.data || settings.isPlaceholderData || draft) return;
    const s = settings.data;
    setDraft({
      electricityPrice: str(s.electricityPrice),
      filamentPrice: str(s.filamentPrice),
      defaultPowerW: str(s.defaultPowerW),
      printers: Object.fromEntries(Object.entries(s.printers).map(([id, p]) => [id, { powerW: str(p.powerW), hourlyCost: str(p.hourlyCost) }])),
    });
  }, [settings.data, settings.isPlaceholderData, draft]);

  if (!draft) return null;

  const result = toSettings(draft);
  const valid = result !== null;
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const setPrinter = (id: number, patch: Partial<Draft['printers'][string]>) =>
    set({ printers: { ...draft.printers, [id]: { powerW: '', hourlyCost: '', ...draft.printers[id], ...patch } } });

  const save = (e: FormEvent) => {
    e.preventDefault();
    if (!result) return;
    void run(
      'save',
      async () => {
        qc.setQueryData(['costs'], await api<CostSettings>('/costs', { method: 'PUT', body: result }));
        await qc.invalidateQueries({ queryKey: ['stats'] });
        await qc.invalidateQueries({ queryKey: ['prints'] });
      },
      'Gespeichert',
    );
  };

  // Example: 100 g and 5 hours on the default printer.
  const example = result && estimateCost({ grams: 100, pricePerKg: null, seconds: 5 * 3600, printerId: null }, result);

  return (
    <form onSubmit={save} className="space-y-4">
      <Card className="space-y-4 p-5">
        <div>
          <h2 className="font-semibold">Kosten pro Druck</h2>
          <p className="text-sm text-text-2">
            Material (Gewicht × Preis) + Strom (Leistung × Dauer × Strompreis) + optional Verschleiß pro Druckstunde. Der Filamentpreis kommt aus der Spoolman-Spule,
            sonst aus dem Filamentprofil (OrcaSlicer: Filament → Kosten), sonst aus dem Standardpreis unten.
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Strompreis (€/kWh)" hint="Laut Stromrechnung">
            <Input inputMode="decimal" value={draft.electricityPrice} onChange={(e) => set({ electricityPrice: e.target.value })} />
          </Field>
          <Field label="Filamentpreis (€/kg)" hint="Standard, wenn Spule und Profil keinen Preis haben">
            <Input inputMode="decimal" value={draft.filamentPrice} onChange={(e) => set({ filamentPrice: e.target.value })} />
          </Field>
          <Field label="Leistung (W)" hint="Ø beim Drucken inkl. Heizbett, meist 100–150 W">
            <Input inputMode="decimal" value={draft.defaultPowerW} onChange={(e) => set({ defaultPowerW: e.target.value })} />
          </Field>
        </div>
        {example && <p className="text-xs text-text-3">Beispiel: 100 g, 5 Stunden → {formatMoney(example.total)} (Material {formatMoney(example.material)}, Strom {formatMoney(example.energy)})</p>}
      </Card>

      {printers.length > 0 && (
        <Card className="space-y-3 p-5">
          <div>
            <h2 className="font-semibold">Pro Drucker</h2>
            <p className="text-sm text-text-2">Leer lassen, um die Standardleistung zu verwenden. Verschleiß deckt z. B. Düsen, Riemen und Abschreibung ab.</p>
          </div>
          <div className="divide-y divide-border">
            {printers.map((p) => (
              <div key={p.id} className="grid items-end gap-3 py-3 sm:grid-cols-[1fr_10rem_10rem]">
                <div className="font-medium sm:pb-2.5">{p.name}</div>
                <Field label="Leistung (W)">
                  <Input inputMode="decimal" placeholder={draft.defaultPowerW} value={draft.printers[p.id]?.powerW ?? ''} onChange={(e) => setPrinter(p.id, { powerW: e.target.value })} />
                </Field>
                <Field label="Verschleiß (€/h)">
                  <Input inputMode="decimal" placeholder="0" value={draft.printers[p.id]?.hourlyCost ?? ''} onChange={(e) => setPrinter(p.id, { hourlyCost: e.target.value })} />
                </Field>
              </div>
            ))}
          </div>
        </Card>
      )}

      <div className="flex items-center justify-end gap-3">
        {!valid && <span className="text-sm text-critical">Bitte gültige, nicht negative Zahlen eingeben.</span>}
        <Button type="submit" disabled={!valid} loading={busy === 'save'}>
          Speichern
        </Button>
      </div>
    </form>
  );
}

function toSettings(d: Draft): CostSettings | null {
  const ok = (n: number | null): n is number => n !== null && Number.isFinite(n) && n >= 0;
  const electricityPrice = parse(d.electricityPrice);
  const filamentPrice = parse(d.filamentPrice);
  const defaultPowerW = parse(d.defaultPowerW);
  if (!ok(electricityPrice) || !ok(filamentPrice) || !ok(defaultPowerW)) return null;
  const printers: CostSettings['printers'] = {};
  for (const [id, p] of Object.entries(d.printers)) {
    const powerW = parse(p.powerW);
    const hourlyCost = parse(p.hourlyCost) ?? 0;
    if ((powerW !== null && !ok(powerW)) || !ok(hourlyCost)) return null;
    if (powerW !== null || hourlyCost > 0) printers[id] = { powerW, hourlyCost };
  }
  return { electricityPrice, filamentPrice, defaultPowerW, printers };
}
