import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import clsx from 'clsx';
import { PrinterSettings } from './settings/PrinterSettings';
import { SecuritySettings } from './settings/SecuritySettings';
import { AppearanceSettings } from './settings/AppearanceSettings';

const TABS = [
  { to: 'printers', label: 'Drucker' },
  { to: 'security', label: 'Sicherheit' },
  { to: 'appearance', label: 'Darstellung' },
];

export function SettingsPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <h1 className="text-2xl font-semibold">Einstellungen</h1>
      <nav className="flex gap-1 overflow-x-auto overflow-y-hidden border-b border-border">
        {TABS.map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            className={({ isActive }) =>
              clsx(
                '-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium',
                isActive ? 'border-accent text-text' : 'border-transparent text-text-2 hover:text-text',
              )
            }
          >
            {t.label}
          </NavLink>
        ))}
      </nav>
      <Routes>
        <Route index element={<Navigate to="printers" replace />} />
        <Route path="printers" element={<PrinterSettings />} />
        <Route path="security" element={<SecuritySettings />} />
        <Route path="appearance" element={<AppearanceSettings />} />
      </Routes>
    </div>
  );
}
