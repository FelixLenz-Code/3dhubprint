import { useEffect } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth, useRefreshAuth } from './lib/auth';
import { live } from './lib/live';
import { Layout } from './components/Layout';
import { Spinner } from './components/ui';
import { ConfirmHost, Toaster } from './lib/feedback';
import { LoginPage, SetupPage } from './pages/AuthPages';
import { DashboardPage } from './pages/Dashboard';
import { PrinterPage } from './pages/PrinterPage';
import { SettingsPage } from './pages/Settings';
import { JobsPage } from './pages/JobsPage';
import { NewJobPage } from './pages/NewJobPage';
import { ModelsPage } from './pages/ModelsPage';

export function App() {
  const { data, isLoading } = useAuth();
  const refreshAuth = useRefreshAuth();
  const authed = data?.state === 'authenticated';

  useEffect(() => {
    if (!authed) return;
    live.start();
    return () => live.stop();
  }, [authed]);

  useEffect(() => {
    const onEnded = () => void refreshAuth();
    window.addEventListener('printhub:session-ended', onEnded);
    return () => window.removeEventListener('printhub:session-ended', onEnded);
  }, [refreshAuth]);

  if (isLoading || !data) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (data.state === 'setup_required') return <SetupPage />;
  if (data.state === 'anonymous') return <LoginPage />;

  return (
    <>
    <Routes>
      <Route element={<Layout user={data.user} />}>
        <Route index element={<DashboardPage />} />
        <Route path="printers/:id" element={<PrinterPage />} />
        <Route path="jobs" element={<JobsPage />} />
        <Route path="jobs/new" element={<NewJobPage />} />
        <Route path="models" element={<ModelsPage />} />
        <Route path="settings/*" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
    <Toaster />
    <ConfirmHost />
    </>
  );
}
