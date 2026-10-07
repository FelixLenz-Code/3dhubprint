import { useQuery } from '@tanstack/react-query';
import { DEFAULT_COST_SETTINGS, type CostSettings, type PrinterSpool, type SpoolmanStatus } from '@printhub/shared';
import { api } from './api';

export const formatMoney = (v: number | undefined | null) =>
  v === undefined || v === null || !Number.isFinite(v) ? '–' : v.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });

export function formatWeight(g: number | undefined | null): string {
  if (g === undefined || g === null || !Number.isFinite(g)) return '–';
  if (g >= 1000) return `${(g / 1000).toLocaleString('de-DE', { maximumFractionDigits: 2 })} kg`;
  return `${g.toLocaleString('de-DE', { maximumFractionDigits: g < 10 ? 1 : 0 })} g`;
}

/** Hours for totals ("312 h"), finer below a day. */
export function formatHours(seconds: number): string {
  const h = seconds / 3600;
  if (h >= 24) return `${Math.round(h).toLocaleString('de-DE')} h`;
  if (h >= 1) return `${h.toLocaleString('de-DE', { maximumFractionDigits: 1 })} h`;
  return `${Math.round(seconds / 60)} min`;
}

export const useCostSettings = () =>
  useQuery({ queryKey: ['costs'], queryFn: () => api<CostSettings>('/costs'), staleTime: 60_000, placeholderData: DEFAULT_COST_SETTINGS });

export const useSpoolmanStatus = () =>
  useQuery({ queryKey: ['spoolman-status'], queryFn: () => api<SpoolmanStatus>('/spoolman/status'), staleTime: 60_000 });

export const usePrinterSpool = (printerId: number, enabled = true) =>
  useQuery({
    queryKey: ['printer-spool', printerId],
    queryFn: () => api<PrinterSpool>(`/printers/${printerId}/spool`),
    enabled,
    refetchInterval: 60_000,
  });
