import { useState } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import clsx from 'clsx';
import { Card } from '../../components/ui';
import { getThemePref, setThemePref, type ThemePref } from '../../lib/theme';

const OPTIONS: { value: ThemePref; label: string; icon: typeof Sun }[] = [
  { value: 'system', label: 'System', icon: Monitor },
  { value: 'light', label: 'Hell', icon: Sun },
  { value: 'dark', label: 'Dunkel', icon: Moon },
];

export function AppearanceSettings() {
  const [pref, setPref] = useState(getThemePref);
  return (
    <div className="space-y-6">
    <Card className="p-5">
      <h2 className="mb-1 font-semibold">Farbschema</h2>
      <p className="mb-4 text-sm text-text-2">Wird nur auf diesem Gerät gespeichert.</p>
      <div className="grid grid-cols-3 gap-2">
        {OPTIONS.map(({ value, label, icon: Icon }) => (
          <button
            key={value}
            onClick={() => {
              setPref(value);
              setThemePref(value);
            }}
            className={clsx(
              'flex flex-col items-center gap-2 rounded-xl border px-3 py-4 text-sm',
              pref === value ? 'border-accent bg-accent/10 text-text' : 'border-border text-text-2 hover:border-text-3',
            )}
          >
            <Icon className="size-5" />
            {label}
          </button>
        ))}
      </div>
    </Card>
    <Card className="p-5 text-sm text-text-2">
      <h2 className="mb-1 font-semibold text-text">Über PrintHub</h2>
      Freie Software unter der{' '}
      <a href="https://www.gnu.org/licenses/agpl-3.0.html" target="_blank" rel="noreferrer" className="text-accent hover:underline">
        GNU AGPL v3
      </a>
      . Quellcode:{' '}
      <a href="https://github.com/FelixLenz-Code/3dhubprint" target="_blank" rel="noreferrer" className="text-accent hover:underline">
        github.com/FelixLenz-Code/3dhubprint
      </a>
    </Card>
    </div>
  );
}
