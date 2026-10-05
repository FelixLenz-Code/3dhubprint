export function thumbUrl(printerId: number, path: string | undefined) {
  return path ? `/api/printers/${printerId}/files/thumbnail?path=${encodeURIComponent(path)}` : undefined;
}

export function formatBytes(n: number | undefined): string {
  if (n === undefined) return '–';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : 1).replace('.', ',')} ${units[i]}`;
}

export function formatDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}
