import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import clsx from 'clsx';
import { PrinterSettings } from './settings/PrinterSettings';
import { SecuritySettings } from './settings/SecuritySettings';
import { AppearanceSettings } from './settings/AppearanceSettings';
import { SlicerSettings } from './settings/SlicerSettings';
import { NotificationSettings } from './settings/NotificationSettings';
import { IntegrationSettings } from './settings/IntegrationSettings';

// Absolute paths: inside the "settings/*" splat route, relative links would resolve
// against the current sub-page (e.g. /settings/printers/slicer).
const TABS = [
  { to: '/settings/printers', label: 'Drucker' },
  { to: '/settings/slicer', label: 'Slicer' },
  { to: '/settings/notifications', label: 'Benachrichtigungen' },
  { to: '/settings/integrations', label: 'Integrationen' },
  { to: '/settings/security', label: 'Sicherheit' },
  { to: '/settings/appearance', label: 'Darstellung' },
];

export function SettingsPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <h1 className="text-2xl font-semibold">Einstellungen</h1>
      <nav className="-mx-4 flex gap-1 overflow-x-auto overflow-y-hidden border-b border-border px-4 sm:mx-0 sm:px-0" aria-label="Einstellungen">
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
        <Route index element={<Navigate to="/settings/printers" replace />} />
        <Route path="printers" element={<PrinterSettings />} />
        <Route path="slicer" element={<SlicerSettings />} />
        <Route path="notifications" element={<NotificationSettings />} />
        <Route path="integrations" element={<IntegrationSettings />} />
        <Route path="security" element={<SecuritySettings />} />
        <Route path="appearance" element={<AppearanceSettings />} />
      </Routes>
    </div>
  );
}
